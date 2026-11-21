-- Palmarès des plats + gaspillage dans les prévisions
--  · Avis : 5 plats les plus aimés / 5 moins aimés du mois (note pondérée par le nombre d'avis, repas servis,
--    % laissé dans l'assiette d'après les photos d'assiettes rendues) et une phrase de conseil au chef ;
--  · Prévisions : % laissé par plat (30 jours, au moins 3 assiettes) ; un plat souvent laissé réduit les besoins
--    en ingrédients (moitié du % laissé, au plus −25 %) ; conseils pour les plats laissés à 25 % ou plus.

-- % laissé dans l'assiette pour un plat, sur les 30 jours avant une date (assiettes rendues, au moins 3)
create or replace function public._dish_left(p_dish uuid, p_date date default public.today_abidjan(),
                                             OUT left_pct int, OUT scans int)
language sql stable security definer set search_path = public, pg_temp as $$
  select case when count(*) >= 3 then round(avg(left_pct))::int end, count(*)::int
    from public.plate_scans
   where dish_id = p_dish and not before_meal and service_date between p_date - 30 and p_date - 1
$$;

create or replace function public._stars_fr(p numeric) returns text language sql immutable set search_path = public, pg_temp as $$
  select replace(to_char(p, 'FM0.0'), '.', ',') || '★'
$$;

create or replace function public.dish_leaderboard(p_month date default public.today_abidjan()) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_from date := date_trunc('month', p_month)::date; v_to date := (date_trunc('month', p_month) + interval '1 month')::date;
  v_mean numeric; r jsonb; v_best jsonb; v_worst jsonb; v_left jsonb; v_advice text;
begin
  if not public.has_role('chef', 'caissier') then return public._fail('FORBIDDEN', 'Réservé à la cuisine et à l''administration.'); end if;
  select coalesce(avg(stars), 3.5) into v_mean from public.ratings
   where created_at >= v_from::timestamp at time zone 'Africa/Abidjan' and created_at < v_to::timestamp at time zone 'Africa/Abidjan';
  with rat as (
    select dish_id, count(*) n, avg(stars) avg_stars from public.ratings
     where dish_id is not null and created_at >= v_from::timestamp at time zone 'Africa/Abidjan' and created_at < v_to::timestamp at time zone 'Africa/Abidjan'
     group by dish_id
  ), served as (
    select dish_id, count(*) meals from (
      select dish_id from public.tickets where dish_id is not null and status = 'used'
         and used_at >= v_from::timestamp at time zone 'Africa/Abidjan' and used_at < v_to::timestamp at time zone 'Africa/Abidjan'
      union all
      select dish_id from public.staff_meals where dish_id is not null and service_date >= v_from and service_date < v_to) x
     group by dish_id
  ), lefts as (
    select dish_id, round(avg(left_pct))::int left_pct, count(*) scans from public.plate_scans
     where dish_id is not null and not before_meal and service_date >= v_from and service_date < v_to group by dish_id
  ), d as (
    select ds.id, ds.name, ds.photo_url, rat.n ratings, round(rat.avg_stars, 1) avg_stars,
           -- note pondérée : un plat noté 1 fois à 5★ ne passe pas devant un plat noté 60 fois à 4,6★
           (rat.n * rat.avg_stars + 5 * v_mean) / (rat.n + 5) score,
           coalesce(served.meals, 0) meals, case when lefts.scans >= 3 then lefts.left_pct end left_pct, coalesce(lefts.scans, 0) scans
      from public.dishes ds join rat on rat.dish_id = ds.id
      left join served on served.dish_id = ds.id left join lefts on lefts.dish_id = ds.id
  ), ranked as (select d.*, row_number() over (order by score desc, meals desc) rk, count(*) over () n from d),
     -- au plus 5 de chaque côté ; peu de plats notés : la moitié haute d'un côté, le reste de l'autre (jamais dans les deux)
     best as (select * from ranked where rk <= least(5, ceil(n / 2.0))),
     worst as (select * from ranked where rk > least(5, ceil(n / 2.0)) and rk > n - 5)
  select jsonb_build_object(
    'best', (select coalesce(jsonb_agg(to_jsonb(b) - 'score' - 'rk' - 'n' order by b.rk), '[]') from best b),
    'worst', (select coalesce(jsonb_agg(to_jsonb(w) - 'score' - 'rk' - 'n' order by w.rk desc), '[]') from worst w),
    'most_left', (select to_jsonb(x) - 'score' from d x where x.left_pct is not null order by x.left_pct desc limit 1))
  into r;

  v_best := r -> 'best' -> 0; v_worst := r -> 'worst' -> 0; v_left := r -> 'most_left';
  if v_best is null then
    v_advice := 'Pas encore d''avis ce mois-ci : le palmarès se remplira avec les notes des élèves.';
  else
    -- tournures neutres (« Le plus aimé : « Salade » ») : justes quel que soit le genre du nom du plat
    v_advice := 'Le plus aimé : « ' || (v_best ->> 'name') || ' » (' || public._stars_fr((v_best ->> 'avg_stars')::numeric)
      || ', ' || (v_best ->> 'meals') || ' repas), à garder au menu.';
    if v_worst is not null then
      v_advice := v_advice || ' Le moins aimé : « ' || (v_worst ->> 'name') || ' » (' || public._stars_fr((v_worst ->> 'avg_stars')::numeric)
        || coalesce(', ' || (v_worst ->> 'left_pct') || ' % laissé dans l''assiette', '') || ') : '
        || case when (v_worst ->> 'left_pct')::int >= 30 then 'réduire la portion ou revoir la recette.'
                when (v_worst ->> 'avg_stars')::numeric < 3 then 'lire les avis et ajuster la recette.'
                else 'à surveiller.' end;
    end if;
    if v_left is not null and (v_left ->> 'left_pct')::int >= 30 and (v_left ->> 'id') is distinct from (v_worst ->> 'id') then
      v_advice := v_advice || ' Souvent laissé dans l''assiette : « ' || (v_left ->> 'name') || ' » (' || (v_left ->> 'left_pct')
        || ' %) : servir une portion plus petite.';
    end if;
  end if;
  return jsonb_build_object('ok', true, 'month', v_from, 'mean', round(v_mean, 1)) || r || jsonb_build_object('advice', v_advice);
end $$;

create or replace function public.admin_forecast(p_date date) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare r jsonb;
begin
  if not public.has_role('chef') then raise exception 'forbidden' using errcode = '42501'; end if;
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


revoke all on function public._dish_left(uuid, date) from public, anon, authenticated;
grant execute on function public._dish_left(uuid, date) to service_role;
revoke all on function public.dish_leaderboard(date) from public, anon;
grant execute on function public.dish_leaderboard(date) to authenticated;
