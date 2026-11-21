-- Agent d'achats autonome (§20 bis) : il surveille le stock et les menus à venir, décide quoi commander et chez qui,
-- fait appeler les fournisseurs par l'agent vocal, relance, passe au fournisseur de secours, envoie le coursier,
-- et attend l'accord de l'équipe au-dessus d'un montant. Les décisions sont dans le code, pas dans l'IA :
-- Claude ne sert qu'à parler avec l'équipe (groupe WhatsApp, page « Agent d'achats ») et l'agent vocal à parler au fournisseur.

-- ───────── 0. Réglages ─────────
insert into public.settings (key, value) values ('supply_agent', jsonb_build_object(
  'enabled', false,            -- l'agent travaille tout seul (pg_cron toutes les 30 s)
  'mode', 'simulation',        -- simulation (appels joués) | reel (appels Retell)
  'demo_phone', null,          -- en démo : tous les appels vont vers ce numéro (le présentateur joue le fournisseur)
  'horizon_days', 3,           -- menus pris en compte (aujourd'hui + 2 jours)
  'auto_limit', 100000,        -- au-dessus : accord de l'équipe AVANT d'appeler
  'daily_budget', 400000,      -- engagé par jour au-delà duquel l'agent demande l'accord
  'retry_minutes', 15,         -- délai entre deux essais quand le fournisseur ne répond pas (1 min en simulation)
  'hours_from', '07:00', 'hours_to', '18:00',  -- heures où l'agent appelle (mode réel)
  'sim_scenario', 'varie'))    -- ok | cher | coursier | injoignable | manque | refuse | varie (un scénario différent à chaque commande)
on conflict (key) do nothing;

create or replace function public._setting_is_private(p_key text) returns boolean
language sql immutable set search_path = public, pg_temp as $$
  select p_key in ('jean', 'supplier_calls', 'delivery', 'push_function_url', 'supply_agent')
$$;

-- Texte sans accents ni majuscules (« Koné » = « kone »)
create or replace function public._plain(p text) returns text language sql immutable set search_path = public, pg_temp as $$
  select translate(lower(coalesce(p, '')), 'éèêëàâäîïôöûüùçœ', 'eeeeaaaiioouuuco')
$$;

-- ───────── 1. Carnet : heures d'appel, fournisseurs de secours ─────────
alter table public.suppliers add column if not exists call_from time not null default '07:00',
                             add column if not exists call_to   time not null default '18:00';
-- 0 = fournisseur habituel ; 1, 2… = secours dans l'ordre
alter table public.supplier_products add column if not exists backup_rank int not null default 0 check (backup_rank between 0 and 9);

insert into public.suppliers (name, kind, district, address, phone, lat, lng) values
  ('Grossiste Diallo', 'grossiste', 'Yopougon', 'Marché de Siporex, Yopougon', '+2250700000106', 5.3380, -4.0710),
  ('Supermarché Riviera', 'supermarche', 'Riviera', 'Riviera 2, Cocody', '+2250700000105', 5.3610, -3.9580)
on conflict (name) do nothing;
update public.suppliers set call_from = '06:00', call_to = '13:00' where name in ('Marché de Cocody', 'Poissonnerie Port-Bouët');

insert into public.supplier_products (supplier_id, ingredient_id, label, unit, stock_per_unit, usual_price, default_qty, is_preferred, backup_rank)
select s.id, i.id, v.label, v.unit, v.per, v.price, v.qty, false, v.rnk
  from (values
    ('Grossiste Diallo', 'Riz', 'sacs de riz de 25 kg', 'sac', 25, 19200, 2, 1),
    ('Grossiste Diallo', 'Huile', 'bidons d''huile de 20 L', 'bidon', 20, 22300, 1, 1),
    ('Grossiste Diallo', 'Sucre', 'sacs de sucre de 50 kg', 'sac', 50, 33500, 1, 1),
    ('Grossiste Diallo', 'Farine', 'sacs de farine de 50 kg', 'sac', 50, 25000, 1, 1),
    ('Grossiste Diallo', 'Spaghetti', 'cartons de spaghetti (10 kg)', 'carton', 10, 9900, 1, 1),
    ('Grossiste Diallo', 'Pâte d''arachide', 'seaux de pâte d''arachide (5 kg)', 'seau', 5, 7900, 1, 1),
    ('Grossiste Diallo', 'Banane plantain', 'kg de banane plantain', 'kg', 1, 550, 15, 1),
    ('Grossiste Diallo', 'Attiéké', 'kg d''attiéké', 'kg', 1, 450, 20, 1),
    ('Supermarché Riviera', 'Riz', 'sacs de riz de 25 kg', 'sac', 25, 20000, 2, 2),
    ('Supermarché Riviera', 'Huile', 'bidons d''huile de 20 L', 'bidon', 20, 23500, 1, 2),
    ('Supermarché Riviera', 'Spaghetti', 'cartons de spaghetti (10 kg)', 'carton', 10, 10500, 1, 2),
    ('Supermarché Riviera', 'Poulet', 'poulets entiers (≈ 1,5 kg)', 'poulet', 1.5, 3100, 20, 1),
    ('Supermarché Riviera', 'Lait', 'cartons de lait (12 L)', 'carton', 12, 11500, 1, 1),
    ('Supermarché Riviera', 'Œufs', 'plateaux de 30 œufs', 'plateau', 30, 3000, 3, 1),
    ('Supermarché Riviera', 'Tomate', 'kg de tomates', 'kg', 1, 600, 25, 1),
    ('Supermarché Riviera', 'Oignon', 'kg d''oignons', 'kg', 1, 900, 5, 1),
    ('Supermarché Riviera', 'Pomme de terre', 'kg de pommes de terre', 'kg', 1, 800, 20, 1),
    ('Supermarché Riviera', 'Poisson (carpe)', 'kg de carpe', 'kg', 1, 2900, 15, 1),
    ('Supermarché Riviera', 'Thon', 'kg de thon', 'kg', 1, 3400, 5, 1)
  ) v(supplier, ingredient, label, unit, per, price, qty, rnk)
  join public.suppliers s on s.name = v.supplier
  left join public.ingredients i on i.name = v.ingredient
on conflict (supplier_id, label) do nothing;

-- Relie les produits du carnet aux ingrédients (sur une installation neuve, les ingrédients arrivent avec les données de démo)
create or replace function public._supply_link_products() returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare n int;
begin
  update supplier_products p set ingredient_id = i.id
    from (values ('poulet', 'Poulet'), ('riz', 'Riz'), ('huile', 'Huile'), ('sucre', 'Sucre'), ('farine', 'Farine'), ('spaghetti', 'Spaghetti'),
                 ('arachide', 'Pâte d''arachide'), ('lait', 'Lait'), ('tomate', 'Tomate'), ('banane', 'Banane plantain'), ('oignon', 'Oignon'),
                 ('crudite', 'Crudités'), ('attieke', 'Attiéké'), ('placali', 'Manioc (placali)'), ('graine de palme', 'Graine de palme'),
                 ('kplala', 'Feuilles kplala'), ('pommes de terre', 'Pomme de terre'), ('oeufs', 'Œufs'), ('ufs', 'Œufs'), ('carpe', 'Poisson (carpe)'), ('thon', 'Thon')
         ) m(pat, ing)
    join ingredients i on i.name = m.ing
   where p.ingredient_id is null and public._plain(p.label) like '%' || m.pat || '%';
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public._supply_link_products() from public, anon, authenticated;
grant execute on function public._supply_link_products() to service_role;
select public._supply_link_products();

-- ───────── 2. Commandes : suivi par l'agent ─────────
alter table public.supplier_orders
  add column if not exists auto           boolean not null default false,  -- pilotée par l'agent (relances, secours, coursier)
  add column if not exists origin         text not null default 'chef',    -- chef | stock | agent | secours | equipe
  add column if not exists parent_id      uuid references public.supplier_orders (id),
  add column if not exists reason         text,                            -- pourquoi l'agent commande
  add column if not exists next_call_at   timestamptz,                     -- prochain appel prévu (relance, rappel)
  add column if not exists dispatches     int not null default 0,          -- appels demandés sans changement de statut
  add column if not exists sim_scenario   text,
  add column if not exists dropped        jsonb not null default '[]',     -- articles retirés (manquants chez ce fournisseur)
  add column if not exists cancelled_by   text,                            -- annulée par l'équipe (pas de secours)
  add column if not exists approved_by    text,
  add column if not exists received_at    timestamptz,
  add column if not exists received_total int;
alter table public.supplier_orders drop constraint if exists supplier_orders_status_check;
alter table public.supplier_orders add constraint supplier_orders_status_check check (status in ('a_approuver', 'a_appeler', 'appel_en_cours',
  'commande', 'a_valider', 'valide', 'injoignable', 'rappeler', 'coursier', 'refuse', 'annule', 'reporte', 'recu'));
create index if not exists supplier_orders_auto on public.supplier_orders (status, next_call_at) where auto;

-- ───────── 3. Petits outils ─────────
-- « Boucherie Bamba » → « Bamba » : le mot à répondre dans le groupe (« OUI Bamba »)
create or replace function public._supplier_short(p text) returns text language sql immutable set search_path = public, pg_temp as $$
  select regexp_replace(trim(coalesce(p, '')), '^.*\s', '')
$$;

create or replace function public._supply_retry_delay() returns interval language sql stable set search_path = public, pg_temp as $$
  select case when public.setting('supply_agent') ->> 'mode' = 'reel'
              then make_interval(mins => coalesce((public.setting('supply_agent') ->> 'retry_minutes')::int, 15))
              else interval '1 minute' end
$$;

-- « 15h30 », « demain 9h », « dans 2 heures », « dans 20 min » → heure du rappel (sinon dans 30 min)
create or replace function public._supply_callback_at(p text) returns timestamptz
language plpgsql stable set search_path = public, pg_temp as $$
declare t text := public._plain(p); m text[]; v timestamptz;
begin
  m := regexp_match(t, 'dans\s+(\d{1,3})\s*(min|mn)');
  if m is not null then return now() + make_interval(mins => m[1]::int); end if;
  m := regexp_match(t, 'dans\s+(\d{1,2})\s*(h|heure)');
  if m is not null then return now() + make_interval(hours => m[1]::int); end if;
  if t ~ 'dans\s+(une|1)\s+heure' then return now() + interval '1 hour'; end if;
  m := regexp_match(t, '(\d{1,2})\s*(?:h|:)\s*(\d{2})?');
  if m is not null and m[1]::int < 24 then
    v := (public.today_abidjan() + make_time(m[1]::int, coalesce(m[2], '0')::int, 0)) at time zone 'Africa/Abidjan';
    if t like '%demain%' or v < now() then v := v + interval '1 day'; end if;
    return v;
  end if;
  if t like '%demain%' then return (public.today_abidjan() + 1 + time '08:00') at time zone 'Africa/Abidjan'; end if;
  return now() + interval '30 minutes';
end $$;

-- Un changement de statut remet le compteur d'appels à zéro et prévoit le prochain appel
create or replace function public._supplier_orders_status() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.status is distinct from old.status then
    new.dispatches := 0;
    new.next_call_at := case new.status when 'injoignable' then now() + public._supply_retry_delay()
                                        when 'rappeler' then public._supply_callback_at(new.call_back_at) end;
  end if;
  return new;
end $$;
drop trigger if exists supplier_orders_status on public.supplier_orders;
create trigger supplier_orders_status before update of status on public.supplier_orders
  for each row execute function public._supplier_orders_status();
revoke execute on function public._supplier_orders_status() from public, anon, authenticated;

-- Montant engagé aujourd'hui (commandes passées ou en cours, hors refus / annulations / attente d'accord)
create or replace function public._supply_spent_today() returns int
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(sum(coalesce(received_total, quoted_total, budget)), 0)::int from supplier_orders
   where created_at >= public.today_abidjan()::timestamp at time zone 'Africa/Abidjan'
     and status not in ('refuse', 'annule', 'reporte', 'a_approuver')
$$;

-- Fournisseurs à éviter pour un ingrédient (refus, injoignable, article manquant dans les 12 dernières heures)
create or replace function public._supply_tried(p_ingredient uuid) returns uuid[]
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(array_agg(distinct o.supplier_id), '{}') from supplier_orders o
   where o.auto and o.updated_at > now() - interval '12 hours' and o.supplier_id is not null
     and (exists (select 1 from jsonb_array_elements(o.dropped) d where d ->> 'ingredient_id' = p_ingredient::text)
          or (o.status = 'reporte' and exists (select 1 from jsonb_array_elements(o.items) i where i ->> 'ingredient_id' = p_ingredient::text)))
$$;

-- L'équipe a refusé une commande de l'agent pour cet ingrédient (pas de nouvelle demande pendant 12 h)
create or replace function public._supply_declined(p_ingredient uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from supplier_orders o, jsonb_array_elements(o.items) i
                  where o.auto and o.status = 'annule' and o.cancelled_by is not null and o.updated_at > now() - interval '12 hours'
                    and i ->> 'ingredient_id' = p_ingredient::text)
$$;

-- Meilleur produit du carnet pour un ingrédient : fournisseur habituel, puis secours dans l'ordre, puis le moins cher
create or replace function public._supply_best_product(p_ingredient uuid, p_exclude uuid[] default '{}')
returns public.supplier_products
language sql stable security definer set search_path = public, pg_temp as $$
  select p.* from supplier_products p join suppliers s on s.id = p.supplier_id
   where p.ingredient_id = p_ingredient and s.is_active and not (p.supplier_id = any (coalesce(p_exclude, '{}')))
   order by p.backup_rank, p.usual_price / p.stock_per_unit limit 1
$$;

-- ───────── 4. Besoins : menus à venir + seuil − stock − déjà commandé ─────────
create or replace function public._supply_needs()
returns table (ingredient_id uuid, name text, unit text, stock numeric, threshold numeric, need numeric, open_qty numeric, to_order numeric)
language sql stable security definer set search_path = public, pg_temp as $$
  with cfg as (select greatest(1, least(7, coalesce((public.setting('supply_agent') ->> 'horizon_days')::int, 3))) h),
  upcoming as (
    select rl.ingredient_id, sum(rl.qty_per_portion * greatest(coalesce(mi.planned_qty, 30) - mi.served_qty, 0)) need
      from menu_items mi join menus m on m.id = mi.menu_id join recipe_lines rl on rl.dish_id = mi.dish_id cross join cfg
     where m.status in ('published', 'submitted') and not mi.is_sold_out
       and mi.service_date between public.today_abidjan() and public.today_abidjan() + cfg.h - 1
       and (select w.ends_at from public.service_window(mi.service_date, mi.service) w) > now()
     group by rl.ingredient_id
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
    select i.id, i.name, i.unit, i.stock_qty, i.alert_threshold, coalesce(u.need, 0) need, coalesce(o.qty, 0) + coalesce(s.qty, 0) open_qty
      from ingredients i left join upcoming u on u.ingredient_id = i.id left join ordered o on o.ingredient_id = i.id
      left join shopping s on s.ingredient_id = i.id
  )
  -- On commande quand le stock prévu (stock + en route − besoins) passe sous le seuil, de quoi revenir à 2 × le seuil
  select id, name, unit, stock_qty, alert_threshold, round(need, 2), open_qty,
         case when stock_qty + open_qty - need < alert_threshold then round(need + 2 * alert_threshold - stock_qty - open_qty, 2) else 0 end
    from calc
$$;

-- La fiche de courses d'un employé tient compte de ce que l'agent a déjà commandé
create or replace function public._shopping_needs(p_ingredient uuid default null)
returns table (ingredient_id uuid, name text, unit text, stock numeric, threshold numeric, need numeric, in_transit numeric, to_buy numeric, est_cost int)
language sql stable security definer set search_path = public, pg_temp as $$
  with upcoming as (
    select rl.ingredient_id, sum(rl.qty_per_portion * greatest(coalesce(mi.planned_qty, 30) - mi.served_qty, 0)) need
      from menu_items mi join menus m on m.id = mi.menu_id join recipe_lines rl on rl.dish_id = mi.dish_id
     where m.status in ('published', 'submitted') and not mi.is_sold_out
       and mi.service_date between public.today_abidjan() and public.today_abidjan() + 2
       and (select w.ends_at from public.service_window(mi.service_date, mi.service) w) > now()
       and (p_ingredient is null or rl.ingredient_id = p_ingredient)
     group by rl.ingredient_id
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
    select i.id, i.name, i.unit, i.stock_qty, i.alert_threshold, i.unit_cost,
           coalesce(u.need, 0) need, coalesce(t.qty, 0) in_transit,
           coalesce(u.need, 0) + i.alert_threshold - i.stock_qty - coalesce(t.qty, 0) raw
      from ingredients i left join upcoming u on u.ingredient_id = i.id left join transit t on t.ingredient_id = i.id
     where p_ingredient is null or i.id = p_ingredient
  ), rounded as (
    select *, case when raw <= 0 then 0
                   when in_transit > 0 and raw < alert_threshold / 4 then 0
                   when in_transit > 0 then raw
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

-- ───────── 5. Création d'une commande par l'agent ─────────
create or replace function public._supply_agent_new_order(p_supplier uuid, p_items jsonb, p_origin text, p_reason text,
  p_parent uuid default null, p_by text default null) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare cfg jsonb := public.setting('supply_agent'); s public.suppliers; v_id uuid; v_budget int; v_phone text; v_status text; v_scen text;
  v_limit int := coalesce((cfg ->> 'auto_limit')::int, 100000); v_daily int := coalesce((cfg ->> 'daily_budget')::int, 400000); v_spent int;
begin
  select * into s from suppliers where id = p_supplier;
  if not found or jsonb_array_length(coalesce(p_items, '[]')) = 0 then return null; end if;
  v_phone := public._norm_phone(coalesce(nullif(cfg ->> 'demo_phone', ''), s.phone));
  v_budget := (select sum((i ->> 'qty')::numeric * (i ->> 'usual_price')::numeric)::int from jsonb_array_elements(p_items) i);
  v_spent := public._supply_spent_today();
  v_status := case when p_origin <> 'equipe' and (v_budget > v_limit or v_spent + v_budget > v_daily) then 'a_approuver' else 'a_appeler' end;
  v_scen := case when p_origin <> 'agent' then 'ok'
                 when coalesce(cfg ->> 'sim_scenario', 'varie') = 'varie' then
                   (array['ok', 'injoignable', 'coursier', 'cher', 'manque', 'refuse'])[1 + (select count(*) from supplier_orders
                      where auto and origin = 'agent' and created_at >= public.today_abidjan()::timestamp at time zone 'Africa/Abidjan')::int % 6]
                 else cfg ->> 'sim_scenario' end;
  insert into supplier_orders (supplier_id, supplier_name, call_phone, items, budget, status, auto, origin, parent_id, reason, sim_scenario, created_by)
  values (s.id, s.name, v_phone, p_items, v_budget, v_status, true, p_origin, p_parent, left(p_reason, 1000), v_scen, auth.uid())
  returning id into v_id;
  perform public._supply_event(v_id, 'creation',
    case p_origin when 'secours' then '↪️ Fournisseur de secours : ' when 'equipe' then '🛒 Commande demandée par ' || coalesce(p_by, 'l''équipe') || ' : '
                  else '🤖 L''agent commande : ' end
    || public._supply_items_text(p_items) || ' chez ' || s.name || ' · budget ' || public._fcfa(v_budget)
    || coalesce(' · ' || p_reason, '') || '.');
  if v_status = 'a_approuver' then
    perform public._supply_event(v_id, 'a_approuver', '✋ ' || public._fcfa(v_budget) || ' chez ' || s.name
      || case when v_budget > v_limit then ' (au-dessus de ' || public._fcfa(v_limit) || ')' else ' (budget du jour de ' || public._fcfa(v_daily) || ' dépassé)' end
      || ' : j''attends votre accord avant d''appeler. Répondez « OUI ' || public._supplier_short(s.name) || ' » ou « NON ' || public._supplier_short(s.name) || ' ».');
    perform public._notify_roles('{chef}', 'supply_approve', 'Commande à approuver : ' || s.name, public._fcfa(v_budget),
      jsonb_build_object('href', '/admin/approvisionnement'));
  end if;
  return v_id;
end $$;

-- Ce dont on a besoin → une commande par fournisseur (habituel, sinon secours)
create or replace function public._supply_agent_plan() returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare r record; n int := 0; v_h int := coalesce((public.setting('supply_agent') ->> 'horizon_days')::int, 3);
begin
  for r in
    with needs as (select * from public._supply_needs() where to_order > 0),
    pick as (
      select n.*, p.id product_id, p.supplier_id, p.stock_per_unit
        from needs n cross join lateral public._supply_best_product(n.ingredient_id, public._supply_tried(n.ingredient_id)) p
       where p.id is not null and not public._supply_declined(n.ingredient_id)
    )
    select supplier_id, jsonb_agg(jsonb_build_object('product_id', product_id, 'qty', ceil(to_order / stock_per_unit))) lines,
           string_agg(name || ' : ' || public._fmt_qty(stock) || ' ' || unit || ' en stock'
             || case when need > 0 then ', ' || public._fmt_qty(need) || ' ' || unit || ' pour les menus des ' || v_h || ' jours' else '' end
             || case when open_qty > 0 then ', ' || public._fmt_qty(open_qty) || ' déjà en route' else '' end
             || ' (seuil ' || public._fmt_qty(threshold) || ')', ' ; ' order by name) why
      from pick group by supplier_id
  loop
    if public._supply_agent_new_order(r.supplier_id, public._supply_lines(r.supplier_id, r.lines), 'agent', r.why) is not null then n := n + 1; end if;
  end loop;
  update settings set value = value || jsonb_build_object('last_plan_at', now()) where key = 'supply_agent';
  return n;
end $$;

-- Articles à commander ailleurs (refus, injoignable, manquant) → fournisseurs de secours, sinon fiche de courses
create or replace function public._supply_reroute(p_order uuid, p_items jsonb, p_why text) returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare o public.supplier_orders; r record; n int := 0; v_none text[];
begin
  select * into o from supplier_orders where id = p_order;
  for r in
    select p.supplier_id, jsonb_agg(jsonb_build_object('product_id', p.id, 'qty', ceil((i ->> 'stock_qty')::numeric / p.stock_per_unit))) lines
      from jsonb_array_elements(p_items) i
      cross join lateral public._supply_best_product(nullif(i ->> 'ingredient_id', '')::uuid,
                                                     public._supply_tried(nullif(i ->> 'ingredient_id', '')::uuid) || o.supplier_id) p
     where p.id is not null
     group by p.supplier_id
  loop
    if public._supply_agent_new_order(r.supplier_id, public._supply_lines(r.supplier_id, r.lines), 'secours', p_why || ' chez ' || o.supplier_name, p_order) is not null then
      n := n + 1;
    end if;
  end loop;
  select array_agg(public._sing((i ->> 'qty')::numeric, i ->> 'label')) into v_none from jsonb_array_elements(p_items) i
   where (public._supply_best_product(nullif(i ->> 'ingredient_id', '')::uuid,
                                      public._supply_tried(nullif(i ->> 'ingredient_id', '')::uuid) || o.supplier_id)).id is null;
  if v_none is not null then
    perform public._supply_event(p_order, 'sans_secours', '🧺 Pas d''autre fournisseur pour : ' || array_to_string(v_none, ', ')
      || ' → ajouté à la fiche de courses (achat par un employé).');
    perform public._shopping_refresh();
  end if;
  return n;
end $$;

-- ───────── 6. Coursier et décisions : versions internes (agent, groupe WhatsApp) ─────────
create or replace function public._supplier_order_send_courier(p_order uuid, p_by uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare o public.supplier_orders; s public.suppliers; v_cfg jsonb := public.setting('delivery'); v_run uuid; v_stop uuid; i jsonb;
begin
  select * into o from supplier_orders where id = p_order for update;
  if not found or o.status <> 'coursier' then return public._fail('INVALID_STATUS', 'Ce fournisseur livre lui-même ou la commande n''est pas passée.'); end if;
  if o.run_id is not null then return jsonb_build_object('ok', true, 'run_id', o.run_id); end if;
  select * into s from suppliers where id = o.supplier_id;
  insert into delivery_runs (title, courier_name, courier_phone, vehicle, created_by)
  values ('Récupération chez ' || o.supplier_name, v_cfg -> 'courier' ->> 'name', v_cfg -> 'courier' ->> 'phone', v_cfg -> 'courier' ->> 'vehicle', p_by)
  returning id into v_run;
  insert into delivery_stops (run_id, seq, supplier_id, name, district, phone, lat, lng)
  values (v_run, 1, s.id, s.name, s.district, s.phone, s.lat, s.lng) returning id into v_stop;
  for i in select * from jsonb_array_elements(o.items) loop
    insert into delivery_items (run_id, stop_id, ingredient_id, label, qty, stock_qty, emoji, price_expected)
    values (v_run, v_stop, nullif(i ->> 'ingredient_id', '')::uuid, i ->> 'label', (i ->> 'qty')::numeric, nullif(i ->> 'stock_qty', '')::numeric, '📦',
            round((i ->> 'qty')::numeric * (i ->> 'usual_price')::numeric * coalesce(o.quoted_total::numeric / nullif(o.budget, 0), 1)));
  end loop;
  update supplier_orders set run_id = v_run where id = p_order;
  perform public._delivery_event(v_run, 'creation', '📝 Récupération chez ' || o.supplier_name || ' (commande passée par téléphone) : ' || public._supply_items_text(o.items) || '.');
  perform public._supply_event(p_order, 'coursier', '🛵 Coursier commandé pour récupérer la marchandise chez ' || o.supplier_name || ' (page Livraisons).');
  return jsonb_build_object('ok', true, 'run_id', v_run);
end $$;

create or replace function public.supplier_order_send_courier(p_order uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not public.has_role('chef') then return public._fail('FORBIDDEN', 'Réservé à la cuisine.'); end if;
  return public._supplier_order_send_courier(p_order, auth.uid());
end $$;

-- Décision de l'équipe : prix trop haut (a_valider) ou commande au-dessus du plafond (a_approuver)
create or replace function public._supplier_order_decide(p_order uuid, p_accept boolean, p_author text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare o public.supplier_orders; v_who text := coalesce(nullif(p_author, ''), 'L''équipe');
begin
  select * into o from supplier_orders where id = p_order for update;
  if not found or o.status not in ('a_valider', 'a_approuver') then return public._fail('INVALID_STATUS', 'Rien à valider.'); end if;
  if o.status = 'a_approuver' then
    update supplier_orders set status = case when p_accept then 'a_appeler' else 'annule' end,
           approved_by = case when p_accept then v_who end, cancelled_by = case when p_accept then null else v_who end where id = p_order;
    perform public._supply_event(p_order, case when p_accept then 'approuve' else 'annule' end,
      case when p_accept then '👍 ' || v_who || ' approuve la commande chez ' || o.supplier_name || ' (' || public._fcfa(o.budget) || ') → j''appelle.'
           else '👎 ' || v_who || ' refuse la commande chez ' || o.supplier_name || ' : je ne la passe pas.' end);
  else
    update supplier_orders set status = case when p_accept then 'valide' else 'annule' end,
           validated_total = case when p_accept then o.quoted_total end where id = p_order;
    perform public._supply_event(p_order, case when p_accept then 'valide' else 'annule' end,
      case when p_accept then '👍 ' || v_who || ' accepte ' || public._fcfa(o.quoted_total) || ' chez ' || o.supplier_name || ' → rappeler le fournisseur pour confirmer.'
           else '👎 ' || v_who || ' refuse le prix de ' || o.supplier_name || ' → fournisseur de secours.' end);
  end if;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.supplier_order_decide(p_order uuid, p_accept boolean) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not public.has_role('chef') then return public._fail('FORBIDDEN', 'Réservé à la cuisine.'); end if;
  return public._supplier_order_decide(p_order, p_accept, (select full_name from profiles where id = auth.uid()));
end $$;

-- L'équipe annule une commande pas encore passée (pas de fournisseur de secours)
create or replace function public._supply_cancel(p_order uuid, p_author text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare o public.supplier_orders;
begin
  select * into o from supplier_orders where id = p_order for update;
  if not found then return public._fail('NOT_FOUND', 'Commande introuvable.'); end if;
  if o.status not in ('a_approuver', 'a_appeler', 'injoignable', 'rappeler', 'a_valider', 'valide') then
    return public._fail('INVALID_STATUS', case when o.status = 'appel_en_cours' then 'Appel en cours : attendez la fin.' else 'Commande déjà passée ou terminée.' end);
  end if;
  update supplier_orders set status = 'annule', cancelled_by = coalesce(nullif(p_author, ''), 'L''équipe') where id = p_order;
  perform public._supply_event(p_order, 'annule', '🗑️ ' || coalesce(nullif(p_author, ''), 'L''équipe') || ' annule la commande chez ' || o.supplier_name || '.');
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.supply_order_cancel(p_order uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not public.has_role('chef') then return public._fail('FORBIDDEN', 'Réservé à la cuisine.'); end if;
  return public._supply_cancel(p_order, (select full_name from profiles where id = auth.uid()));
end $$;

-- Commande demandée par l'équipe (« commande 2 sacs de riz ») : [{product_id, qty}] → une commande par fournisseur
create or replace function public._supply_team_order(p_lines jsonb, p_author text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare r record; v_ids uuid[] := '{}'; v_id uuid;
begin
  for r in
    select p.supplier_id, jsonb_agg(jsonb_build_object('product_id', p.id, 'qty', (l ->> 'qty')::numeric)) lines
      from jsonb_array_elements(coalesce(p_lines, '[]')) l join supplier_products p on p.id = nullif(l ->> 'product_id', '')::uuid
     where (l ->> 'qty')::numeric > 0 and (l ->> 'qty')::numeric <= 1000
     group by p.supplier_id
  loop
    v_id := public._supply_agent_new_order(r.supplier_id, public._supply_lines(r.supplier_id, r.lines), 'equipe', null, null, p_author);
    if v_id is not null then v_ids := v_ids || v_id; end if;
  end loop;
  if cardinality(v_ids) = 0 then return public._fail('EMPTY', 'Aucun produit valable : choisissez dans le carnet.'); end if;
  return jsonb_build_object('ok', true, 'orders', to_jsonb(v_ids));
end $$;

-- ───────── 7. Appels à l'Edge Function (pg_net) ─────────
create or replace function public._supply_agent_post(p_fn text, p_body jsonb) returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_url text := public.setting('jean') ->> 'function_url';
begin
  if v_url is null or to_regproc('net.http_post') is null then return false; end if;
  perform net.http_post(url := regexp_replace(v_url, '/[^/]+$', '/' || p_fn),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-jean-secret', public._jean_secret()), body := p_body);
  return true;
exception when others then return false;
end $$;

-- ───────── 8. Le cœur : un tour de l'agent (pg_cron toutes les 30 s) ─────────
create or replace function public.supply_agent_tick(p_force boolean default false) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare cfg jsonb := public.setting('supply_agent'); o public.supplier_orders; v_real boolean := cfg ->> 'mode' = 'reel';
  v_now time := (now() at time zone 'Africa/Abidjan')::time; v_in_hours boolean; v_max int := coalesce((public.setting('supplier_calls') ->> 'max_attempts')::int, 3);
  v_planned int := 0; v_calls int := 0; v_reroutes int := 0; v_couriers int := 0; v_phones text[] := '{}'; v_un jsonb; v_keep jsonb; v_r jsonb;
begin
  if not coalesce((cfg ->> 'enabled')::boolean, false) and not p_force then return jsonb_build_object('ok', true, 'enabled', false); end if;
  if not pg_try_advisory_xact_lock(hashtext('dabali-supply-agent')) then return jsonb_build_object('ok', true, 'busy', true); end if;
  v_in_hours := not v_real or v_now between coalesce((cfg ->> 'hours_from')::time, '07:00') and coalesce((cfg ->> 'hours_to')::time, '18:00');

  -- a. Livraison du coursier réceptionnée → commande reçue (le stock a été crédité à la réception de la tournée)
  for o in select so.* from supplier_orders so join delivery_runs r on r.id = so.run_id
            where so.status = 'coursier' and r.status = 'receptionne' for update of so skip locked loop
    update supplier_orders set status = 'recu', received_at = now(), received_total = coalesce(quoted_total, budget) where id = o.id;
    perform public._supply_event(o.id, 'recu', '📦 Marchandise de ' || o.supplier_name || ' réceptionnée (coursier) : stock mis à jour.');
  end loop;

  -- b. Appel resté « en cours » trop longtemps (fin d'appel jamais reçue) → injoignable
  for o in select * from supplier_orders where status = 'appel_en_cours' and updated_at < now() - interval '15 minutes' for update skip locked loop
    perform public._supplier_call_ended(o.id, null, null, 'fin d''appel non reçue');
  end loop;

  -- c. Refus, prix refusé, injoignable après tous les essais → fournisseur de secours
  for o in select * from supplier_orders where auto and (status = 'refuse' or (status = 'annule' and cancelled_by is null)
              or (status = 'injoignable' and attempts >= v_max)) for update skip locked loop
    update supplier_orders set status = 'reporte' where id = o.id;
    perform public._supply_event(o.id, 'reporte', '↪️ ' || o.supplier_name || ' : '
      || case o.status when 'refuse' then 'commande refusée' when 'annule' then 'prix refusé par l''équipe' else v_max || ' appels sans réponse' end
      || ' → je passe au fournisseur de secours.');
    v_reroutes := v_reroutes + public._supply_reroute(o.id, o.items,
      case o.status when 'refuse' then 'refus' when 'annule' then 'prix trop haut' else 'injoignable' end);
  end loop;

  -- d. Articles manquants chez un fournisseur → retirés de sa commande, commandés ailleurs
  for o in select * from supplier_orders where auto and cardinality(unavailable) > 0
              and status not in ('appel_en_cours', 'reporte', 'refuse', 'annule', 'recu') for update skip locked loop
    select coalesce(jsonb_agg(x.i) filter (where x.m), '[]'), coalesce(jsonb_agg(x.i) filter (where not x.m), '[]') into v_un, v_keep
      from (select i, exists (select 1 from unnest(o.unavailable) u left join ingredients g on g.id::text = i ->> 'ingredient_id'
                               where length(public._plain(u)) >= 3 and (public._plain(i ->> 'label') like '%' || public._plain(u) || '%'
                                  or (g.name is not null and public._plain(u) like '%' || public._plain(g.name) || '%'))) m
              from jsonb_array_elements(o.items) i) x;
    if jsonb_array_length(v_un) = 0 then
      update supplier_orders set unavailable = '{}' where id = o.id;
      perform public._supply_event(o.id, 'partiel', '❔ Article manquant non reconnu (' || array_to_string(o.unavailable, ', ') || ') : à vérifier par l''équipe.');
    elsif jsonb_array_length(v_keep) = 0 then
      update supplier_orders set unavailable = '{}', status = 'reporte', dropped = dropped || v_un where id = o.id;
      perform public._supply_event(o.id, 'reporte', '↪️ ' || o.supplier_name || ' n''a rien de la liste → je passe au fournisseur de secours.');
      v_reroutes := v_reroutes + public._supply_reroute(o.id, v_un, 'manquant');
    else
      update supplier_orders set unavailable = '{}', items = v_keep, dropped = dropped || v_un,
             budget = case when quoted_total is null then (select sum((k ->> 'qty')::numeric * (k ->> 'usual_price')::numeric)::int from jsonb_array_elements(v_keep) k) else budget end
       where id = o.id;
      v_reroutes := v_reroutes + public._supply_reroute(o.id, v_un, 'manquant');
    end if;
  end loop;

  -- e. Le fournisseur ne livre pas → tournée du coursier, qui part tout de suite
  for o in select * from supplier_orders where auto and status = 'coursier' and run_id is null for update skip locked loop
    v_r := public._supplier_order_send_courier(o.id, null);
    if (v_r ->> 'ok')::boolean then
      v_couriers := v_couriers + 1;
      perform public._supply_agent_post('delivery', jsonb_build_object('action', 'start', 'run_id', v_r ->> 'run_id'));
    end if;
  end loop;

  -- f. Nouveaux besoins → nouvelles commandes
  if v_in_hours then v_planned := public._supply_agent_plan(); end if;

  -- g. Appels : un seul à la fois par numéro (en démo, tout va au téléphone du présentateur), aux heures du fournisseur
  if v_in_hours then
    for o in select so.* from supplier_orders so left join suppliers s on s.id = so.supplier_id
              where so.auto
                and ((so.status in ('a_appeler', 'valide') and (so.next_call_at is null or so.next_call_at <= now()))
                  or (so.status = 'injoignable' and so.attempts < v_max and so.next_call_at <= now())
                  or (so.status = 'rappeler' and so.attempts < v_max + 2 and so.next_call_at <= now()))
                and (not v_real or s.id is null or v_now between s.call_from and s.call_to)
                and so.dispatches < 5
                and not exists (select 1 from supplier_orders x where x.call_phone = so.call_phone and x.status = 'appel_en_cours')
              order by so.created_at for update of so skip locked loop
      continue when o.call_phone = any (v_phones);
      update supplier_orders set next_call_at = now() + interval '3 minutes', dispatches = dispatches + 1 where id = o.id;
      if o.dispatches + 1 = 5 then
        perform public._supply_event(o.id, 'alerte', '⚠️ Je n''arrive pas à lancer l''appel vers ' || o.supplier_name || ' : vérifiez l''agent vocal et le numéro (page Appels fournisseurs).');
      end if;
      perform public._supply_agent_post('supplier-call', jsonb_build_object('action', 'call', 'order_id', o.id, 'simulate', not v_real,
        'scenario', case when o.attempts = 0 and o.status = 'a_appeler' then coalesce(o.sim_scenario, 'ok') else 'ok' end));
      v_phones := v_phones || o.call_phone;
      v_calls := v_calls + 1;
    end loop;
  end if;

  update settings set value = value || jsonb_build_object('last_tick_at', now()) where key = 'supply_agent';
  return jsonb_build_object('ok', true, 'enabled', true, 'in_hours', v_in_hours, 'planned', v_planned, 'calls', v_calls,
    'reroutes', v_reroutes, 'couriers', v_couriers);
end $$;

-- ───────── 9. Réception d'une commande livrée par le fournisseur ─────────
-- p_lines : [{product_id, qty}] quantités réellement reçues (par défaut celles commandées) ; p_total : montant payé
create or replace function public.supplier_order_receive(p_order uuid, p_total int default null, p_lines jsonb default null) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare o public.supplier_orders; v_total int; v_value numeric; v_n int := 0; v_alerts text[] := '{}'; r record; v_unit numeric;
begin
  if not public.has_role('chef') then return public._fail('FORBIDDEN', 'Réservé à la cuisine.'); end if;
  select * into o from supplier_orders where id = p_order for update;
  if not found then return public._fail('NOT_FOUND', 'Commande introuvable.'); end if;
  if o.status <> 'commande' then return public._fail('INVALID_STATUS', 'Cette commande n''est pas en attente de livraison.'); end if;
  v_total := coalesce(p_total, o.quoted_total, o.budget);
  if v_total <= 0 or v_total > 50000000 then return public._fail('INVALID', 'Montant invalide.'); end if;
  create temp table if not exists _rcv (product_id uuid, ingredient_id uuid, label text, usual int, qty numeric, rq numeric, stock numeric) on commit drop;
  truncate _rcv;
  insert into _rcv
  select nullif(i ->> 'product_id', '')::uuid, nullif(i ->> 'ingredient_id', '')::uuid, i ->> 'label', (i ->> 'usual_price')::int, (i ->> 'qty')::numeric,
         greatest(0, coalesce((select (l ->> 'qty')::numeric from jsonb_array_elements(coalesce(p_lines, '[]')) l where l ->> 'product_id' = i ->> 'product_id' limit 1),
                              (i ->> 'qty')::numeric)),
         coalesce((i ->> 'stock_qty')::numeric / nullif((i ->> 'qty')::numeric, 0), 1)
    from jsonb_array_elements(o.items) i;
  v_value := (select sum(rq * usual) from _rcv);
  if coalesce(v_value, 0) <= 0 then return public._fail('EMPTY', 'Rien de reçu.'); end if;
  for r in select * from _rcv where rq > 0 loop
    v_unit := r.usual * v_total / v_value;   -- prix réellement payé par unité
    if r.ingredient_id is not null then
      insert into stock_movements (ingredient_id, type, qty, reason, created_by)
      values (r.ingredient_id, 'in', round(r.rq * r.stock, 3), 'Livraison ' || o.supplier_name || ' : ' || public._sing(r.rq, r.label), auth.uid());
      v_n := v_n + 1;
    end if;
    if r.product_id is not null then
      update supplier_products set usual_price = round(0.7 * usual_price + 0.3 * v_unit), last_price = round(v_unit), last_price_at = now() where id = r.product_id;
    end if;
    if v_unit > r.usual * 1.15 then v_alerts := v_alerts || (r.label || ' +' || round(100 * (v_unit - r.usual) / r.usual) || ' %'); end if;
  end loop;
  update supplier_orders set status = 'recu', received_at = now(), received_total = v_total where id = p_order;
  perform public._supply_event(p_order, 'recu', '📦 Reçu de ' || o.supplier_name || ' : '
    || (select string_agg(public._fmt_qty(rq) || ' ' || public._sing(rq, label), ', ') from _rcv where rq > 0)
    || ' = ' || public._fcfa(v_total) || ' · stock mis à jour (' || (select full_name from profiles where id = auth.uid()) || ').');
  if cardinality(v_alerts) > 0 then
    perform public._supply_event(p_order, 'alerte_prix', '📈 Prix en hausse chez ' || o.supplier_name || ' : ' || array_to_string(v_alerts, ', ') || '. Le prix habituel a été ajusté.');
  end if;
  return jsonb_build_object('ok', true, 'stock_lines', v_n);
end $$;

-- ───────── 10. Écran « Agent d'achats » ─────────
create or replace function public._supply_agent_overview() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare cfg jsonb := public.setting('supply_agent');
begin
  return jsonb_build_object('ok', true,
    'settings', cfg,
    'ready', jsonb_build_object('functions', public.setting('jean') ->> 'function_url' is not null,
                                'voice', public.setting('supplier_calls') ->> 'agent_id' is not null and public.setting('supplier_calls') ->> 'from_number' is not null,
                                'group', public.setting('jean') ->> 'group_id' is not null),
    'spent_today', public._supply_spent_today(),
    'needs', (select coalesce(jsonb_agg(jsonb_build_object('ingredient_id', n.ingredient_id, 'name', n.name, 'unit', n.unit, 'stock', n.stock,
                'threshold', n.threshold, 'need', n.need, 'open_qty', n.open_qty, 'to_order', n.to_order,
                'supplier', s.name, 'product', p.label, 'units', case when p.id is not null then ceil(n.to_order / p.stock_per_unit) end,
                'est', case when p.id is not null then (ceil(n.to_order / p.stock_per_unit) * p.usual_price)::int end,
                'declined', public._supply_declined(n.ingredient_id))
              order by (n.to_order > 0) desc, n.stock / nullif(n.threshold, 0) nulls last), '[]')
                from public._supply_needs() n
                left join lateral public._supply_best_product(n.ingredient_id, public._supply_tried(n.ingredient_id)) p on true
                left join suppliers s on s.id = p.supplier_id
               where n.to_order > 0 or n.stock < n.threshold * 1.5 or n.open_qty > 0),
    'orders', (select coalesce(jsonb_agg(to_jsonb(x) order by x.created_at desc), '[]') from (
                 select o.id, o.supplier_name, o.call_phone, o.items, o.budget, o.status, o.quoted_total, o.delivery_at, o.delivery_mode,
                        o.attempts, o.origin, o.reason, o.next_call_at, o.parent_id, o.run_id, o.received_total, o.call_mode, o.created_at, o.updated_at
                   from supplier_orders o where o.auto order by o.created_at desc limit 30) x),
    'events', (select coalesce(jsonb_agg(jsonb_build_object('id', e.id, 'at', e.at, 'kind', e.kind, 'message', e.message, 'order_id', e.order_id) order by e.id desc), '[]')
                 from (select e.* from supply_events e join supplier_orders o on o.id = e.order_id
                        where o.auto and e.kind <> 'dialogue' order by e.id desc limit 40) e));
end $$;

create or replace function public.supply_agent_overview() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not public.has_role('chef') then return public._fail('FORBIDDEN', 'Réservé à la cuisine.'); end if;
  return public._supply_agent_overview();
end $$;

create or replace function public.supply_agent_configure(p_cfg jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare cur jsonb := public.setting('supply_agent'); v jsonb := '{}'; v_phone text;
begin
  if not public.has_role('chef') then return public._fail('FORBIDDEN', 'Réservé à la cuisine.'); end if;
  if p_cfg ? 'enabled' then v := v || jsonb_build_object('enabled', coalesce((p_cfg ->> 'enabled')::boolean, false)); end if;
  if p_cfg ? 'mode' then
    if p_cfg ->> 'mode' not in ('simulation', 'reel') then return public._fail('INVALID', 'Mode inconnu.'); end if;
    if p_cfg ->> 'mode' = 'reel' and (public.setting('supplier_calls') ->> 'agent_id' is null or public.setting('supplier_calls') ->> 'from_number' is null) then
      return public._fail('NOT_READY', 'Pour appeler pour de vrai : configurer l''agent vocal et son numéro (page Appels fournisseurs).');
    end if;
    v := v || jsonb_build_object('mode', p_cfg ->> 'mode');
  end if;
  if p_cfg ? 'demo_phone' then
    v_phone := public._norm_phone(p_cfg ->> 'demo_phone');
    if coalesce(trim(p_cfg ->> 'demo_phone'), '') <> '' and v_phone !~ '^\+[0-9]{8,15}$' then return public._fail('INVALID_PHONE', 'Numéro invalide (ex. +2250700000000).'); end if;
    v := v || jsonb_build_object('demo_phone', nullif(v_phone, ''));
  end if;
  if p_cfg ? 'horizon_days' then
    if (p_cfg ->> 'horizon_days')::int not between 1 and 7 then return public._fail('INVALID', 'Horizon : 1 à 7 jours.'); end if;
    v := v || jsonb_build_object('horizon_days', (p_cfg ->> 'horizon_days')::int);
  end if;
  if p_cfg ? 'auto_limit' then
    if (p_cfg ->> 'auto_limit')::int not between 0 and 10000000 then return public._fail('INVALID', 'Plafond invalide.'); end if;
    v := v || jsonb_build_object('auto_limit', (p_cfg ->> 'auto_limit')::int);
  end if;
  if p_cfg ? 'daily_budget' then
    if (p_cfg ->> 'daily_budget')::int not between 0 and 100000000 then return public._fail('INVALID', 'Budget invalide.'); end if;
    v := v || jsonb_build_object('daily_budget', (p_cfg ->> 'daily_budget')::int);
  end if;
  if p_cfg ? 'sim_scenario' then
    if p_cfg ->> 'sim_scenario' not in ('ok', 'cher', 'coursier', 'injoignable', 'manque', 'refuse', 'varie') then return public._fail('INVALID', 'Scénario inconnu.'); end if;
    v := v || jsonb_build_object('sim_scenario', p_cfg ->> 'sim_scenario');
  end if;
  if p_cfg ? 'hours_from' or p_cfg ? 'hours_to' then
    if coalesce(p_cfg ->> 'hours_from', cur ->> 'hours_from') !~ '^\d{2}:\d{2}$' or coalesce(p_cfg ->> 'hours_to', cur ->> 'hours_to') !~ '^\d{2}:\d{2}$' then
      return public._fail('INVALID', 'Heures au format 07:00.');
    end if;
    v := v || jsonb_build_object('hours_from', coalesce(p_cfg ->> 'hours_from', cur ->> 'hours_from'), 'hours_to', coalesce(p_cfg ->> 'hours_to', cur ->> 'hours_to'));
  end if;
  update settings set value = value || v where key = 'supply_agent';
  perform public._audit('supply_agent_configure', 'supply_agent', v);
  return jsonb_build_object('ok', true, 'settings', public.setting('supply_agent'));
exception when invalid_text_representation then return public._fail('INVALID', 'Valeur invalide.');
end $$;

-- « Lancer maintenant » : un tour de l'agent, même éteint (les appels partent en simulation si le mode l'indique)
create or replace function public.supply_agent_run() returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not public.has_role('chef') then return public._fail('FORBIDDEN', 'Réservé à la cuisine.'); end if;
  return public.supply_agent_tick(true);
end $$;

-- Groupe WhatsApp : « OUI Bamba » / « NON Bamba » (sans IA)
create or replace function public._supply_group_decide(p_text text, p_author text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare m text[]; o public.supplier_orders; r jsonb;
begin
  m := regexp_match(public._plain(trim(p_text)), '^(oui|non)\s+([a-z0-9 \-]{2,40})[ .!]*$');
  if m is null then return jsonb_build_object('handled', false); end if;
  select * into o from supplier_orders where status in ('a_approuver', 'a_valider') and public._plain(supplier_name) like '%' || trim(m[2]) || '%'
   order by updated_at desc limit 1;
  if not found then return jsonb_build_object('handled', true, 'reply', 'Aucune commande en attente pour « ' || trim(m[2]) || ' ».'); end if;
  r := public._supplier_order_decide(o.id, m[1] = 'oui', p_author);
  return jsonb_build_object('handled', true, 'reply', case when (r ->> 'ok')::boolean then null else r ->> 'message' end);
end $$;

-- Point du jour (groupe : « point »)
create or replace function public._supply_point() returns text
language sql stable security definer set search_path = public, pg_temp as $$
  with t as (select * from supplier_orders where created_at >= public.today_abidjan()::timestamp at time zone 'Africa/Abidjan')
  select '📊 *Point achats du jour*' || chr(10)
    || '✅ Commandé : ' || count(*) filter (where status in ('commande', 'coursier', 'recu')) || ' (' || public._fcfa(coalesce(sum(coalesce(received_total, quoted_total)) filter (where status in ('commande', 'coursier', 'recu')), 0)::int) || ')' || chr(10)
    || '✋ En attente de votre accord : ' || count(*) filter (where status in ('a_approuver', 'a_valider')) || chr(10)
    || '📞 À appeler / en cours : ' || count(*) filter (where status in ('a_appeler', 'appel_en_cours', 'injoignable', 'rappeler', 'valide')) || chr(10)
    || '📦 Reçu : ' || count(*) filter (where status = 'recu') || chr(10)
    || '💰 Engagé : ' || public._fcfa(public._supply_spent_today()) || ' / ' || public._fcfa(coalesce((public.setting('supply_agent') ->> 'daily_budget')::int, 400000))
  from t
$$;

-- Droits : fonctions internes réservées au serveur ; écrans réservés à la cuisine
revoke all on function public._supply_retry_delay(), public._supply_callback_at(text), public._supply_spent_today(), public._supply_tried(uuid),
  public._supply_declined(uuid), public._supply_best_product(uuid, uuid[]), public._supply_needs(),
  public._supply_agent_new_order(uuid, jsonb, text, text, uuid, text), public._supply_agent_plan(), public._supply_reroute(uuid, jsonb, text),
  public._supplier_order_send_courier(uuid, uuid), public._supplier_order_decide(uuid, boolean, text), public._supply_cancel(uuid, text),
  public._supply_team_order(jsonb, text), public._supply_agent_post(text, jsonb), public.supply_agent_tick(boolean),
  public._supply_group_decide(text, text), public._supply_point(), public._supply_agent_overview() from public, anon, authenticated;
grant execute on function public._supply_needs(), public._supply_best_product(uuid, uuid[]), public._supplier_order_decide(uuid, boolean, text),
  public._supply_cancel(uuid, text), public._supply_team_order(jsonb, text), public.supply_agent_tick(boolean),
  public._supply_group_decide(text, text), public._supply_point(), public._supply_spent_today(), public._supply_callback_at(text), public._supply_agent_overview() to service_role;
revoke all on function public.supply_agent_overview(), public.supply_agent_configure(jsonb), public.supply_agent_run(),
  public.supplier_order_receive(uuid, int, jsonb), public.supply_order_cancel(uuid) from public, anon;
grant execute on function public.supply_agent_overview(), public.supply_agent_configure(jsonb), public.supply_agent_run(),
  public.supplier_order_receive(uuid, int, jsonb), public.supply_order_cancel(uuid) to authenticated;

-- L'agent tourne toutes les 30 s (il ne fait rien tant qu'il est éteint)
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('dabali-supply-agent', '30 seconds', 'select public.supply_agent_tick()');
  end if;
end $$;
