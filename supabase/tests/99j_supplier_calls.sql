-- Agent qui appelle les fournisseurs : règles de décision, validation du chef, coursier, injoignable
begin;
select tests.setup();

select tests.login('alice');
select tests.code(public.supplier_order_create_demo('+2250700000001'), 'FORBIDDEN', 'client : pas de commande fournisseur');

select tests.login('chef');
select tests.code(public.supplier_order_create_demo('abc'), 'INVALID_PHONE', 'numéro invalide refusé');
select (public.supplier_order_create_demo('0700000001') ->> 'order_id')::uuid as o1 \gset
select tests.as_service();
select tests.eq((select call_phone from public.supplier_orders where id = :'o1'), '+2250700000001', 'numéro ivoirien complété (+225)');
select tests.eq((select budget from public.supplier_orders where id = :'o1'), 56000, 'budget = 20 poulets × 2 800 F');

-- 1. Prix dans la tolérance (+10 %) → commandé
select tests.ok((public._supplier_call_started(:'o1', 'call_1', 'simulation') ->> 'ok')::boolean, 'appel démarré');
select tests.code(public._supplier_call_started(:'o1', 'call_2', 'simulation'), 'ALREADY', 'pas deux appels en même temps');
select tests.eq(public._supplier_call_action(:'o1', 'record_quote', '{"total": 60000}') ->> 'decision', 'accepter', '60 000 F ≤ 61 600 F : accepté');
select tests.ok((public._supplier_call_action(:'o1', 'confirm_order', '{"delivery_at": "demain 9h", "delivery_mode": "fournisseur"}') ->> 'ok')::boolean, 'commande confirmée');
select tests.eq((select status from public.supplier_orders where id = :'o1'), 'commande', 'statut : commandé');
select public._supplier_call_ended(:'o1', 'Le fournisseur livre demain à 9h.', null, 'user_hangup');
select tests.eq((select status from public.supplier_orders where id = :'o1'), 'commande', 'fin d''appel : reste commandé');
select tests.ok(exists (select 1 from public.supply_events where order_id = :'o1' and message like '✅%60 000 F%demain 9h%'), 'événement : commande passée');
select tests.ok(exists (select 1 from public.notifications where user_id = tests.uid('chef') and type = 'supply_ordered'), 'chef prévenu');

-- 2. Trop cher → à valider, pas de confirmation possible, décision du chef
select tests.login('chef');
select (public.supplier_order_create_demo('+2250700000002', 'Grossiste Koné') ->> 'order_id')::uuid as o2 \gset
select tests.as_service();
select public._supplier_call_started(:'o2', 'call_3', 'simulation');
select tests.eq(public._supplier_call_action(:'o2', 'record_quote', '{"total": 120000}') ->> 'decision', 'verifier', 'trop cher : à vérifier');
select tests.ok(public._supplier_call_action(:'o2', 'confirm_order', '{}') ? 'erreur', 'confirmation refusée tant que le chef n''a pas validé');
select tests.eq((select status from public.supplier_orders where id = :'o2'), 'a_valider', 'statut : à valider');
select tests.login('alice');
select tests.code(public.supplier_order_decide(:'o2', true), 'FORBIDDEN', 'client : ne valide pas');
select tests.login('chef');
select tests.ok((public.supplier_order_decide(:'o2', true) ->> 'ok')::boolean, 'chef : prix accepté');
select tests.as_service();
select tests.eq((select status from public.supplier_orders where id = :'o2'), 'valide', 'statut : validé (à rappeler)');
select public._supplier_call_started(:'o2', 'call_3b', 'simulation');
select tests.eq(public._supplier_call_action(:'o2', 'record_quote', '{"total": 120000}') ->> 'decision', 'accepter', 'rappel : le prix validé par le chef passe');
select tests.eq(public._supply_items_text('[{"qty": 1, "label": "sacs de riz de 25 kg"}, {"qty": 1, "label": "plateaux de 30 œufs"}, {"qty": 2, "label": "sacs de riz"}]'),
  '1 sac de riz de 25 kg, 1 plateau de 30 œufs, 2 sacs de riz', 'singulier pour une seule unité');

-- 3. Ne livre pas → coursier → tournée créée
select tests.login('chef');
select (public.supplier_order_create_demo('+2250700000003') ->> 'order_id')::uuid as o3 \gset
select tests.as_service();
select public._supplier_call_started(:'o3', 'call_4', 'simulation');
select public._supplier_call_action(:'o3', 'record_quote', '{"total": 56000}');
select public._supplier_call_action(:'o3', 'cannot_deliver', '{"raison": "pas de moto"}');
select tests.eq((select status from public.supplier_orders where id = :'o3'), 'coursier', 'statut : coursier');
select tests.login('chef');
select (public.supplier_order_send_courier(:'o3') ->> 'run_id')::uuid as run \gset
select tests.as_service();
select tests.eq((select count(*) from public.delivery_items where run_id = :'run')::int, 1, 'tournée : 1 article à récupérer');
select tests.eq((select name from public.delivery_stops where run_id = :'run'), 'Boucherie Bamba', 'tournée : chez le bon fournisseur');

-- 4. Pas de réponse → injoignable ; 3 essais au plus
select tests.login('chef');
select (public.supplier_order_create_demo('+2250700000004') ->> 'order_id')::uuid as o4 \gset
select tests.as_service();
select public._supplier_call_started(:'o4', 'c5', 'simulation'); select public._supplier_call_ended(:'o4', null, null, 'no_answer');
select public._supplier_call_started(:'o4', 'c6', 'simulation'); select public._supplier_call_ended(:'o4', null, null, 'no_answer');
select public._supplier_call_started(:'o4', 'c7', 'simulation'); select public._supplier_call_ended(:'o4', null, null, 'no_answer');
select tests.eq((select status from public.supplier_orders where id = :'o4'), 'injoignable', 'sans réponse : injoignable');
select tests.code(public._supplier_call_started(:'o4', 'c8', 'simulation'), 'MAX_ATTEMPTS', 'pas de 4e essai');

-- Carnet de prix : commande libre, depuis le stock, mise à jour du dernier prix
select tests.ok((select count(*) from public.supplier_products) >= 4, 'carnet de prix rempli');
select tests.eq((select p.last_price from public.supplier_products p join public.suppliers s on s.id = p.supplier_id where s.name = 'Boucherie Bamba' and p.label like 'poulets entiers%'), 3000, 'dernier prix retenu : 60 000 / 20 = 3 000 F');
select tests.login('chef');
select (public.supplier_order_create((select id from public.suppliers where name = 'Marché de Cocody'),
  jsonb_build_array(jsonb_build_object('product_id', (select id from public.supplier_products where label = 'kg d''oignons' and supplier_id = (select id from public.suppliers where name = 'Marché de Cocody')), 'qty', 10))) ->> 'order_id')::uuid as o5 \gset
select tests.as_service();
select tests.eq((select budget from public.supplier_orders where id = :'o5'), 8000, 'commande libre depuis le carnet : 10 kg × 800 F');
update public.ingredients set stock_qty = 0, alert_threshold = 10 where name in (select name from public.ingredients limit 1);
select tests.login('chef');
select tests.ok((public.supplier_orders_from_stock('+2250700000009') ->> 'ok')::boolean, 'commandes depuis le stock bas');
select tests.login('chef');
select tests.code(public.supplier_product_set_price((select id from public.supplier_products limit 1), -5), 'INVALID', 'prix négatif refusé');

-- Numéro Retell : réglé par l'admin seulement
select tests.login('chef');
select tests.code(public.supplier_calls_set_number('+14155550123'), 'FORBIDDEN', 'chef : ne règle pas le numéro');
select tests.login('admin');
select tests.ok((public.supplier_calls_set_number('+14155550123') ->> 'ok')::boolean, 'admin : numéro réglé');
rollback;
