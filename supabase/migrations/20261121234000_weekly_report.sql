-- Rapport du lundi : chaque lundi à 8h, le chef et l'admin reçoivent le bilan de la semaine passée
-- (plats aimés / à revoir avec la tendance, plaintes par type, % laissé dans l'assiette et photos d'assiettes,
-- commentaires marquants, repas servis, gaspillage) et peuvent préparer le menu suivant à partir de ces résultats.
-- L'assistant du menu (menu_ai_context) reçoit aussi le % laissé, les types de plaintes, les avis et la tendance.

-- Émotion d'une note moyenne (même échelle que l'appli : 😡 😕 😐 😋 😍)
create or replace function public._mood_emoji(p numeric) returns text language sql immutable set search_path = public, pg_temp as $$
  select case when p is null then '' when p < 1.5 then '😡' when p < 2.5 then '😕' when p < 3.5 then '😐' when p < 4.5 then '😋' else '😍' end
$$;

-- Plainte en clair
create or replace function public._complaint_fr(p text) returns text language sql immutable set search_path = public, pg_temp as $$
  select case p when 'froid' then 'froid' when 'pas_cuit' then 'pas assez cuit' when 'trop_sale' then 'trop salé' when 'fade' then 'fade'
                when 'portion' then 'portion trop petite' when 'corps_etranger' then 'corps étranger' when 'attente' then 'attente trop longue'
                else p end
$$;

-- Calcul (sans contrôle de rôle : appelé par weekly_report et par la tâche du lundi, jamais exposé)
create or replace function public._weekly_report(p_week_start date) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_start date := p_week_start - (extract(isodow from p_week_start)::int - 1);   -- toujours un lundi
  v_end date := v_start + 7;
  v_from timestamptz := v_start::timestamp at time zone 'Africa/Abidjan';
  v_to timestamptz := v_end::timestamp at time zone 'Africa/Abidjan';
  v_mean numeric; r jsonb; v_best jsonb; v_worst jsonb; v_advice text[] := '{}';
begin
  select coalesce(avg(stars), 3.5) into v_mean from public.ratings where created_at >= v_from and created_at < v_to;

  with rat as (
    select dish_id, count(*) n, avg(stars) avg_stars from public.ratings
     where created_at >= v_from and created_at < v_to group by dish_id
  ), prev as (   -- les 4 semaines d'avant : pour dire si un plat monte ou baisse
    select dish_id, avg(stars) avg_stars from public.ratings
     where created_at >= v_from - interval '28 days' and created_at < v_from group by dish_id
  ), served as (
    select dish_id, count(*) meals from (
      select dish_id from public.tickets where dish_id is not null and status = 'used' and used_at >= v_from and used_at < v_to
      union all
      select dish_id from public.staff_meals where dish_id is not null and service_date >= v_start and service_date < v_end) x
     group by dish_id
  ), lefts as (
    select dish_id, round(avg(left_pct))::int left_pct, count(*) scans from public.plate_scans
     where dish_id is not null and not before_meal and service_date >= v_start and service_date < v_end group by dish_id
  ), compl as (
    select dish_id, jsonb_object_agg(c, n) types, (array_agg(c order by n desc, c))[1] top from (
      select dish_id, unnest(complaints) c, count(*) n from public.ratings
       where created_at >= v_from and created_at < v_to and cardinality(complaints) > 0 group by 1, 2) x
     group by dish_id
  ), d as (
    select ds.id, ds.name, ds.photo_url, rat.n ratings, round(rat.avg_stars, 1) avg_stars,
           round(prev.avg_stars, 1) prev_stars,
           case when prev.avg_stars is null then null
                when rat.avg_stars - prev.avg_stars >= 0.3 then 'hausse'
                when prev.avg_stars - rat.avg_stars >= 0.3 then 'baisse' else 'stable' end trend,
           (rat.n * rat.avg_stars + 5 * v_mean) / (rat.n + 5) score,
           coalesce(served.meals, 0) meals, lefts.left_pct, coalesce(lefts.scans, 0) scans,
           coalesce(compl.types, '{}') complaints, public._complaint_fr(compl.top) top_complaint
      from public.dishes ds join rat on rat.dish_id = ds.id
      left join prev on prev.dish_id = ds.id left join served on served.dish_id = ds.id
      left join lefts on lefts.dish_id = ds.id left join compl on compl.dish_id = ds.id
  ), ranked as (select d.*, row_number() over (order by score desc, meals desc) rk, count(*) over () n from d),
     best as (select * from ranked where rk <= least(3, ceil(n / 2.0))),
     worst as (select * from ranked where rk > least(3, ceil(n / 2.0)) and rk > n - 3)
  select jsonb_build_object(
    'best', (select coalesce(jsonb_agg(to_jsonb(b) - 'score' - 'rk' - 'n' order by b.rk), '[]') from best b),
    'worst', (select coalesce(jsonb_agg(to_jsonb(w) - 'score' - 'rk' - 'n' order by w.rk desc), '[]') from worst w),
    'most_left', (select coalesce(jsonb_agg(to_jsonb(x) - 'score' order by x.left_pct desc), '[]')
                    from (select * from d where left_pct is not null order by left_pct desc limit 3) x))
  into r;

  -- Conseils en une phrase chacun (tournures neutres : justes quel que soit le genre du plat)
  v_best := r -> 'best' -> 0; v_worst := r -> 'worst' -> 0;
  if v_best is not null then
    v_advice := v_advice || ('À garder : « ' || (v_best ->> 'name') || ' » ' || public._mood_emoji((v_best ->> 'avg_stars')::numeric)
      || ' ' || replace(v_best ->> 'avg_stars', '.', ',') || '/5'
      || case v_best ->> 'trend' when 'hausse' then ', en hausse' else '' end || '.');
  end if;
  if v_worst is not null then
    v_advice := v_advice || ('À revoir : « ' || (v_worst ->> 'name') || ' » ' || public._mood_emoji((v_worst ->> 'avg_stars')::numeric)
      || ' ' || replace(v_worst ->> 'avg_stars', '.', ',') || '/5'
      || coalesce(', ' || (v_worst ->> 'left_pct') || ' % laissé', '')
      || coalesce(', surtout « ' || (v_worst ->> 'top_complaint') || ' »', '')
      || case when (v_worst ->> 'left_pct')::int >= 30 then ' : réduire la portion ou revoir la recette.'
              else ' : lire les avis et ajuster la recette.' end);
  end if;

  return jsonb_build_object(
    'ok', true, 'week_start', v_start, 'week_end', v_end - 1,
    'served', (select count(*) from public.tickets where status = 'used' and used_at >= v_from and used_at < v_to)
              + (select count(*) from public.staff_meals where service_date >= v_start and service_date < v_end),
    'served_prev', (select count(*) from public.tickets where status = 'used' and used_at >= v_from - interval '7 days' and used_at < v_from),
    'ratings', (select count(*) from public.ratings where created_at >= v_from and created_at < v_to),
    'avg_stars', (select round(avg(stars), 1) from public.ratings where created_at >= v_from and created_at < v_to),
    'avg_stars_prev', (select round(avg(stars), 1) from public.ratings where created_at >= v_from - interval '7 days' and created_at < v_from),
    'left_pct', (select round(avg(left_pct))::int from public.plate_scans where not before_meal and service_date >= v_start and service_date < v_end),
    'best', r -> 'best', 'worst', r -> 'worst', 'most_left', r -> 'most_left',
    'complaints', (select coalesce(jsonb_agg(jsonb_build_object('code', c, 'n', n) order by n desc), '[]') from (
                     select unnest(complaints) c, count(*) n from public.ratings
                      where created_at >= v_from and created_at < v_to and cardinality(complaints) > 0 group by 1) x),
    -- Commentaires marquants : les 2 plus positifs et les 2 plus négatifs (sans le nom de l'élève)
    'comments', (select coalesce(jsonb_agg(jsonb_build_object('dish', x.dish, 'stars', x.stars, 'comment', x.comment, 'at', x.created_at)), '[]') from (
                   (select ds.name dish, r.stars, r.comment, r.created_at from public.ratings r join public.dishes ds on ds.id = r.dish_id
                     where r.created_at >= v_from and r.created_at < v_to and length(trim(coalesce(r.comment, ''))) >= 8
                     order by r.stars desc, r.created_at desc limit 2)
                   union all
                   (select ds.name, r.stars, r.comment, r.created_at from public.ratings r join public.dishes ds on ds.id = r.dish_id
                     where r.created_at >= v_from and r.created_at < v_to and length(trim(coalesce(r.comment, ''))) >= 8 and r.stars <= 3
                     order by r.stars, r.created_at desc limit 2)) x),
    -- Photos d'assiettes (avis avec photo), les plus laissées d'abord
    'photos', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from (
                 select r.photo_path, ds.name dish, r.stars, ps.left_pct from public.ratings r join public.dishes ds on ds.id = r.dish_id
                   left join public.plate_scans ps on ps.ticket_id = r.ticket_id and not ps.before_meal
                  where r.photo_path is not null and r.created_at >= v_from and r.created_at < v_to
                  order by ps.left_pct desc nulls last, r.created_at desc limit 4) x),
    'advice', to_jsonb(v_advice));
end $$;

-- Pour l'écran « Rapport de la semaine » (chef, caisse, admin)
create or replace function public.weekly_report(p_week_start date default null) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not public.has_role('chef', 'caissier') then return public._fail('FORBIDDEN', 'Réservé à la cuisine et à l''administration.'); end if;
  return public._weekly_report(coalesce(p_week_start, public.today_abidjan() - 7));
end $$;

-- Lundi 8h : le rapport de la semaine passée part en notification au chef et à l'admin
create or replace function public.send_weekly_report() returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare r jsonb := public._weekly_report(public.today_abidjan() - 7); v_body text; v_n int := 0; u record;
begin
  if coalesce((r ->> 'served')::int, 0) = 0 and coalesce((r ->> 'ratings')::int, 0) = 0 then return 0; end if;   -- semaine vide
  v_body := coalesce(nullif(concat_ws(' · ',
              'À garder : ' || (r -> 'best' -> 0 ->> 'name') || ' ' || public._mood_emoji((r -> 'best' -> 0 ->> 'avg_stars')::numeric),
              'À revoir : ' || (r -> 'worst' -> 0 ->> 'name') || coalesce(' (' || (r -> 'worst' -> 0 ->> 'left_pct') || ' % laissé)', '')), ''),
            (r ->> 'served') || ' repas servis');
  for u in select id from public.profiles where role in ('chef', 'admin') and not is_blocked loop
    perform public._notify(u.id, 'weekly_report', 'Ton rapport de la semaine 📊', v_body,
      jsonb_build_object('href', '/admin/rapports/semaine?semaine=' || (r ->> 'week_start')));
    v_n := v_n + 1;
  end loop;
  return v_n;
end $$;

revoke all on function public._weekly_report(date), public.send_weekly_report(), public._mood_emoji(numeric), public._complaint_fr(text) from public, anon, authenticated;
grant execute on function public.send_weekly_report() to service_role;   -- tâche planifiée
revoke all on function public.weekly_report(date) from public, anon;
grant execute on function public.weekly_report(date) to authenticated;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('vatel-weekly-report', '0 8 * * 1', 'select public.send_weekly_report()');   -- lundi 8h (Abidjan = UTC)
  end if;
end $$;

-- Assistant du menu : en plus de la popularité, de la note et du nombre de plaintes, il voit maintenant
-- le % laissé dans l'assiette (photos), les types de plaintes, les derniers commentaires et la tendance du plat,
-- ainsi que les conseils du rapport de la semaine passée.
create or replace function public.menu_ai_context(p_week_start date) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not public.has_role('chef') then raise exception 'forbidden' using errcode = '42501'; end if;
  return jsonb_build_object(
    'semaine', p_week_start,
    'jours', (select jsonb_agg(jsonb_build_object('date', p_week_start + k, 'jour', to_char(p_week_start + k, 'TMDay'),
                'services', case when k = 5 then '["breakfast","lunch"]'::jsonb else '["breakfast","lunch","snack","dinner"]'::jsonb end))
              from generate_series(0, 5) k),
    'services', public.setting('services'),
    'plats', (select jsonb_agg(jsonb_build_object(
                'id', d.id, 'nom', d.name, 'categorie', c.name, 'prix', d.base_price,
                'services_possibles', case c.name when 'Petit-déjeuner' then '["breakfast"]'::jsonb when 'Snack' then '["snack"]'::jsonb
                                                  else '["lunch","dinner"]'::jsonb end,
                'popularite', round(p.popularity, 2), 'note', p.stars,
                'plaintes_30j', (select count(*) from ratings r where r.dish_id = d.id and cardinality(r.complaints) > 0 and r.created_at > now() - interval '30 days'),
                'plaintes_types_30j', (select coalesce(jsonb_object_agg(c2, n), '{}') from (
                    select unnest(r.complaints) c2, count(*) n from ratings r
                     where r.dish_id = d.id and r.created_at > now() - interval '30 days' group by 1) x),
                'laisse_pct_30j', (select case when count(*) >= 2 then round(avg(ps.left_pct))::int end from plate_scans ps
                    where ps.dish_id = d.id and not ps.before_meal and ps.service_date > public.today_abidjan() - 30),
                'note_7j', (select round(avg(r.stars), 1) from ratings r where r.dish_id = d.id and r.created_at > now() - interval '7 days'),
                'avis_recents', (select coalesce(jsonb_agg(left(x.comment, 140)), '[]') from (
                    select r.comment from ratings r where r.dish_id = d.id and length(trim(coalesce(r.comment, ''))) >= 8
                       and r.created_at > now() - interval '30 days' order by r.created_at desc limit 3) x),
                'cout_portion', (select coalesce(round(sum(rl.qty_per_portion * i.unit_cost)), 0) from recipe_lines rl join ingredients i on i.id = rl.ingredient_id where rl.dish_id = d.id),
                'ingredient_en_rupture', (select bool_or(i.stock_qty < i.alert_threshold) from recipe_lines rl join ingredients i on i.id = rl.ingredient_id where rl.dish_id = d.id)
              ) order by c.name, p.popularity desc)
              from dishes d join categories c on c.id = d.category_id join public._dish_popularity(p_week_start) p on p.dish_id = d.id
             where d.is_active),
    'repas_attendus', (select jsonb_agg(jsonb_build_object('jour_semaine', dow, 'service', service, 'moyenne', moy) order by dow, service)
                         from (select extract(isodow from t.service_date)::int dow, t.service, round(count(*)::numeric / 4) moy
                                 from tickets t where t.status = 'used' and t.service_date >= p_week_start - 28 and t.service_date < p_week_start
                                group by 1, 2) x),
    'menus_recents', (select jsonb_agg(jsonb_build_object('date', mi.service_date, 'service', mi.service, 'plat', d.name) order by mi.service_date)
                        from menu_items mi join menus m on m.id = mi.menu_id join dishes d on d.id = mi.dish_id
                       where mi.service_date between p_week_start - 14 and p_week_start - 1),
    'rapport_semaine_passee', (select jsonb_build_object('conseils', w -> 'advice',
                                 'a_garder', (select jsonb_agg(b ->> 'name') from jsonb_array_elements(w -> 'best') b),
                                 'a_revoir', (select jsonb_agg(b ->> 'name') from jsonb_array_elements(w -> 'worst') b))
                                 from (select public._weekly_report(p_week_start - 7) w) x));
end $$;
