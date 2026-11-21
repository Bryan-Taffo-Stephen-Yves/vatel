-- Pilote du service : pendant un service, l'écran cuisine (Admin → Pilote) lit en direct le rythme du comptoir,
-- les portions restantes, la file d'attente (caméra / plateaux, via occupancy_now), les commandes prêtes non
-- récupérées et les assiettes laissées, et propose 1 à 5 actions qu'on lance d'un toucher :
--   more         relancer N portions d'un plat qui va manquer avant la fin
--   push_dish    prévenir les élèves qui n'ont pas encore mangé qu'un plat est prêt tout de suite (plat qui risque de rester)
--   queue        appeler un renfort au comptoir (file longue)
--   remind_ready relancer les élèves dont la commande est prête depuis plus de 10 min
--   left         plat très laissé dans l'assiette aujourd'hui (conseil, « Vu »)
-- Une action faite ou écartée ne revient pas pendant 20 min. Aucun prix ni paiement n'est touché.

create table if not exists public.pilot_actions (
  id           bigserial primary key,
  service_date date not null,
  service      public.service_kind not null,
  kind         text not null check (kind in ('more', 'push_dish', 'queue', 'remind_ready', 'left', 'dismiss')),
  ref          text,                 -- menu_item_id, ou clé de la suggestion écartée
  qty          int,
  done         int,                  -- portions ajoutées / personnes prévenues
  created_by   uuid references public.profiles (id) on delete set null,
  created_at   timestamptz not null default now()
);
create index if not exists pilot_actions_day on public.pilot_actions (service_date, service, created_at desc);
alter table public.pilot_actions enable row level security;
revoke all on public.pilot_actions from public, anon, authenticated;

-- Service en cours (même règle que occupancy_now : fenêtre du service ET service au menu du jour)
create or replace function public._pilot_service(p_at timestamptz default now(), out service public.service_kind, out starts_at timestamptz, out ends_at timestamptz)
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v public.service_kind; w record; d date := (p_at at time zone 'Africa/Abidjan')::date;
begin
  foreach v in array enum_range(null::public.service_kind) loop
    select * into w from public.service_window(d, v);
    if w.starts_at is not null and p_at between w.starts_at and w.ends_at and public._service_on_menu(d, v) then
      service := v; starts_at := w.starts_at; ends_at := w.ends_at; return;
    end if;
  end loop;
end $$;

-- État + suggestions pour un service donné à un instant donné (testable ; sans contrôle de rôle, non exposée)
create or replace function public._pilot_state(p_date date, p_service public.service_kind, p_starts timestamptz, p_ends timestamptz, p_at timestamptz default now())
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_left_min numeric := greatest(0, extract(epoch from (p_ends - p_at)) / 60);
  v_elapsed numeric := greatest(1, extract(epoch from (p_at - p_starts)) / 60);
  v_items jsonb; v_occ jsonb; v_ready jsonb; v_sugg jsonb := '[]'; v_targets int; r record; v_queue int; v_wait int;
begin
  -- Plats du service : restant, rythme (servis sur 15 min, sinon depuis le début), heure à laquelle il n'en restera plus
  with it as (
    select mi.id, d.name, d.photo_url, mi.planned_qty planned, mi.sold_qty sold, mi.is_sold_out sold_out,
           case when mi.planned_qty is null then null else greatest(mi.planned_qty - mi.sold_qty, 0) end remaining,
           (select count(*) from tickets t where t.service_date = p_date and t.service = p_service and t.dish_id = mi.dish_id
               and t.status = 'used' and t.used_at > p_at - interval '15 minutes' and t.used_at <= p_at) served_15,
           (select count(*) from tickets t where t.service_date = p_date and t.service = p_service and t.dish_id = mi.dish_id
               and t.status = 'used' and t.used_at <= p_at) served,
           (select case when count(*) >= 3 then round(avg(ps.left_pct))::int end from plate_scans ps
             where ps.dish_id = mi.dish_id and ps.service_date = p_date and not ps.before_meal) left_pct,
           (select count(*) from plate_scans ps where ps.dish_id = mi.dish_id and ps.service_date = p_date and not ps.before_meal) scans
      from menu_items mi join dishes d on d.id = mi.dish_id
     where mi.service_date = p_date and mi.service = p_service
  ), rated as (
    select it.*, round(case when it.served_15 >= 3 then it.served_15 / 15.0 else it.served / v_elapsed end, 2) rate from it
  )
  select coalesce(jsonb_agg(to_jsonb(x) order by x.runout_min nulls last, x.name), '[]') into v_items from (
    select rated.*,
           case when rate > 0 and remaining is not null then round(remaining / rate)::int end runout_min,
           ceil(rate * v_left_min)::int need
      from rated) x;

  v_occ := public.occupancy_now();
  v_queue := nullif(v_occ ->> 'queue_count', '')::int;
  v_wait := nullif(v_occ ->> 'wait_min', '')::int;

  -- Commandes prêtes depuis plus de 10 min, pas encore récupérées
  select jsonb_build_object('n', count(*), 'ids', coalesce(jsonb_agg(id), '[]')) into v_ready from tickets
   where service_date = p_date and service = p_service and status = 'valid' and prep_status = 'ready' and ready_at < p_at - interval '10 minutes';

  -- 1. Un plat va manquer avant la fin du service : relancer
  for r in select * from jsonb_to_recordset(v_items) as x(id uuid, name text, remaining int, rate numeric, need int, runout_min int)
           where x.remaining is not null and x.rate > 0 and x.runout_min < v_left_min - 10 loop
    v_sugg := v_sugg || jsonb_build_object('kind', 'more', 'ref', r.id, 'priority', 1,
      'qty', least(100, greatest(5, (ceil((r.need - r.remaining) / 5.0) * 5)::int)),
      'title', 'Relancer : ' || r.name,
      'text', case when r.remaining = 0 then 'Il n''en reste plus et le comptoir en sert ' || round(r.rate * 15) || ' toutes les 15 min.'
                   else 'Il n''en restera plus vers ' || to_char((p_at + make_interval(mins => r.runout_min)) at time zone 'Africa/Abidjan', 'HH24"h"MI')
                        || ' (' || r.remaining || ' restantes, ' || round(r.rate * 15) || ' servies / 15 min).' end);
  end loop;

  -- 2. Un plat risque de rester : prévenir les élèves qui n'ont pas encore mangé (ticket du service pas encore utilisé)
  select count(distinct user_id) into v_targets from tickets
   where service_date = p_date and service = p_service and status = 'valid' and order_no is null;
  if v_left_min >= 20 and v_targets > 0 then
    for r in select * from jsonb_to_recordset(v_items) as x(id uuid, name text, remaining int, rate numeric, need int, sold_out boolean)
             where x.remaining >= 10 and not x.sold_out and x.need < x.remaining * 0.6 order by x.remaining desc limit 1 loop
      v_sugg := v_sugg || jsonb_build_object('kind', 'push_dish', 'ref', r.id, 'priority', 3, 'qty', v_targets,
        'title', 'Mettre en avant : ' || r.name,
        'text', r.remaining || ' portions risquent de rester. Prévenir les ' || v_targets || ' élèves qui n''ont pas encore mangé ?');
    end loop;
  end if;

  -- 3. File longue : renfort au comptoir
  if coalesce(v_queue, 0) >= 10 or coalesce(v_wait, 0) >= 8 then
    v_sugg := v_sugg || jsonb_build_object('kind', 'queue', 'ref', 'queue', 'priority', 2, 'qty', v_queue,
      'title', 'File longue au comptoir',
      'text', coalesce(v_queue || ' personnes dans la file', 'Beaucoup de monde') || coalesce(', ~' || v_wait || ' min d''attente', '') || '. Appeler un renfort ?');
  end if;

  -- 4. Commandes prêtes qui attendent : relancer les élèves
  if (v_ready ->> 'n')::int > 0 then
    v_sugg := v_sugg || jsonb_build_object('kind', 'remind_ready', 'ref', 'ready', 'priority', 2, 'qty', (v_ready ->> 'n')::int,
      'title', (v_ready ->> 'n') || ' commande' || case when (v_ready ->> 'n')::int > 1 then 's prêtes attendent' else ' prête attend' end,
      'text', 'Prête' || case when (v_ready ->> 'n')::int > 1 then 's' else '' end || ' depuis plus de 10 min. Relancer ' || case when (v_ready ->> 'n')::int > 1 then 'les élèves' else 'l''élève' end || ' ?');
  end if;

  -- 5. Assiettes très laissées aujourd'hui
  for r in select * from jsonb_to_recordset(v_items) as x(id uuid, name text, left_pct int, scans int) where x.left_pct >= 35 loop
    v_sugg := v_sugg || jsonb_build_object('kind', 'left', 'ref', r.id, 'priority', 4,
      'title', r.name || ' : ' || r.left_pct || ' % laissé',
      'text', 'Sur ' || r.scans || ' assiettes rendues aujourd''hui. Goûter l''assaisonnement ou réduire la portion.');
  end loop;

  -- Ce qui a été fait ou écarté il y a moins de 20 min ne revient pas
  select coalesce(jsonb_agg(s order by (s ->> 'priority')::int), '[]') into v_sugg from jsonb_array_elements(v_sugg) s
   where not exists (select 1 from pilot_actions a where a.service_date = p_date and a.service = p_service
                       and a.created_at > p_at - interval '20 minutes' and a.ref = s ->> 'ref'
                       and (a.kind = s ->> 'kind' or a.kind = 'dismiss'));

  return jsonb_build_object('ok', true, 'status', 'open', 'service', p_service, 'date', p_date,
    'starts_at', p_starts, 'ends_at', p_ends, 'minutes_left', round(v_left_min)::int,
    'served', (select count(*) from tickets where service_date = p_date and service = p_service and status = 'used' and used_at <= p_at),
    'served_15', (select count(*) from tickets where service_date = p_date and service = p_service and status = 'used' and used_at > p_at - interval '15 minutes' and used_at <= p_at),
    'queue_count', v_queue, 'wait_min', v_wait, 'level', v_occ ->> 'level',
    'ready_waiting', (v_ready ->> 'n')::int, 'items', v_items, 'suggestions', v_sugg,
    'recent', (select coalesce(jsonb_agg(jsonb_build_object('kind', kind, 'qty', qty, 'done', done, 'at', created_at) order by created_at desc), '[]')
                 from (select * from pilot_actions where service_date = p_date and service = p_service and kind <> 'dismiss' order by created_at desc limit 5) a));
end $$;

-- Écran Pilote (chef, caisse, admin)
create or replace function public.pilot_state() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare s record;
begin
  if not public.has_role('chef', 'caissier') then return public._fail('FORBIDDEN', 'Réservé à la cuisine et à l''administration.'); end if;
  select * into s from public._pilot_service(now());
  if s.service is null then
    return jsonb_build_object('ok', true, 'status', 'closed', 'next', public.occupancy_now() -> 'next');
  end if;
  return public._pilot_state(public.today_abidjan(), s.service, s.starts_at, s.ends_at, now());
end $$;

-- Lancer une action proposée : _pilot_do agit sur un service donné (testable), pilot_act sur le service en cours
create or replace function public._pilot_do(p_date date, p_service public.service_kind, p_kind text, p_ref text, p_qty int, p_at timestamptz default now())
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_date date := p_date; s record; v_done int := 0; v_item record; u record; v_queue int;
begin
  select p_service as service into s;

  if p_kind = 'more' then
    if coalesce(p_qty, 0) not between 1 and 200 then return public._fail('BAD_QTY', 'Entre 1 et 200 portions.'); end if;
    update menu_items set planned_qty = coalesce(planned_qty, sold_qty) + p_qty, is_sold_out = false
     where id = p_ref::uuid and service_date = v_date and service = s.service returning id into v_item;
    if not found then return public._fail('NOT_FOUND', 'Plat introuvable pour ce service.'); end if;
    v_done := p_qty;

  elsif p_kind = 'push_dish' then
    select d.name into v_item from menu_items mi join dishes d on d.id = mi.dish_id where mi.id = p_ref::uuid and mi.service_date = v_date;
    if not found then return public._fail('NOT_FOUND', 'Plat introuvable pour ce service.'); end if;
    for u in select distinct user_id from tickets where service_date = v_date and service = s.service and status = 'valid' and order_no is null loop
      perform public._notify(u.user_id, 'chef_tip', '🔥 ' || v_item.name || ' t''attend', 'Prêt tout de suite au comptoir, sans attente.',
        jsonb_build_object('href', '/app/menu'));
      v_done := v_done + 1;
    end loop;

  elsif p_kind = 'queue' then
    v_queue := nullif(public.occupancy_now() ->> 'queue_count', '')::int;
    for u in select id from profiles where role in ('agent', 'caissier') and not is_blocked loop
      perform public._notify(u.id, 'staff_alert', 'Renfort au comptoir 🙋', coalesce(v_queue || ' personnes dans la file. ', '') || 'Viens aider au comptoir.',
        jsonb_build_object('href', '/scan'));
      v_done := v_done + 1;
    end loop;

  elsif p_kind = 'remind_ready' then
    for u in select id, user_id, valid_until from tickets where service_date = v_date and service = s.service and status = 'valid'
              and prep_status = 'ready' and ready_at < p_at - interval '10 minutes' loop
      perform public._notify(u.user_id, 'order_reminder', 'Ta commande t''attend 🍽️',
        'À récupérer avant ' || to_char(u.valid_until at time zone 'Africa/Abidjan', 'HH24"h"MI') || '.',
        jsonb_build_object('ticket_id', u.id, 'href', '/app/tickets/' || u.id));
      v_done := v_done + 1;
    end loop;

  elsif p_kind not in ('left', 'dismiss') then
    return public._fail('BAD_KIND', 'Action inconnue.');
  end if;

  insert into pilot_actions (service_date, service, kind, ref, qty, done, created_by, created_at)
  values (v_date, s.service, p_kind, p_ref, p_qty, v_done, auth.uid(), p_at);
  perform public._audit('pilot_' || p_kind, coalesce(p_ref, ''), jsonb_build_object('qty', p_qty, 'done', v_done));
  return jsonb_build_object('ok', true, 'done', v_done);
end $$;

create or replace function public.pilot_act(p_kind text, p_ref text default null, p_qty int default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare s record;
begin
  if not public.has_role('chef', 'caissier') then return public._fail('FORBIDDEN', 'Réservé à la cuisine et à l''administration.'); end if;
  select * into s from public._pilot_service(now());
  if p_kind = 'more' and not public.has_role('chef') then return public._fail('FORBIDDEN', 'Seule la cuisine relance des portions.'); end if;
  if s.service is null then return public._fail('CLOSED', 'Aucun service en cours.'); end if;
  return public._pilot_do(public.today_abidjan(), s.service, p_kind, p_ref, p_qty, now());
end $$;

revoke all on function public._pilot_service(timestamptz), public._pilot_state(date, public.service_kind, timestamptz, timestamptz, timestamptz),
  public._pilot_do(date, public.service_kind, text, text, int, timestamptz) from public, anon, authenticated;
revoke all on function public.pilot_state(), public.pilot_act(text, text, int) from public, anon;
grant execute on function public.pilot_state(), public.pilot_act(text, text, int) to authenticated;
grant execute on function public._pilot_service(timestamptz), public._pilot_state(date, public.service_kind, timestamptz, timestamptz, timestamptz),
  public._pilot_do(date, public.service_kind, text, text, int, timestamptz) to service_role;
