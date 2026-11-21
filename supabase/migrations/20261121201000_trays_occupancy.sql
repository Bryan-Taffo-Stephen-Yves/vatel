-- Affluence par plateaux : la cantine a un nombre fixe de plateaux (100) ; un plateau sort à chaque repas servi et
-- revient environ 25 min plus tard. Plateaux en salle = repas servis (tickets, personnel) dans les 25 dernières minutes.
--  · caméra éteinte : l'affluence = plateaux en salle / plateaux ;
--  · caméra allumée : on garde la plus haute des deux mesures (la caméra voit les tables, les plateaux voient les repas) ;
--  · tous les plateaux sortis : « Attente probable », jusqu'au retour du plus ancien plateau.
-- L'équipe voit « 80 plateaux sur 100 » ; les élèves voient un niveau (« Il y a du monde »), pas de chiffre de plateaux.

insert into public.settings (key, value) values ('trays', '{"total": 100, "meal_minutes": 25}') on conflict (key) do nothing;

create index if not exists tickets_used_at_idx on public.tickets (used_at) where used_at is not null;

-- Moments où un plateau est sorti (repas servis : tickets et repas du personnel)
create or replace function public._tray_outs(p_from timestamptz, p_to timestamptz) returns table (at timestamptz)
language sql stable security definer set search_path = public, pg_temp as $$
  select used_at from public.tickets where used_at >= p_from and used_at < p_to
  union all
  select created_at from public.staff_meals where created_at >= p_from and created_at < p_to
$$;

-- Plateaux en salle à un instant donné
create or replace function public._trays_at(p_at timestamptz default now()) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_total int := greatest(1, coalesce((public.setting('trays') ->> 'total')::int, 100));
  v_min int := greatest(5, coalesce((public.setting('trays') ->> 'meal_minutes')::int, 25));
  v_out int; v_oldest timestamptz;
begin
  select count(*), min(at) into v_out, v_oldest from public._tray_outs(p_at - make_interval(mins => v_min), p_at);
  return jsonb_build_object('out', least(v_out, v_total), 'total', v_total, 'meal_minutes', v_min,
    'rate', round(100.0 * least(v_out, v_total) / v_total),
    'full', v_out >= v_total,
    -- tous sortis : le plus ancien plateau revient au bout de « meal_minutes »
    'free_in_min', case when v_out >= v_total then greatest(1, ceil(extract(epoch from (v_oldest + make_interval(mins => v_min) - p_at)) / 60))::int end);
end $$;

create or replace function public.occupancy_now(p_room_id uuid default null) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_room public.rooms;
  v_snap public.occupancy_snapshots;
  v_scans int;
  v_rate numeric;
  v_source text;
  v_today date := public.today_abidjan();
  v_svc public.service_kind;
  v_win record;
  v_next jsonb;
  v_trays jsonb;
  v_wait int;
begin
  select * into v_room from public.rooms where p_room_id is null or id = p_room_id order by name limit 1;
  if not found then return jsonb_build_object('status', 'unknown'); end if;

  foreach v_svc in array enum_range(null::public.service_kind) loop
    select * into v_win from public.service_window(v_today, v_svc);
    exit when v_win.starts_at is not null and now() between v_win.starts_at and v_win.ends_at
              and public._service_on_menu(v_today, v_svc);
    v_win := null;
  end loop;

  if v_win is null then
    select jsonb_build_object('service', mi.service, 'starts_at', w.starts_at) into v_next
      from menu_items mi join menus m on m.id = mi.menu_id
      cross join lateral public.service_window(mi.service_date, mi.service) w
     where m.status = 'published' and mi.service_date between v_today and v_today + 7 and w.starts_at > now()
     order by w.starts_at limit 1;
    return jsonb_build_object('status', 'closed', 'room', v_room.name, 'next', v_next);
  end if;

  select count(*) into v_scans from public.tickets where used_at > now() - interval '10 minutes';
  v_trays := public._trays_at(now());
  select * into v_snap from public.occupancy_snapshots
   where room_id = v_room.id and created_at > now() - interval '2 minutes' order by created_at desc limit 1;
  if found then
    v_rate := greatest(v_snap.rate, (v_trays ->> 'rate')::numeric);
    v_source := case when (v_trays ->> 'rate')::numeric > v_snap.rate then 'vision+trays' else 'vision' end;
  else
    v_rate := (v_trays ->> 'rate')::numeric; v_source := 'trays';
  end if;

  -- Attente : file vue par la caméra ; plateaux tous sortis → retour du plus ancien plateau ; sinon estimation
  v_wait := case when v_snap.queue_count is not null then public._queue_wait_min(v_snap.queue_count, v_scans)
                 when (v_trays ->> 'full')::boolean then (v_trays ->> 'free_in_min')::int
                 else greatest(0, round(greatest(v_rate - 40, 0) / 5 + v_scans / 6.0))::int end;
  if v_snap.queue_count is not null and (v_trays ->> 'full')::boolean then v_wait := greatest(v_wait, (v_trays ->> 'free_in_min')::int); end if;

  return jsonb_build_object(
    'status', 'open', 'room', v_room.name, 'service', v_svc, 'rate', v_rate,
    'queue_count', v_snap.queue_count,
    'level', case when (v_trays ->> 'full')::boolean or v_rate > 80 then 'high' when v_rate >= 50 then 'mid' else 'low' end,
    'occupied_tables', coalesce(v_snap.occupied_tables, round(v_rate * v_room.total_tables / 100)),
    'total_tables', v_room.total_tables,
    'trays_out', (v_trays ->> 'out')::int, 'trays_total', (v_trays ->> 'total')::int, 'trays_full', (v_trays ->> 'full')::boolean,
    'wait_min', v_wait,
    'wait_source', case when v_snap.queue_count is not null then 'queue' when (v_trays ->> 'full')::boolean then 'trays' else 'estimate' end,
    'source', v_source, 'updated_at', coalesce(v_snap.created_at, now()));
end $$;

-- Écran Affluence : courbe et heures de pointe aussi sans caméra (plateaux toutes les 10 min pendant les services)
create or replace function public.admin_occupancy(p_date date default null) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  d date := coalesce(p_date, public.today_abidjan());
  v_room public.rooms;
  v_total int := greatest(1, coalesce((public.setting('trays') ->> 'total')::int, 100));
  v_min int := greatest(5, coalesce((public.setting('trays') ->> 'meal_minutes')::int, 25));
begin
  if not public.has_role('caissier', 'chef') then raise exception 'forbidden' using errcode = '42501'; end if;
  select * into v_room from rooms order by name limit 1;
  return jsonb_build_object(
    'room', to_jsonb(v_room),
    'now', public.occupancy_now(v_room.id),
    'trays', jsonb_build_object('total', v_total, 'meal_minutes', v_min),
    'last', (select to_jsonb(s) from occupancy_snapshots s where room_id = v_room.id order by created_at desc limit 1),
    'curve', (select coalesce(jsonb_agg(jsonb_build_object('t', created_at, 'rate', rate, 'people', people_count) order by created_at), '[]')
                from occupancy_snapshots where room_id = v_room.id
                 and created_at >= d::timestamp at time zone 'Africa/Abidjan' and created_at < (d + 1)::timestamp at time zone 'Africa/Abidjan'),
    'trays_curve', (select coalesce(jsonb_agg(jsonb_build_object('t', p.t, 'out', p.n, 'rate', round(100.0 * least(p.n, v_total) / v_total)) order by p.t), '[]')
                from (select g.t, (select count(*) from public._tray_outs(g.t - make_interval(mins => v_min), g.t)) n
                        from unnest(enum_range(null::public.service_kind)) sv(s)
                             cross join lateral public.service_window(d, sv.s) w
                             cross join lateral
                             generate_series(w.starts_at, least(w.ends_at + make_interval(mins => v_min), now()), interval '10 minutes') g(t)
                       where public._service_on_menu(d, sv.s)) p),
    'peaks', (select coalesce(jsonb_agg(jsonb_build_object('dow', dow, 'h', hh, 'rate', rate)), '[]') from (
                select extract(isodow from created_at at time zone 'Africa/Abidjan')::int dow,
                       extract(hour from created_at at time zone 'Africa/Abidjan')::int hh, round(avg(rate)) rate
                  from occupancy_snapshots where room_id = v_room.id and created_at > now() - interval '28 days'
                 group by 1, 2) x),
    -- Sans caméra : pointes estimées avec les plateaux (moyenne par jour de semaine et par heure, 4 semaines)
    'trays_peaks', (select coalesce(jsonb_agg(jsonb_build_object('dow', dow, 'h', hh, 'rate', rate)), '[]') from (
                select extract(isodow from g.t at time zone 'Africa/Abidjan')::int dow, extract(hour from g.t at time zone 'Africa/Abidjan')::int hh,
                       round(avg(100.0 * least((select count(*) from public._tray_outs(g.t - make_interval(mins => v_min), g.t)), v_total) / v_total)) rate
                  from generate_series(public.today_abidjan() - 28, public.today_abidjan() - 1, interval '1 day') dd(day)
                       cross join unnest(enum_range(null::public.service_kind)) sv(s)
                       cross join lateral public.service_window(dd.day::date, sv.s) w
                       cross join lateral generate_series(w.starts_at, w.ends_at, interval '20 minutes') g(t)
                 where public._service_on_menu(dd.day::date, sv.s)
                 group by 1, 2) x));
end $$;

-- Réglage (admin) : nombre de plateaux et durée moyenne d'un repas
create or replace function public.trays_configure(p_total int, p_meal_minutes int) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not public.has_role('admin') then return public._fail('FORBIDDEN', 'Réservé à l''administrateur.'); end if;
  if p_total is null or p_total not between 1 and 5000 then return public._fail('INVALID', 'Nombre de plateaux : de 1 à 5 000.'); end if;
  if p_meal_minutes is null or p_meal_minutes not between 5 and 120 then return public._fail('INVALID', 'Durée d''un repas : de 5 à 120 minutes.'); end if;
  update public.settings set value = jsonb_build_object('total', p_total, 'meal_minutes', p_meal_minutes) where key = 'trays';
  perform public._audit('trays_configure', 'trays', jsonb_build_object('total', p_total, 'meal_minutes', p_meal_minutes));
  return jsonb_build_object('ok', true);
end $$;

revoke all on function public._tray_outs(timestamptz, timestamptz), public._trays_at(timestamptz) from public, anon, authenticated;
grant execute on function public._tray_outs(timestamptz, timestamptz), public._trays_at(timestamptz) to service_role;
revoke all on function public.trays_configure(int, int) from public, anon;
grant execute on function public.trays_configure(int, int) to authenticated;
