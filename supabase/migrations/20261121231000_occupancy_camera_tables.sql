-- Affluence : quand la caméra tourne, le total de tables est celui qu'elle suit (ex. « 4/5 tables »),
-- et non celui du plan de salle (20) : l'appli élève affichait « 4/20 tables ». Seule la ligne total_tables change.

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
    'total_tables', coalesce(v_snap.total_tables, v_room.total_tables),
    'trays_out', (v_trays ->> 'out')::int, 'trays_total', (v_trays ->> 'total')::int, 'trays_full', (v_trays ->> 'full')::boolean,
    'wait_min', v_wait,
    'wait_source', case when v_snap.queue_count is not null then 'queue' when (v_trays ->> 'full')::boolean then 'trays' else 'estimate' end,
    'source', v_source, 'updated_at', coalesce(v_snap.created_at, now()));
end $$;
