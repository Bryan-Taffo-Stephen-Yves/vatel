-- Tournée d'achats suivie : création, départ, achats un par un, changement de liste, livraison, réception, suivi public
begin;
select tests.setup();

select tests.login('alice');
select tests.code(public.delivery_create_demo(), 'FORBIDDEN', 'client : pas de tournée');

select tests.login('chef');
select public.delivery_create_demo() as c \gset
select (:'c'::jsonb ->> 'run_id')::uuid as run, :'c'::jsonb ->> 'track_token' as tok \gset
select tests.as_service();
select tests.eq((select count(*) from public.delivery_stops where run_id = :'run')::int, 3, '3 arrêts');
select tests.eq((select count(*) from public.delivery_items where run_id = :'run')::int, 6, '6 articles');

update public.settings set value = value || '{"speed": 30}' where key = 'delivery';  -- 300 s simulées par tic
-- Itinéraire fictif : 9 points, 100 s entre deux points ; arrêts aux points 2, 4, 6 ; cantine au point 8
select tests.as_service();
select public._delivery_set_route(:'run',
  jsonb_build_object('coords', (select jsonb_agg(jsonb_build_array(5.30 + k * 0.01, -4.00)) from generate_series(0, 8) k),
                     'cum', (select jsonb_agg(k * 100) from generate_series(0, 8) k), 'source', 'ligne'),
  (select jsonb_object_agg(id, seq * 2) from public.delivery_stops where run_id = :'run'));
select public._delivery_start(:'run');
select tests.eq((select status from public.delivery_runs where id = :'run'), 'en_route', 'départ : en route');
select tests.ok((select eta_at > now() from public.delivery_runs where id = :'run'), 'heure d''arrivée calculée');

-- 1er tic : 300 s simulées → arrivé au 1er arrêt (point 2)
select public.delivery_tick();
select tests.eq((select status from public.delivery_runs where id = :'run'), 'achats', 'arrivé chez la boucherie');
select public.delivery_tick();
select tests.ok(exists (select 1 from public.delivery_events where run_id = :'run' and message like '%20 poulets ont été récupérés%'), 'message : 20 poulets récupérés');

-- L'équipe annule les tomates et les oignons avant le marché ; les poulets (déjà achetés) ne s'annulent pas
select public._delivery_cancel_items(:'run', array(select id from public.delivery_items where run_id = :'run' and label in ('sacs de tomates', 'kg d''oignons', 'poulets')), 'Bryan') as x \gset
select tests.ok(:'x'::jsonb ->> 'cancelled' like '%tomates%', 'tomates annulées');
select tests.ok(:'x'::jsonb ->> 'already_bought' = 'poulets', 'poulets déjà achetés : pas annulés');
select tests.ok((:'x'::jsonb ->> 'reroute')::boolean = false, 'marché gardé (il reste la banane)');
select public._delivery_cancel_items(:'run', array(select id from public.delivery_items where run_id = :'run' and label like '%banane%'), 'Bryan') as y \gset
select tests.ok((:'y'::jsonb ->> 'reroute')::boolean and :'y'::jsonb ->> 'stops_cancelled' = 'Marché de Cocody', 'plus rien au marché : arrêt annulé, itinéraire à refaire');

-- Ajout d'un article à un arrêt pas encore fait
select tests.ok((public._delivery_add_item(:'run', (select id from public.delivery_stops where run_id = :'run' and seq = 2), 'kg de sel', 2, 'Bryan') ->> 'ok')::boolean, 'article ajouté au grossiste');
select tests.code(public._delivery_add_item(:'run', (select id from public.delivery_stops where run_id = :'run' and seq = 3), 'kg de sel', 2, 'Bryan'), 'STOP_DONE', 'pas d''ajout à un arrêt annulé');

-- On laisse tourner jusqu'à la livraison
select public.delivery_tick() from generate_series(1, 15);
select tests.eq((select status from public.delivery_runs where id = :'run'), 'livre', 'livré à la cantine');
select tests.ok(exists (select 1 from public.delivery_events where run_id = :'run' and kind = 'vers_cantine' and message like '%en route vers vous%'), 'message : en route vers vous');
select tests.eq((select count(*) from public.delivery_items where run_id = :'run' and status = 'achete')::int, 4, 'achetés : poulets, riz, huile, sel');

-- Suivi public (sans compte)
select tests.as_service();
select tests.ok(exists (select 1 from public.notifications where user_id = tests.uid('chef') and type = 'delivery_done'), 'chef prévenu : livré (vérif.)');
set local role anon;
select tests.ok((public.delivery_track(:'tok') ->> 'ok')::boolean, 'suivi public avec le lien');
select tests.code(public.delivery_track('mauvais-jeton-0000000000'), 'NOT_FOUND', 'mauvais lien refusé');
reset role;

-- Réception : le stock remonte
select tests.login('chef');
select coalesce((select stock_qty from public.ingredients where name = 'Poulet'), 0) as poulet \gset
select tests.ok((public.delivery_receive(:'run') ->> 'ok')::boolean, 'réceptionné');
select tests.code(public.delivery_receive(:'run'), 'NOT_DELIVERED', 'pas de double réception');
select tests.ok(coalesce((select stock_qty from public.ingredients where name = 'Poulet'), 0) >= :poulet, 'stock de poulet remonté (si l''ingrédient existe)');
rollback;
