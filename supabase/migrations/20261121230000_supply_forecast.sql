-- Agent d'achats et fiche de courses : des achats calés sur les PRÉVISIONS, sans surstocker le frais (anti-gaspillage)
--
-- Avant : besoins = portions saisies dans le menu (30 par plat par défaut) sur 3 jours, et on remontait le stock à
-- 2 × le seuil d'alerte pour tout, y compris le poisson ou les légumes qui se perdent en 1-2 jours.
-- Maintenant :
--  1. Portions = celles du guide de production : validées par le chef, sinon la prévision (fréquentation des mêmes
--     jours, tickets déjà vendus, invités, popularité du plat, reprises apprises avec les restes saisis, marge 5-10 %),
--     moins ce qui est déjà servi ; portions réduites si le plat est souvent laissé dans l'assiette (photos d'assiettes).
--     Sans historique pour ce service, on garde la quantité prévue au menu (30 si rien n'est saisi).
--  2. Durée de conservation par ingrédient (ingredients.shelf_life_days, vide = produit sec) : pour le frais, on n'achète
--     que pour les repas avant qu'il s'abîme, sans réserve en plus ; le sec garde le seuil d'alerte comme réserve.
--  3. admin_forecast devient une enveloppe (contrôle du rôle) de _forecast_core, que l'agent (tâche planifiée, sans
--     utilisateur) peut appeler. Toute évolution du calcul des prévisions se fait désormais dans _forecast_core.

-- 1. Durée de conservation (jours) ; valeurs de départ selon le nom, modifiables par la cuisine
alter table public.ingredients add column if not exists shelf_life_days int check (shelf_life_days between 1 and 60);
update public.ingredients set shelf_life_days = v.d from (values
  ('(poisson|thon|carpe|viande|b(œ|oe)uf|mouton|poulet|crevette)', 2), ('^pain', 1),
  ('(crudit|salade|tomate|feuille|kplala|gombo|aubergine|piment|persil|laitue)', 3),
  ('(banane|plantain|atti(é|e)k(é|e)|manioc|placali|igname|avocat|mangue|ananas|orange|past(è|e)que|papaye)', 4),
  ('(lait|yaourt|fromage|beurre|cr(è|e)me)', 5), ('((œ|oe)ufs?)', 14)
) v(pat, d) where public.ingredients.shelf_life_days is null and lower(public.ingredients.name) ~ v.pat;

create or replace function public.ingredient_set_shelf_life(p_ingredient uuid, p_days int) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not public.has_role('chef') then return public._fail('FORBIDDEN', 'Réservé à la cuisine.'); end if;
  if p_days is not null and p_days not between 1 and 60 then return public._fail('INVALID', 'Entre 1 et 60 jours (vide = produit sec).'); end if;
  update public.ingredients set shelf_life_days = p_days where id = p_ingredient;
  if not found then return public._fail('NOT_FOUND', 'Ingrédient introuvable.'); end if;
  return jsonb_build_object('ok', true);
end $$;
grant select (shelf_life_days) on public.ingredients to authenticated;

-- 2. Prévisions : le calcul (sans contrôle de rôle) et l'écran du chef (avec contrôle)
create or replace function public._forecast_core(p_date date) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare r jsonb;
begin
  with svc as (
    select s.svc, s.o, w.starts_at, w.ends_at,
      (select avg(c)::numeric from (
          select (select count(*) from tickets t where t.service_date = h and t.service = s.svc and t.status = 'used'
                     and t.user_id <> public._guest_profile()) c
            from unnest(array[p_date - 7, p_date - 14, p_date - 21, p_date - 28]) h
           where public._service_on_menu(h, s.svc)) z) hist,
      (select count(*) from tickets t where t.service = s.svc and t.status = 'valid' and t.user_id <> public._guest_profile()
          and t.valid_until > w.starts_at and t.valid_from < w.ends_at) outstanding,
      (select count(*) from tickets t where t.service = s.svc and t.user_id = public._guest_profile()
          and t.service_date = p_date and t.status in ('valid', 'used')) guests
      from unnest(enum_range(null::public.service_kind)) with ordinality s(svc, o)
      cross join lateral public.service_window(p_date, s.svc) w
     where exists (select 1 from menu_items mi join menus m on m.id = mi.menu_id
                    where mi.service_date = p_date and mi.service = s.svc)
  ), svc2 as (
    select *, (greatest(round(coalesce(hist, 0)), outstanding) + guests)::int expected_total,
           case when hist is not null then 'history' else 'tickets' end basis from svc
  ), items as (
    select mi.id, mi.service, mi.dish_id, d.name, mi.planned_qty, mi.prepared_qty, mi.served_qty,
           p.popularity, p.observed, p.days, p.stars, p.prior, w.left_pct, w.scans
      from menu_items mi join menus m on m.id = mi.menu_id join dishes d on d.id = mi.dish_id
      join public._dish_popularity(p_date) p on p.dish_id = mi.dish_id
      left join lateral public._dish_left(mi.dish_id, p_date) w on true
     where mi.service_date = p_date
  ), shares as (
    select i.*, s.expected_total, s.basis,
           i.popularity / sum(i.popularity) over (partition by i.service) share
      from items i join svc2 s on s.svc = i.service
  ), rec as (
    select *, round(expected_total * share)::int expected, ceil(expected_total * share * 1.05)::int recommended from shares
  ), needs as (
    select ing.id, ing.name, ing.unit, ing.stock_qty, ing.alert_threshold, ing.unit_cost,
           -- un plat souvent laissé dans l'assiette : portions plus petites (moitié du % laissé, au plus −25 %)
           round(sum(rl.qty_per_portion * rec.recommended * (1 - least(coalesce(rec.left_pct, 0), 50) / 200.0)), 2) need
      from rec join recipe_lines rl on rl.dish_id = rec.dish_id join ingredients ing on ing.id = rl.ingredient_id
     group by ing.id
  )
  select jsonb_build_object(
    'date', p_date,
    'services', (select coalesce(jsonb_agg(jsonb_build_object('service', svc, 'label', public.service_label(svc),
                   'history', round(hist), 'outstanding', outstanding, 'guests', guests, 'expected', expected_total, 'basis', basis,
                   'guest_events', (select coalesce(jsonb_agg(jsonb_build_object('name', e.name, 'guests', e.guests, 'dishes', e.dishes) order by e.created_at), '[]')
                                      from public.guest_events e where e.service_date = p_date and e.service = svc2.svc and e.cancelled_at is null))
                   order by o), '[]') from svc2),
    'items', (select coalesce(jsonb_agg(jsonb_build_object(
                'id', id, 'service', service, 'dish', name, 'planned', planned_qty, 'prepared', prepared_qty,
                'served', served_qty, 'share', round(share * 100), 'expected', expected, 'recommended', recommended,
                'popularity', round(popularity, 2), 'observed', round(observed, 2), 'days', days, 'stars', stars, 'prior', prior,
                'left_pct', left_pct, 'left_scans', scans, 'portion_cut', round(least(coalesce(left_pct, 0), 50) / 2.0),
                'basis', case when days >= 5 then 'dish' else 'prior' end)
                order by service, recommended desc), '[]') from rec),
    -- Conseil au chef : plats souvent laissés dans l'assiette (30 derniers jours)
    'waste_advice', (select coalesce(jsonb_agg('« ' || name || ' » : ' || left_pct || ' % laissé dans l''assiette en moyenne ('
                       || scans || ' assiettes analysées) → portions réduites de ' || round(least(left_pct, 50) / 2.0) || ' % dans les besoins en ingrédients'
                       || case when left_pct >= 40 then ' ; revoir la recette ou la taille de la portion.' else '.' end
                       order by left_pct desc), '[]') from rec where left_pct >= 25),
    'ingredients', (select coalesce(jsonb_agg(jsonb_build_object(
                'id', id, 'name', name, 'unit', unit, 'stock', stock_qty, 'need', need,
                'to_buy', greatest(round(need - stock_qty + alert_threshold, 2), 0),
                'cost', ceil(greatest(need - stock_qty + alert_threshold, 0) * unit_cost)) order by name), '[]') from needs)
  ) into r;
  return r;
end $$;

create or replace function public.admin_forecast(p_date date) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not public.has_role('chef') then raise exception 'forbidden' using errcode = '42501'; end if;
  return public._forecast_core(p_date);
end $$;

-- 3. Portions à préparer pour un jour (même règle que le guide de production), et ce qui reste à servir
create or replace function public._menu_portions(p_date date)
returns table (menu_item_id uuid, dish_id uuid, service public.service_kind, portions int, remaining int, cut numeric)
language sql stable security definer set search_path = public, pg_temp as $$
  with f as (select public._forecast_core(p_date) j),
  fi as (
    select (x ->> 'id')::uuid id, (x ->> 'expected')::int expected, (x ->> 'days')::int days,
           least(coalesce((x ->> 'left_pct')::numeric, 0), 50) / 200.0 cut
      from f, jsonb_array_elements(f.j -> 'items') x
  ), sv as (
    select (s ->> 'service')::public.service_kind svc, s ->> 'basis' basis from f, jsonb_array_elements(f.j -> 'services') s
  )
  select mi.id, mi.dish_id, mi.service, q.portions, greatest(q.portions - coalesce(mi.served_qty, 0), 0), fi.cut
    from menu_items mi join menus m on m.id = mi.menu_id
    join fi on fi.id = mi.id
    left join sv on sv.svc = mi.service
    join public._dish_seconds(p_date) s on s.dish_id = mi.dish_id
    cross join lateral (select greatest(5, ceil(fi.expected * (1 + s.rate) * (1 + case when fi.days >= 5 then 0.05 else 0.10 end) / 5.0) * 5)::int proposed) pr
    cross join lateral (select case
        when mi.production_validated_at is not null then coalesce(mi.planned_qty, pr.proposed)   -- validé par le chef
        when sv.basis = 'history' then pr.proposed                                              -- prévision sur l'historique
        else greatest(pr.proposed, coalesce(mi.planned_qty, 30)) end portions) q                -- pas d'historique : le menu
   where mi.service_date = p_date and m.status in ('published', 'submitted') and not mi.is_sold_out
     and (select w.ends_at from public.service_window(mi.service_date, mi.service) w) > now()
$$;

-- Besoins en ingrédients jour par jour sur un horizon (portions restantes × recette, portions réduites si souvent laissées)
create or replace function public._ingredient_needs(p_days int)
returns table (ingredient_id uuid, service_date date, need numeric)
language sql stable security definer set search_path = public, pg_temp as $$
  select rl.ingredient_id, d::date, round(sum(rl.qty_per_portion * p.remaining * (1 - p.cut)), 3)
    from generate_series(public.today_abidjan(), public.today_abidjan() + greatest(1, least(p_days, 7)) - 1, interval '1 day') d
    cross join lateral public._menu_portions(d::date) p
    join recipe_lines rl on rl.dish_id = p.dish_id
   group by rl.ingredient_id, d::date
$$;

-- 4. Agent d'achats : besoins = prévisions ; frais seulement jusqu'à sa date limite, sans réserve
create or replace function public._supply_needs()
returns table (ingredient_id uuid, name text, unit text, stock numeric, threshold numeric, need numeric, open_qty numeric, to_order numeric)
language sql stable security definer set search_path = public, pg_temp as $$
  with cfg as (select greatest(1, least(7, coalesce((public.setting('supply_agent') ->> 'horizon_days')::int, 3))) h),
  upcoming as (
    select n.ingredient_id, sum(n.need) need
      from cfg, public._ingredient_needs(cfg.h) n join ingredients i on i.id = n.ingredient_id
     where i.shelf_life_days is null or n.service_date < public.today_abidjan() + i.shelf_life_days
     group by n.ingredient_id
  ), ordered as (   -- commandes fournisseurs pas encore reçues
    select (i ->> 'ingredient_id')::uuid ingredient_id, sum((i ->> 'stock_qty')::numeric) qty
      from supplier_orders o cross join jsonb_array_elements(o.items) i
     where o.status not in ('refuse', 'annule', 'reporte', 'recu') and nullif(i ->> 'ingredient_id', '') is not null
       and not exists (select 1 from delivery_runs r where r.id = o.run_id and r.status = 'receptionne')
     group by 1
  ), shopping as (  -- courses en cours par un employé
    select si.ingredient_id, sum(case when si.status = 'bought' then coalesce(si.bought_qty, si.qty) else si.qty end) qty
      from shopping_items si join shopping_lists sl on sl.id = si.list_id
     where sl.status in ('assigned', 'shopping') and si.status <> 'missing' and si.ingredient_id is not null
     group by si.ingredient_id
  ), calc as (
    select i.id, i.name, i.unit, i.stock_qty, i.alert_threshold, i.shelf_life_days, coalesce(u.need, 0) need,
           coalesce(o.qty, 0) + coalesce(s.qty, 0) open_qty
      from ingredients i left join upcoming u on u.ingredient_id = i.id left join ordered o on o.ingredient_id = i.id
      left join shopping s on s.ingredient_id = i.id
  )
  select id, name, unit, stock_qty, alert_threshold, round(need, 2), open_qty,
         case
           -- frais : uniquement ce qui manque pour les repas d'ici sa date limite
           when shelf_life_days is not null then greatest(round(need - stock_qty - open_qty, 2), 0)
           -- sec : on commande quand le stock prévu passe sous le seuil, de quoi revenir à 2 × le seuil
           when stock_qty + open_qty - need < alert_threshold then round(need + 2 * alert_threshold - stock_qty - open_qty, 2)
           else 0 end
    from calc
$$;

-- 5. Fiche de courses d'un employé : même base (prévisions, frais sans réserve)
create or replace function public._shopping_needs(p_ingredient uuid default null)
returns table (ingredient_id uuid, name text, unit text, stock numeric, threshold numeric, need numeric, in_transit numeric, to_buy numeric, est_cost int)
language sql stable security definer set search_path = public, pg_temp as $$
  with upcoming as (   -- besoins des 3 prochains jours, d'après les prévisions ; le frais seulement jusqu'à sa date limite
    select n.ingredient_id, sum(n.need) need
      from public._ingredient_needs(3) n join ingredients i on i.id = n.ingredient_id
     where (p_ingredient is null or n.ingredient_id = p_ingredient)
       and (i.shelf_life_days is null or n.service_date < public.today_abidjan() + i.shelf_life_days)
     group by n.ingredient_id
  ), transit as (
    select x.ingredient_id, sum(x.qty) qty from (
      select si.ingredient_id, case when si.status = 'bought' then coalesce(si.bought_qty, si.qty) else si.qty end qty
        from shopping_items si join shopping_lists sl on sl.id = si.list_id
       where sl.status in ('assigned', 'shopping') and si.status <> 'missing' and si.ingredient_id is not null
      union all
      select (i ->> 'ingredient_id')::uuid, (i ->> 'stock_qty')::numeric
        from supplier_orders o cross join jsonb_array_elements(o.items) i
       where o.status not in ('refuse', 'annule', 'reporte', 'recu', 'a_approuver') and nullif(i ->> 'ingredient_id', '') is not null
         and not exists (select 1 from delivery_runs r where r.id = o.run_id and r.status = 'receptionne')
    ) x group by x.ingredient_id
  ), calc as (
    select i.id, i.name, i.unit, i.stock_qty, i.alert_threshold, i.unit_cost, i.shelf_life_days shelf,
           coalesce(u.need, 0) need, coalesce(t.qty, 0) in_transit,
           coalesce(u.need, 0) + case when i.shelf_life_days is null then i.alert_threshold else 0 end - i.stock_qty - coalesce(t.qty, 0) raw
      from ingredients i left join upcoming u on u.ingredient_id = i.id left join transit t on t.ingredient_id = i.id
     where p_ingredient is null or i.id = p_ingredient
  ), rounded as (
    select *, case when raw <= 0 then 0
                   when in_transit > 0 and raw < alert_threshold / 4 then 0
                   when in_transit > 0 then raw
                   when shelf is not null then raw                      -- produit frais : juste le besoin
                   else greatest(raw, alert_threshold) end m
      from calc
  ), rounded2 as (
    select *, case when m <= 0 then 0
                   when unit in ('pièce', 'pièces', 'botte', 'sachet', 'paquet') then ceil(m)
                   else ceil(m * 2) / 2 end q
      from rounded
  )
  select id, name, unit, stock_qty, alert_threshold, round(need, 2), in_transit, q, ceil(q * unit_cost)::int from rounded2
$$;

revoke all on function public._forecast_core(date), public._menu_portions(date), public._ingredient_needs(int),
  public._supply_needs(), public._shopping_needs(uuid) from public, anon, authenticated;
grant execute on function public._forecast_core(date), public._menu_portions(date), public._ingredient_needs(int),
  public._supply_needs(), public._shopping_needs(uuid) to service_role;
revoke all on function public.ingredient_set_shelf_life(uuid, int) from public, anon;
grant execute on function public.ingredient_set_shelf_life(uuid, int) to authenticated;
