-- Guide de production du chef (§22) : combien préparer par plat (reprises comprises), quels ingrédients sortir,
-- quand lancer chaque plat ; le chef valide ; les restes saisis en fin de service font apprendre le système.
-- Les chiffres sont calculés ici (jamais inventés par l'IA, qui ne fait que les commenter).

-- 1. Paramètres par plat : taux de reprise (« bisser ») et temps de préparation
alter table public.dishes add column if not exists seconds_rate numeric(3,2) not null default 0.10
  check (seconds_rate between 0 and 1);
alter table public.dishes add column if not exists prep_minutes int not null default 60
  check (prep_minutes between 0 and 600);
comment on column public.dishes.seconds_rate is 'Part des clients qui reprennent le plat (a priori, recalé par les restes saisis)';
comment on column public.dishes.prep_minutes is 'Temps de préparation d''un service complet (minutes), pour l''heure de lancement';

update public.dishes d set seconds_rate = v.r, prep_minutes = v.m from (values
  ('Garba', 0.25, 50), ('Alloco poulet braisé', 0.20, 70), ('Attiéké poisson braisé', 0.15, 75),
  ('Poulet frites', 0.08, 60), ('Foutou banane sauce graine', 0.20, 150), ('Placali sauce kplala', 0.15, 120),
  ('Riz sauce arachide poulet', 0.30, 120), ('Riz sauce graine', 0.30, 150), ('Spaghetti sautés', 0.15, 45),
  ('Salade composée', 0.02, 30), ('Pain beurre & café au lait', 0.10, 20), ('Omelette pain', 0.05, 30),
  ('Bouillie de mil', 0.20, 40), ('Crêpes sucrées', 0.10, 40), ('Croque-monsieur', 0.05, 30),
  ('Brownie', 0.05, 60), ('Pain perdu', 0.08, 35)
) v(name, r, m) where d.name = v.name;

-- 2. Suivi par ligne de menu : proposition, validation, restes
alter table public.menu_items add column if not exists proposed_qty int check (proposed_qty >= 0);
alter table public.menu_items add column if not exists leftover_qty int check (leftover_qty >= 0);
alter table public.menu_items add column if not exists production_validated_at timestamptz;
alter table public.menu_items add column if not exists production_validated_by uuid references public.profiles (id);

-- 3. Taux de reprise appris : (préparé − restes − servis) / servis sur 8 semaines, mélangé à l'a priori (K = 5)
create or replace function public._dish_seconds(p_date date)
returns table (dish_id uuid, prior numeric, observed numeric, days int, rate numeric)
language sql stable security definer set search_path = public, pg_temp as $$
  with obs as (
    select mi.dish_id, count(*)::int days,
           avg(least(greatest((mi.prepared_qty - mi.leftover_qty - mi.served_qty)::numeric / mi.served_qty, 0), 1)) observed
      from menu_items mi join menus m on m.id = mi.menu_id
     where m.status = 'published' and mi.service_date < p_date and mi.service_date >= p_date - 56
       and mi.prepared_qty is not null and mi.leftover_qty is not null and mi.served_qty > 0
     group by mi.dish_id
  )
  select d.id, d.seconds_rate, round(o.observed, 3), coalesce(o.days, 0),
         round((coalesce(o.days, 0) * coalesce(o.observed, 0) + 5 * d.seconds_rate) / (coalesce(o.days, 0) + 5), 3)
    from dishes d left join obs o on o.dish_id = d.id
$$;
revoke all on function public._dish_seconds(date) from public, anon, authenticated;
grant execute on function public._dish_seconds(date) to service_role;

-- 4. Plan de production d'un jour : par service et par plat
create or replace function public.production_plan(p_date date) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_f jsonb; r jsonb;
begin
  if not public.has_role('chef') then raise exception 'forbidden' using errcode = '42501'; end if;
  v_f := public.admin_forecast(p_date);
  with fi as (
    select (x ->> 'id')::uuid id, (x ->> 'expected')::int expected, (x ->> 'share')::int share,
           (x ->> 'popularity')::numeric popularity, (x ->> 'days')::int pop_days
      from jsonb_array_elements(v_f -> 'items') x
  ), it as (
    select mi.id, mi.service, mi.dish_id, d.name, d.photo_url, d.prep_minutes, mi.planned_qty, mi.prepared_qty, mi.served_qty,
           mi.sold_qty, mi.leftover_qty, mi.proposed_qty saved_proposal, mi.production_validated_at,
           fi.expected, fi.share, fi.popularity, fi.pop_days, s.rate seconds, s.days sec_days, s.observed sec_obs, s.prior sec_prior,
           -- marge plus large quand on connaît mal le plat
           case when fi.pop_days >= 5 then 0.05 else 0.10 end margin,
           w.starts_at
      from menu_items mi join menus m on m.id = mi.menu_id join dishes d on d.id = mi.dish_id
      join fi on fi.id = mi.id
      join public._dish_seconds(p_date) s on s.dish_id = mi.dish_id
      cross join lateral public.service_window(p_date, mi.service) w
     where mi.service_date = p_date
  ), prop as (
    select it.*, greatest(5, ceil(expected * (1 + seconds) * (1 + margin) / 5.0) * 5)::int proposed,
           ceil(expected * seconds)::int seconds_portions
      from it
  ), qty as (
    -- quantité retenue : validée par le chef, sinon la proposition
    select prop.*, case when production_validated_at is not null then coalesce(planned_qty, proposed) else proposed end portions from prop
  )
  select jsonb_build_object(
    'date', p_date,
    'services', v_f -> 'services',
    'items', (select coalesce(jsonb_agg(jsonb_build_object(
        'id', q.id, 'service', q.service, 'dish', q.name, 'photo_url', q.photo_url,
        'expected', q.expected, 'share', q.share, 'popularity', round(q.popularity, 2),
        'seconds_rate', round(q.seconds * 100), 'seconds_basis', case when q.sec_days >= 3 then 'observed' else 'prior' end,
        'seconds_days', q.sec_days, 'seconds_portions', q.seconds_portions, 'margin', round(q.margin * 100),
        'proposed', q.proposed, 'portions', q.portions, 'validated', q.production_validated_at is not null,
        'validated_at', q.production_validated_at, 'planned', q.planned_qty, 'sold', q.sold_qty,
        'prepared', q.prepared_qty, 'served', q.served_qty, 'leftover', q.leftover_qty,
        'start_at', q.starts_at - make_interval(mins => q.prep_minutes + 15), 'prep_minutes', q.prep_minutes,
        'ingredients', (select coalesce(jsonb_agg(jsonb_build_object('name', i.name, 'unit', i.unit,
                          'qty', round(rl.qty_per_portion * q.portions, 2)) order by rl.qty_per_portion * q.portions desc), '[]')
                          from recipe_lines rl join ingredients i on i.id = rl.ingredient_id where rl.dish_id = q.dish_id))
        order by q.service, q.starts_at - make_interval(mins => q.prep_minutes), q.portions desc), '[]') from qty q),
    'ingredients', (select coalesce(jsonb_agg(jsonb_build_object('name', x.name, 'unit', x.unit, 'need', x.need,
                      'stock', x.stock_qty, 'missing', greatest(round(x.need - x.stock_qty, 2), 0)) order by x.need - x.stock_qty desc), '[]')
                      from (select i.name, i.unit, i.stock_qty, round(sum(rl.qty_per_portion * q.portions), 2) need
                              from qty q join recipe_lines rl on rl.dish_id = q.dish_id join ingredients i on i.id = rl.ingredient_id
                             group by i.id) x),
    'validated_all', (select coalesce(bool_and(production_validated_at is not null), false) from qty)
  ) into r;
  return r;
end $$;
revoke all on function public.production_plan(date) from public, anon;
grant execute on function public.production_plan(date) to authenticated;

-- 5. Validation du chef : quantités retenues par plat → planned_qty (limite de vente) + prepared_qty (production)
create or replace function public.validate_production(p_date date, p_items jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_plan jsonb; x jsonb; v_mi public.menu_items; v_qty int; v_n int := 0;
begin
  if not public.has_role('chef') then return public._fail('FORBIDDEN', 'Réservé à la cuisine.'); end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then return public._fail('EMPTY', 'Aucun plat.'); end if;
  v_plan := public.production_plan(p_date);
  for x in select * from jsonb_array_elements(p_items) loop
    select * into v_mi from public.menu_items where id = (x ->> 'id')::uuid and service_date = p_date for update;
    if not found then return public._fail('NOT_FOUND', 'Plat introuvable ce jour-là.'); end if;
    v_qty := (x ->> 'qty')::int;
    if v_qty is null or v_qty < 0 or v_qty > 5000 then return public._fail('INVALID_QTY', 'Quantité invalide.'); end if;
    if v_qty < greatest(v_mi.sold_qty, v_mi.served_qty) then
      return public._fail('BELOW_SOLD', (select d.name from dishes d where d.id = v_mi.dish_id) || ' : déjà ' ||
        greatest(v_mi.sold_qty, v_mi.served_qty) || ' portions réservées ou servies.');
    end if;
    update public.menu_items
       set planned_qty = v_qty, prepared_qty = v_qty,
           proposed_qty = (select (i ->> 'proposed')::int from jsonb_array_elements(v_plan -> 'items') i where (i ->> 'id')::uuid = v_mi.id),
           production_validated_at = now(), production_validated_by = auth.uid()
     where id = v_mi.id;
    v_n := v_n + 1;
  end loop;
  perform public._audit('validate_production', p_date::text, jsonb_build_object('items', p_items));
  return jsonb_build_object('ok', true, 'validated', v_n);
end $$;
revoke all on function public.validate_production(date, jsonb) from public, anon;
grant execute on function public.validate_production(date, jsonb) to authenticated;

-- 6. Restes en fin de service (portions non mangées) → apprentissage des reprises et vrai gaspillage
create or replace function public.record_leftovers(p_items jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare x jsonb; v_mi public.menu_items; v_left int; v_prep int; v_n int := 0;
begin
  if not public.has_role('chef') then return public._fail('FORBIDDEN', 'Réservé à la cuisine.'); end if;
  for x in select * from jsonb_array_elements(coalesce(p_items, '[]')) loop
    select * into v_mi from public.menu_items where id = (x ->> 'id')::uuid for update;
    if not found then return public._fail('NOT_FOUND', 'Plat introuvable.'); end if;
    v_left := (x ->> 'leftover')::int;
    v_prep := coalesce((x ->> 'prepared')::int, v_mi.prepared_qty, v_mi.planned_qty);
    if v_prep is null then return public._fail('NO_PREPARED', 'Indiquez d''abord combien de portions ont été préparées.'); end if;
    if v_left is null or v_left < 0 or v_left > v_prep then return public._fail('INVALID_QTY', 'Restes invalides (entre 0 et ' || v_prep || ').'); end if;
    update public.menu_items set leftover_qty = v_left, prepared_qty = v_prep where id = v_mi.id;
    v_n := v_n + 1;
  end loop;
  perform public._audit('record_leftovers', null, jsonb_build_object('items', p_items));
  return jsonb_build_object('ok', true, 'saved', v_n);
end $$;
revoke all on function public.record_leftovers(jsonb) from public, anon;
grant execute on function public.record_leftovers(jsonb) to authenticated;

-- 7. Gaspillage : les restes saisis font foi (sinon préparé − servi, comme avant)
create or replace function public.admin_waste(p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare r jsonb;
begin
  if not public.has_role('chef') then raise exception 'forbidden' using errcode = '42501'; end if;
  with it as (
    select mi.service_date, mi.prepared_qty, mi.served_qty, d.name,
           coalesce(mi.leftover_qty, greatest(coalesce(mi.prepared_qty, 0) - mi.served_qty, 0)) lost,
           (select coalesce(sum(rl.qty_per_portion * i.unit_cost), 0) from recipe_lines rl join ingredients i on i.id = rl.ingredient_id
             where rl.dish_id = mi.dish_id) portion_cost
      from menu_items mi join dishes d on d.id = mi.dish_id join menus m on m.id = mi.menu_id
     where m.status = 'published' and mi.service_date between p_from and p_to and mi.prepared_qty is not null
  )
  select jsonb_build_object(
    'prepared', coalesce(sum(prepared_qty), 0), 'served', coalesce(sum(served_qty), 0), 'lost', coalesce(sum(lost), 0),
    'cost', coalesce(ceil(sum(lost * portion_cost)), 0),
    'daily', (select coalesce(jsonb_agg(x order by x.day), '[]') from (
                select service_date as day, sum(prepared_qty)::int prepared, sum(served_qty)::int served, sum(lost)::int lost,
                       ceil(sum(lost * portion_cost))::int cost
                  from it group by 1) x),
    'dishes', (select coalesce(jsonb_agg(x order by x.lost desc), '[]') from (
                select name, sum(lost)::int lost, ceil(sum(lost * portion_cost))::int cost,
                       round(100.0 * sum(lost) / nullif(sum(prepared_qty), 0), 1) rate
                  from it group by name) x)
  ) into r from it;
  return r;
end $$;

-- 8. Menu publié → le chef est invité à valider le guide de production
create or replace function public._production_notify() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.status = 'published' and old.status is distinct from 'published' then
    perform public._notify_roles('{chef}', 'production_ready', 'Guide de production prêt 👨‍🍳',
      'Le menu de la semaine du ' || to_char(new.week_start, 'DD/MM') || ' est publié. Vérifie et valide les quantités proposées.',
      jsonb_build_object('href', '/admin/production?date=' || greatest(new.week_start, public.today_abidjan())));
  end if;
  return null;
end $$;
create or replace trigger menus_production_notify after update of status on public.menus
  for each row execute function public._production_notify();

-- 9. Brief IA du guide de production (cache)
create table if not exists public.ai_production_briefs (
  service_date date primary key,
  input_hash text not null,
  brief jsonb not null,
  model text not null,
  created_at timestamptz not null default now()
);
alter table public.ai_production_briefs enable row level security;
create policy "briefs de production lisibles par la cuisine" on public.ai_production_briefs for select to authenticated using (public.has_role('chef'));
grant select on public.ai_production_briefs to authenticated;
grant all on public.ai_production_briefs to service_role;
