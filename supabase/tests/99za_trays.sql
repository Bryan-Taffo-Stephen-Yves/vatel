-- Affluence par plateaux : repas servis dans les 25 dernières minutes, caméra éteinte ou allumée, plateaux tous sortis
begin;
select tests.setup();
select tests.as_service();
insert into public.rooms (name, total_tables) values ('Réfectoire', 20);
-- Déjeuner ouvert toute la journée et au menu aujourd'hui
update public.settings set value = jsonb_set(value, '{lunch}', (value -> 'lunch') || '{"start": "00:00", "end": "23:59"}') where key = 'services';
update public.settings set value = '{"total": 10, "meal_minutes": 25}' where key = 'trays';
insert into public.menu_items (menu_id, service_date, service, dish_id, price)
select m.id, public.today_abidjan(), 'lunch', d.id, 2500 from public.menus m, public.dishes d where d.name = 'Garba' limit 1;

-- Repas servis : 4 il y a moins de 25 min, 3 il y a plus longtemps (plateaux revenus)
insert into public.tickets (user_id, buyer_id, service, service_date, total, valid_from, valid_until, status, used_at)
select tests.uid('alice'), tests.uid('alice'), 'lunch', public.today_abidjan(), 2500, now() - interval '2 hours', now() + interval '2 hours', 'used', now() - (m || ' minutes')::interval
  from unnest(array[1, 5, 10, 20, 30, 40, 60]) m;

select tests.eq((public._trays_at(now()) ->> 'out')::int, 4, '4 plateaux en salle (repas des 25 dernières minutes)');
select tests.eq((public.occupancy_now() ->> 'source'), 'trays', 'caméra éteinte : affluence par les plateaux');
select tests.eq((public.occupancy_now() ->> 'rate')::numeric, 40::numeric, '4 / 10 plateaux = 40 %');
select tests.eq((public.occupancy_now() ->> 'level'), 'low', 'niveau calme');
select tests.eq((public.occupancy_now() ->> 'trays_out')::int, 4, 'plateaux sortis renvoyés à l''équipe');

-- Repas du personnel : un plateau aussi
insert into public.staff_meals (user_id, service_date, price, school_share, employee_share, created_at)
values (tests.uid('caisse'), public.today_abidjan(), 2500, 1500, 1000, now() - interval '3 minutes');
select tests.eq((public._trays_at(now()) ->> 'out')::int, 5, 'repas du personnel compté');

-- Caméra allumée : on garde la plus haute des deux mesures
insert into public.occupancy_snapshots (room_id, occupied_tables, total_tables, rate, people_count)
select id, 15, 20, 75, 60 from public.rooms;
select tests.eq((public.occupancy_now() ->> 'rate')::numeric, 75::numeric, 'caméra 75 % > plateaux 50 % : 75 %');
select tests.eq((public.occupancy_now() ->> 'source'), 'vision', 'source : caméra');
update public.occupancy_snapshots set rate = 20, occupied_tables = 4;
select tests.eq((public.occupancy_now() ->> 'rate')::numeric, 50::numeric, 'caméra 20 % < plateaux 50 % : 50 %');
select tests.eq((public.occupancy_now() ->> 'source'), 'vision+trays', 'source : caméra + plateaux');
delete from public.occupancy_snapshots;

-- Tous les plateaux sortis : attente probable jusqu'au retour du plus ancien
insert into public.tickets (user_id, buyer_id, service, service_date, total, valid_from, valid_until, status, used_at)
select tests.uid('bob'), tests.uid('bob'), 'lunch', public.today_abidjan(), 2500, now() - interval '2 hours', now() + interval '2 hours', 'used', now() - interval '2 minutes'
  from generate_series(1, 6);
select tests.ok((public.occupancy_now() ->> 'trays_full')::boolean, '11 repas pour 10 plateaux : tous sortis');
select tests.eq((public.occupancy_now() ->> 'level'), 'high', 'plateaux tous sortis : très plein');
select tests.eq((public.occupancy_now() ->> 'wait_source'), 'trays', 'attente liée aux plateaux');
select tests.eq((public.occupancy_now() ->> 'wait_min')::int, 5, 'le plus ancien plateau (il y a 20 min) revient dans 5 min');

-- Écran Affluence et réglage
select tests.login('chef');
select tests.ok(jsonb_array_length(public.admin_occupancy() -> 'trays_curve') > 0, 'courbe des plateaux sans caméra');
select tests.eq((public.admin_occupancy() -> 'trays' ->> 'total')::int, 10, 'réglage renvoyé à l''écran');
select tests.code(public.trays_configure(120, 25), 'FORBIDDEN', 'chef : ne change pas le nombre de plateaux');
select tests.login('admin');
select tests.code(public.trays_configure(0, 25), 'INVALID', 'au moins 1 plateau');
select tests.code(public.trays_configure(100, 2), 'INVALID', 'durée d''un repas trop courte');
select tests.ok((public.trays_configure(100, 25) ->> 'ok')::boolean, 'admin : 100 plateaux, 25 min');
select tests.as_anon();
select tests.throws($$select public._trays_at(now())$$, 'visiteur : fonction interne inaccessible');
select tests.login('alice');
select tests.ok(public.occupancy_now() ? 'status', 'élève : affluence toujours lisible');
rollback;
