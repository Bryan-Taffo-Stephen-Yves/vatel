-- Ruptures de stock : prévenir AVANT (cahier des charges : « éviter les ruptures »)
--  1. Risque de rupture : pour aujourd'hui et demain, besoin prévu (portions du guide de production × recettes)
--     comparé au stock + ce qui est déjà en route (commandes fournisseurs non reçues, courses en cours).
--     Affiché dans les alertes du tableau de bord et dans Stock, et en tête du point des achats (15h00).
--  2. « Stock bas » (seuil franchi) envoyé au chef ET à l'admin (avant : chef seulement), avec lien vers Stock.

create or replace function public._stock_risks() returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  with needs as (
    select n.ingredient_id, n.service_date, sum(n.need) need from public._ingredient_needs(2) n group by 1, 2
  ), transit as (
    select x.ingredient_id, sum(x.qty) qty from (
      select (i ->> 'ingredient_id')::uuid ingredient_id, (i ->> 'stock_qty')::numeric qty
        from supplier_orders o cross join jsonb_array_elements(o.items) i
       where o.status not in ('refuse', 'annule', 'reporte', 'recu', 'a_approuver') and nullif(i ->> 'ingredient_id', '') is not null
         and not exists (select 1 from delivery_runs r where r.id = o.run_id and r.status = 'receptionne')
      union all
      select si.ingredient_id, case when si.status = 'bought' then coalesce(si.bought_qty, si.qty) else si.qty end
        from shopping_items si join shopping_lists sl on sl.id = si.list_id
       where sl.status in ('assigned', 'shopping') and si.status <> 'missing' and si.ingredient_id is not null
    ) x group by 1
  ), cum as (   -- besoin cumulé jour après jour
    select n.ingredient_id, n.service_date, sum(n.need) over (partition by n.ingredient_id order by n.service_date) need_cum from needs n
  ), first_short as (
    select distinct on (c.ingredient_id) c.ingredient_id, c.service_date, c.need_cum,
           i.name, i.unit, i.stock_qty, coalesce(t.qty, 0) transit
      from cum c join ingredients i on i.id = c.ingredient_id left join transit t on t.ingredient_id = c.ingredient_id
     where c.need_cum > i.stock_qty + coalesce(t.qty, 0)
     order by c.ingredient_id, c.service_date
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'ingredient_id', ingredient_id, 'name', name, 'unit', unit, 'day', service_date,
           'day_label', case when service_date = public.today_abidjan() then 'aujourd''hui' else 'demain' end,
           'need', round(need_cum, 2), 'stock', stock_qty, 'transit', round(transit, 2),
           'missing', round(need_cum - stock_qty - transit, 2))
         order by service_date, need_cum - stock_qty - transit desc), '[]')
    from first_short
$$;

-- Écrans (tableau de bord, Stock) : réservé à l'équipe cuisine / admin / caisse
create or replace function public.stock_risks() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not public.has_role('chef', 'caissier') then return public._fail('FORBIDDEN', 'Réservé à l''équipe.'); end if;
  return jsonb_build_object('ok', true, 'risks', public._stock_risks());
end $$;

-- « Stock bas » : chef ET admin, avec lien vers Stock
create or replace function public.apply_stock_movement() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_old numeric; v_new numeric; v_ing public.ingredients;
begin
  select * into v_ing from public.ingredients where id = new.ingredient_id for update;
  v_old := v_ing.stock_qty;
  v_new := v_old + case new.type when 'in' then new.qty when 'adjust' then new.qty else -new.qty end;
  update public.ingredients set stock_qty = v_new where id = new.ingredient_id;
  if v_new < v_ing.alert_threshold and v_old >= v_ing.alert_threshold then
    perform public._notify_roles('{chef,admin}', 'stock_low', 'Stock bas : ' || v_ing.name,
      'Reste ' || public._num(v_new) || ' ' || v_ing.unit || ' (seuil ' ||
      public._num(v_ing.alert_threshold) || ').', jsonb_build_object('ingredient_id', v_ing.id, 'href', '/admin/stock'));
  end if;
  return new;
end $$;

-- Point des achats : risques de rupture en tête
create or replace function public._shopping_brief(p_force boolean default false) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_cfg jsonb := coalesce(public.setting('shopping_brief'), '{}');
  v_today text := public.today_abidjan()::text;
  v_now text := to_char(now() at time zone 'Africa/Abidjan', 'HH24:MI');
  v_list uuid; v_code text; v_n int; v_total int; v_top text; v_fresh int; v_risk text;
begin
  if not p_force then
    if not coalesce((v_cfg ->> 'enabled')::boolean, true) then return jsonb_build_object('ok', true, 'sent', false, 'why', 'disabled'); end if;
    if v_cfg ->> 'last_sent_on' = v_today then return jsonb_build_object('ok', true, 'sent', false, 'why', 'already_sent'); end if;
    if v_now < coalesce(v_cfg ->> 'time', '15:00') then return jsonb_build_object('ok', true, 'sent', false, 'why', 'too_early'); end if;
  end if;

  perform public._shopping_refresh();
  v_list := public._shopping_open();
  select 'C-' || lpad(num::text, 4, '0') into v_code from shopping_lists where id = v_list;
  select count(*), coalesce(sum(est_cost), 0)::int,
         count(*) filter (where i.shelf_life_days is not null)
    into v_n, v_total, v_fresh
    from shopping_items si left join ingredients i on i.id = si.ingredient_id
   where si.list_id = v_list and si.status = 'todo';

  -- Risques de rupture (aujourd'hui / demain), en tête du point
  select string_agg(r ->> 'name' || ' (manque ' || public._num((r ->> 'missing')::numeric) || ' ' || (r ->> 'unit') || ', ' || (r ->> 'day_label') || ')', ', ')
    into v_risk from jsonb_array_elements(public._stock_risks()) r;

  if v_n = 0 then
    if not p_force then
      update settings set value = value || jsonb_build_object('last_sent_on', v_today) where key = 'shopping_brief';
    end if;
    return jsonb_build_object('ok', true, 'sent', false, 'why', 'nothing', 'items', 0);
  end if;

  select string_agg(public._num(si.qty) || ' ' || si.unit || ' ' || si.label, ', ' order by si.est_cost desc)
    into v_top
    from (select * from shopping_items where list_id = v_list and status = 'todo' order by est_cost desc limit 5) si;

  perform public._notify_roles('{chef,admin}', 'shopping_brief',
    case when v_risk is not null then '⚠️ ' else '🛒 ' end || 'Courses à faire : ' || v_n || ' article' || case when v_n > 1 then 's' else '' end || ' · ~' || public.fcfa(v_total),
    coalesce('Risque de rupture : ' || v_risk || '. ', '') || 'Calculé d''après les prévisions des 3 prochains jours'
      || case when v_fresh > 0 then ' (' || v_fresh || ' produit' || case when v_fresh > 1 then 's frais achetés' else ' frais acheté' end || ' juste pour leurs jours)' else '' end
      || '. ' || v_top || case when v_n > 5 then '…' else '.' end,
    jsonb_build_object('href', '/admin/courses', 'list', v_code));

  if not p_force then
    update settings set value = value || jsonb_build_object('last_sent_on', v_today) where key = 'shopping_brief';
  end if;
  return jsonb_build_object('ok', true, 'sent', true, 'items', v_n, 'total', v_total, 'list', v_code);
end $$;

revoke all on function public._stock_risks(), public._shopping_brief(boolean) from public, anon, authenticated;
grant execute on function public._stock_risks(), public._shopping_brief(boolean) to service_role;
revoke all on function public.stock_risks() from public, anon;
grant execute on function public.stock_risks() to authenticated;
revoke execute on function public.apply_stock_movement() from public, anon, authenticated;
