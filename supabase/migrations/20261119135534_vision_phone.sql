-- Caméra d'affluence sur téléphone : le téléphone (compte agent/admin connecté) détecte les personnes lui-même
-- et n'envoie que des NOMBRES. Aucune image ne quitte le téléphone, aucune clé secrète n'y est stockée.
alter table public.occupancy_snapshots add column if not exists seats_total int check (seats_total >= 0);
alter table public.occupancy_snapshots add column if not exists seats_free int check (seats_free >= 0);

create or replace function public.vision_report(p_people int, p_occupied int, p_total int, p_queue int, p_counter int,
                                                p_seats_total int, p_seats_free int, p_table_states jsonb default '{}')
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_room public.rooms;
begin
  if not public.has_role('agent') then return public._fail('FORBIDDEN', 'Compte agent requis.'); end if;
  select * into v_room from public.rooms order by name limit 1;   -- même salle que occupancy_now()
  if not found then return public._fail('NO_ROOM', 'Aucune salle configurée.'); end if;
  -- Au plus un relevé toutes les 5 secondes
  if exists (select 1 from occupancy_snapshots where room_id = v_room.id and created_at > now() - interval '5 seconds') then
    return jsonb_build_object('ok', true, 'skipped', true);
  end if;
  insert into occupancy_snapshots (room_id, occupied_tables, total_tables, rate, people_count, table_states, queue_count, counter_count, seats_total, seats_free)
  values (v_room.id, greatest(0, least(coalesce(p_occupied, 0), greatest(coalesce(p_total, 1), 1))), greatest(coalesce(p_total, 1), 1),
          case when coalesce(p_total, 0) > 0 then round(100.0 * least(coalesce(p_occupied, 0), p_total) / p_total, 2) else 0 end,
          greatest(coalesce(p_people, 0), 0), coalesce(p_table_states, '{}'), greatest(coalesce(p_queue, 0), 0), greatest(coalesce(p_counter, 0), 0),
          nullif(greatest(coalesce(p_seats_total, 0), 0), 0), case when coalesce(p_seats_total, 0) > 0 then greatest(least(coalesce(p_seats_free, 0), p_seats_total), 0) end);
  return jsonb_build_object('ok', true, 'occupancy', public.occupancy_now(v_room.id));
end $$;
revoke all on function public.vision_report(int, int, int, int, int, int, int, jsonb) from public, anon;
grant execute on function public.vision_report(int, int, int, int, int, int, int, jsonb) to authenticated;
