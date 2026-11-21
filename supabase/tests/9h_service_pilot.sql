-- Pilote du service : état en direct, suggestions et actions en un toucher
begin;
select tests.setup();
select tests.as_service();
-- Dîner du jour du menu de test (demain), de 18h à 21h ; on regarde à 19h (il reste 120 min)
create temp table _s as select public.today_abidjan() + 1 d,
  (public.today_abidjan() + 1 + time '18:00')::timestamp at time zone 'Africa/Abidjan' t0,
  (public.today_abidjan() + 1 + time '21:00')::timestamp at time zone 'Africa/Abidjan' t1,
  (public.today_abidjan() + 1 + time '19:00')::timestamp at time zone 'Africa/Abidjan' t;
create function pg_temp.ticket(p_user text, p_item uuid, p_status text, p_used_ago int default null, p_order int default null, p_ready_ago int default null)
returns void language sql as $$
  insert into public.tickets (user_id, buyer_id, service, service_date, dish_id, total, valid_from, valid_until, status, used_at, order_no, prep_status, ready_at)
  select tests.uid(p_user), tests.uid(p_user), 'dinner', (select d from _s), (select dish_id from public.menu_items where id = p_item), 2500,
         (select t0 from _s), (select t1 from _s), p_status::public.ticket_status, (select t from _s) - make_interval(mins => p_used_ago), p_order,
         case when p_ready_ago is not null then 'ready' end, (select t from _s) - make_interval(mins => p_ready_ago)
$$;
-- Attiéké du soir : 40 vendus sur 50, 6 servis dans le dernier quart d'heure → il n'en restera plus vers 19h25
update public.menu_items set sold_qty = 40 where id = tests.item('attieke_dinner');
select pg_temp.ticket('alice', tests.item('attieke_dinner'), 'used', m) from unnest(array[2, 4, 6, 8, 10, 12]) m;
-- Bob a un ticket du soir pas encore utilisé ; une commande prête attend depuis 20 min
select pg_temp.ticket('bob', tests.item('vip_dinner'), 'valid');
select pg_temp.ticket('alice', tests.item('attieke_dinner'), 'valid', null, 7, 20);
-- Le Plateau VIP revient à moitié plein
insert into public.plate_scans (service_date, service, dish_id, left_pct, source)
select (select d from _s), 'dinner', (select dish_id from public.menu_items where id = tests.item('vip_dinner')), p, 'agent' from unnest(array[50, 60, 40]) p;

select public._pilot_state((select d from _s), 'dinner', (select t0 from _s), (select t1 from _s), (select t from _s)) as p \gset
select tests.eq(((:'p')::jsonb ->> 'minutes_left')::int, 120, 'il reste 120 min de service');
select tests.eq(((:'p')::jsonb ->> 'served_15')::int, 6, '6 repas servis dans le dernier quart d''heure');
select tests.ok(exists (select 1 from jsonb_array_elements((:'p')::jsonb -> 'suggestions') s where s ->> 'kind' = 'more'
  and s ->> 'ref' = tests.item('attieke_dinner')::text and (s ->> 'qty')::int = 40 and s ->> 'text' like 'Il n''en restera plus vers 19h25%'),
  'relancer 40 portions d''attiéké (il n''en restera plus vers 19h25)');
select tests.ok(exists (select 1 from jsonb_array_elements((:'p')::jsonb -> 'suggestions') s where s ->> 'kind' = 'push_dish'
  and s ->> 'ref' = tests.item('vip_dinner')::text and (s ->> 'qty')::int = 1), 'mettre en avant le Plateau VIP auprès de l''élève qui n''a pas encore mangé');
select tests.ok(exists (select 1 from jsonb_array_elements((:'p')::jsonb -> 'suggestions') s where s ->> 'kind' = 'remind_ready' and (s ->> 'qty')::int = 1),
  'relancer la commande prête depuis 20 min');
select tests.ok(exists (select 1 from jsonb_array_elements((:'p')::jsonb -> 'suggestions') s where s ->> 'kind' = 'left' and s ->> 'title' like '%50 % laissé'),
  'assiettes très laissées : conseil');
select tests.eq((:'p')::jsonb -> 'suggestions' -> 0 ->> 'kind', 'more', 'le plus urgent d''abord');

-- Actions
select tests.eq((public._pilot_do((select d from _s), 'dinner', 'more', tests.item('attieke_dinner')::text, 40, (select t from _s)) ->> 'done')::int, 40, 'relance : +40 portions');
select tests.eq((select planned_qty from public.menu_items where id = tests.item('attieke_dinner')), 90, 'portions prévues : 50 → 90');
select tests.eq((public._pilot_do((select d from _s), 'dinner', 'push_dish', tests.item('vip_dinner')::text, null, (select t from _s)) ->> 'done')::int, 1, 'mise en avant : 1 élève prévenu');
select tests.ok(exists (select 1 from public.notifications where user_id = tests.uid('bob') and type = 'chef_tip' and title like '🔥 %'), 'bob reçoit « 🔥 … t''attend »');
select tests.eq((public._pilot_do((select d from _s), 'dinner', 'remind_ready', 'ready', null, (select t from _s)) ->> 'done')::int, 1, 'commande prête : élève relancé');
select tests.ok(exists (select 1 from public.notifications where user_id = tests.uid('alice') and type = 'order_reminder' and body like 'À récupérer avant 21h00%'), 'alice : « À récupérer avant 21h00 »');
select tests.ok(public._pilot_do((select d from _s), 'dinner', 'queue', 'queue', null, (select t from _s)) ->> 'ok' = 'true', 'renfort : agents prévenus');
select tests.ok(exists (select 1 from public.notifications where user_id = tests.uid('agent') and type = 'staff_alert'), 'l''agent reçoit l''appel au renfort');
select tests.code(public._pilot_do((select d from _s), 'dinner', 'n_importe_quoi', null, null), 'BAD_KIND', 'action inconnue refusée');

-- Une action faite ou écartée ne revient pas pendant 20 min (et bob a déjà été prévenu)
select public._pilot_do((select d from _s), 'dinner', 'dismiss', 'left-x', null, (select t from _s));
select public._pilot_state((select d from _s), 'dinner', (select t0 from _s), (select t1 from _s), (select t from _s) + interval '1 minute') as p2 \gset
select tests.ok(not exists (select 1 from jsonb_array_elements((:'p2')::jsonb -> 'suggestions') s where s ->> 'kind' in ('more', 'push_dish', 'remind_ready', 'queue')),
  'les actions faites ne sont plus proposées');
select tests.eq(jsonb_array_length((:'p2')::jsonb -> 'recent'), 4, 'historique des actions du service');

-- Droits
select tests.login('alice');
select tests.code(public.pilot_state(), 'FORBIDDEN', 'élève : pas de pilote');
select tests.code(public.pilot_act('more', tests.item('attieke_dinner')::text, 5), 'FORBIDDEN', 'élève : pas d''action');
select tests.login('caisse');
select tests.ok(public.pilot_state() ->> 'ok' = 'true', 'caisse : voit le pilote');
select tests.code(public.pilot_act('more', tests.item('attieke_dinner')::text, 5), 'FORBIDDEN', 'caisse : ne relance pas de portions (cuisine seulement)');
rollback;
