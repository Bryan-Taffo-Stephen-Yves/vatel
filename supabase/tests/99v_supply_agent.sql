-- Agent d'achats autonome : besoins, choix du fournisseur, relances, secours, accord de l'équipe, manquants, coursier, réception
begin;
select tests.setup();
select tests.as_service();
insert into public.ingredients (name, unit, stock_qty, alert_threshold, unit_cost) values
  ('Riz', 'kg', 10, 20, 600), ('Huile', 'L', 30, 8, 1400), ('Sucre', 'kg', 30, 4, 800),
  ('Tomate', 'kg', 30, 8, 700), ('Oignon', 'kg', 30, 6, 600);
select public._supply_link_products();
select tests.eq((select count(*) from public.supplier_products p join public.ingredients i on i.id = p.ingredient_id where i.name = 'Riz')::int, 3,
  'carnet relié : riz chez le grossiste habituel + 2 secours');

-- Éteint par défaut
select tests.eq(public.supply_agent_tick() ->> 'enabled', 'false', 'éteint : l''agent ne fait rien');

-- Droits et réglages
select tests.login('alice');
select tests.code(public.supply_agent_overview(), 'FORBIDDEN', 'client : pas d''accès à l''agent');
select tests.code(public.supply_agent_configure('{"enabled": true}'), 'FORBIDDEN', 'client : ne règle pas l''agent');
select tests.login('chef');
select tests.code(public.supply_agent_configure('{"mode": "reel"}'), 'NOT_READY', 'mode réel refusé sans agent vocal ni numéro');
select tests.code(public.supply_agent_configure('{"horizon_days": 9}'), 'INVALID', 'horizon hors limites');
select tests.code(public.supply_agent_configure('{"auto_limit": "abc"}'), 'INVALID', 'plafond illisible');
select tests.code(public.supply_agent_configure('{"demo_phone": "abc"}'), 'INVALID_PHONE', 'numéro de démo invalide');
select tests.ok((public.supply_agent_configure('{"enabled": true, "demo_phone": "0700000001", "auto_limit": 100000, "sim_scenario": "ok"}') ->> 'ok')::boolean, 'chef : agent allumé');

-- 1. Riz sous le seuil → commande chez le fournisseur habituel, appel lancé
select tests.as_service();
select tests.eq((public.supply_agent_tick() ->> 'planned')::int, 1, 'riz sous le seuil : 1 commande');
select id as o1 from public.supplier_orders where auto order by created_at desc limit 1 \gset
select tests.eq((select supplier_name from public.supplier_orders where id = :'o1'), 'Grossiste Koné', 'fournisseur habituel choisi');
select tests.eq((select (items -> 0 ->> 'qty')::numeric from public.supplier_orders where id = :'o1'), 2::numeric, '2 × 20 − 10 = 30 kg → 2 sacs de 25 kg');
select tests.eq((select call_phone from public.supplier_orders where id = :'o1'), '+2250700000001', 'démo : appel vers le téléphone du présentateur');
select tests.eq((select dispatches from public.supplier_orders where id = :'o1'), 1, 'appel demandé');
select tests.ok((select reason from public.supplier_orders where id = :'o1') like 'Riz : 10 kg en stock%seuil 20%', 'l''agent dit pourquoi il commande');
select tests.eq((public.supply_agent_tick() ->> 'planned')::int, 0, 'pas de double commande (déjà en route)');
select tests.eq((select dispatches from public.supplier_orders where id = :'o1'), 1, 'pas de second appel tant que le premier n''a pas démarré');

-- L'appel se passe bien → réception → stock et prix habituel mis à jour
select public._supplier_call_started(:'o1', 'sim_1', 'simulation');
select tests.eq((select dispatches from public.supplier_orders where id = :'o1'), 0, 'appel démarré : compteur remis à zéro');
select public._supplier_call_action(:'o1', 'record_quote', '{"total": 39000}');
select public._supplier_call_action(:'o1', 'confirm_order', '{"delivery_at": "demain 9h"}');
select tests.login('agent');
select tests.code(public.supplier_order_receive(:'o1', 39000), 'FORBIDDEN', 'agent de comptoir : ne réceptionne pas');
select tests.login('chef');
select tests.ok((public.supplier_order_receive(:'o1', 39000) ->> 'ok')::boolean, 'chef : commande reçue');
select tests.code(public.supplier_order_receive(:'o1', 39000), 'INVALID_STATUS', 'pas deux réceptions');
select tests.as_service();
select tests.eq((select stock_qty from public.ingredients where name = 'Riz'), 60.000, 'stock : 10 + 2 × 25 kg');
select tests.eq((select usual_price from public.supplier_products p join public.suppliers s on s.id = p.supplier_id
                  where s.name = 'Grossiste Koné' and p.label like 'sacs de riz%'), 18800, 'prix habituel ajusté (moyenne glissante)');
select tests.eq((select status from public.supplier_orders where id = :'o1'), 'recu', 'statut : reçu');

-- 2. Refus → secours n° 1 ; injoignable 3 fois → secours n° 2 ; refus → fiche de courses
update public.ingredients set stock_qty = 5 where name = 'Riz';
select public.supply_agent_tick();
select id as o2 from public.supplier_orders where auto and status = 'a_appeler' order by created_at desc limit 1 \gset
select public._supplier_call_started(:'o2', 'sim_2', 'simulation');
select public._supplier_call_action(:'o2', 'refuse', '{"raison": "rupture"}');
select public.supply_agent_tick();
select tests.eq((select status from public.supplier_orders where id = :'o2'), 'reporte', 'refus : commande reportée');
select id as o3 from public.supplier_orders where parent_id = :'o2' \gset
select tests.eq((select supplier_name || ' / ' || origin from public.supplier_orders where id = :'o3'), 'Grossiste Diallo / secours', 'secours n° 1 : Grossiste Diallo');
select public._supplier_call_started(:'o3', 'sim_3', 'simulation'); select public._supplier_call_ended(:'o3', null, null, 'no_answer');
select tests.ok((select next_call_at > now() from public.supplier_orders where id = :'o3'), 'injoignable : nouvel essai programmé');
select public._supplier_call_started(:'o3', 'sim_4', 'simulation'); select public._supplier_call_ended(:'o3', null, null, 'no_answer');
select public._supplier_call_started(:'o3', 'sim_5', 'simulation'); select public._supplier_call_ended(:'o3', null, null, 'no_answer');
select public.supply_agent_tick();
select id as o4 from public.supplier_orders where parent_id = :'o3' \gset
select tests.eq((select supplier_name from public.supplier_orders where id = :'o4'), 'Supermarché Riviera', '3 essais sans réponse : secours n° 2');
select public._supplier_call_started(:'o4', 'sim_6', 'simulation');
select public._supplier_call_action(:'o4', 'refuse', '{}');
select public.supply_agent_tick();
select tests.ok(exists (select 1 from public.supply_events where order_id = :'o4' and kind = 'sans_secours'), 'plus de fournisseur : fiche de courses');
select tests.eq((select count(*) from public.supplier_orders where parent_id = :'o4')::int, 0, 'pas de commande inventée');
select tests.eq((public.supply_agent_tick() ->> 'planned')::int, 0, 'l''agent ne rappelle pas en boucle ceux qui ont refusé');

-- 3. Au-dessus du plafond : accord de l'équipe dans le groupe (« OUI Koné »)
select tests.login('chef');
select public.supply_agent_configure('{"auto_limit": 10000}');
select tests.as_service();
update public.ingredients set stock_qty = 2 where name = 'Huile';
select public.supply_agent_tick();
select id as o5 from public.supplier_orders where auto and status = 'a_approuver' order by created_at desc limit 1 \gset
select tests.ok(exists (select 1 from public.supply_events where order_id = :'o5' and message like '%OUI Koné%'), 'demande d''accord avec la réponse à donner');
select tests.ok(exists (select 1 from public.notifications where user_id = tests.uid('chef') and type = 'supply_approve'), 'chef prévenu');
select tests.eq((select dispatches from public.supplier_orders where id = :'o5'), 0, 'pas d''appel sans accord');
select tests.eq(public._supply_group_decide('bonjour à tous', 'Awa') ->> 'handled', 'false', 'conversation ordinaire : ignorée');
select tests.ok((public._supply_group_decide('NON Xyz', 'Awa') ->> 'reply') like 'Aucune commande%', 'fournisseur inconnu : réponse claire');
select tests.eq(public._supply_group_decide('oui kone', 'Awa') ->> 'handled', 'true', '« oui kone » sans accent compris');
select tests.eq((select status || ' / ' || approved_by from public.supplier_orders where id = :'o5'), 'a_appeler / Awa', 'approuvée par Awa → à appeler');

-- Refus de l'équipe : pas de secours, pas de nouvelle demande
update public.ingredients set stock_qty = 0 where name = 'Sucre';
select public.supply_agent_tick();
select id as o6 from public.supplier_orders where auto and status = 'a_approuver' order by created_at desc limit 1 \gset
select public._supply_group_decide('NON Koné', 'Awa');
select public.supply_agent_tick();
select tests.eq((select status from public.supplier_orders where id = :'o6'), 'annule', 'refus de l''équipe : annulée');
select tests.eq((select count(*) from public.supplier_orders where parent_id = :'o6')::int, 0, 'refus de l''équipe : pas de secours');
select tests.eq((select count(*) from public.supplier_orders where auto and status = 'a_approuver')::int, 0, 'refus de l''équipe : pas redemandé');

-- 4. Article manquant → retiré, commandé chez le secours ; le secours ne livre pas → coursier
select tests.login('chef');
select public.supply_agent_configure('{"auto_limit": 100000}');
select tests.as_service();
update public.ingredients set stock_qty = 0 where name in ('Tomate', 'Oignon');
select public.supply_agent_tick();
select id as o7 from public.supplier_orders where auto and supplier_name = 'Marché de Cocody' order by created_at desc limit 1 \gset
select tests.eq((select jsonb_array_length(items) from public.supplier_orders where id = :'o7'), 2, 'marché : tomates + oignons');
select public._supplier_call_started(:'o7', 'sim_7', 'simulation');
select public._supplier_call_action(:'o7', 'record_quote', jsonb_build_object('total', (select budget from public.supplier_orders where id = :'o7')));
select public._supplier_call_action(:'o7', 'item_unavailable', '{"article": "les tomates"}');
select public._supplier_call_action(:'o7', 'confirm_order', '{"delivery_at": "11h"}');
select public._supplier_call_ended(:'o7', null, null, null);
select public.supply_agent_tick();
select tests.eq((select items -> 0 ->> 'label' from public.supplier_orders where id = :'o7'), 'kg d''oignons', 'tomates retirées de la commande du marché');
select id as o8 from public.supplier_orders where parent_id = :'o7' \gset
select tests.eq((select supplier_name || ' : ' || (items -> 0 ->> 'label') from public.supplier_orders where id = :'o8'), 'Supermarché Riviera : kg de tomates', 'tomates commandées au supermarché');
select public._supplier_call_started(:'o8', 'sim_8', 'simulation');
select public._supplier_call_action(:'o8', 'record_quote', jsonb_build_object('total', (select budget from public.supplier_orders where id = :'o8')));
select public._supplier_call_action(:'o8', 'cannot_deliver', '{"raison": "pas de livreur"}');
select tests.eq((public.supply_agent_tick() ->> 'couriers')::int, 1, 'ne livre pas : coursier envoyé par l''agent');
select tests.ok((select run_id is not null from public.supplier_orders where id = :'o8'), 'tournée créée');

-- 5. Commande demandée par l'équipe, puis annulée
select (public._supply_team_order(jsonb_build_array(jsonb_build_object('product_id',
  (select p.id from public.supplier_products p join public.suppliers s on s.id = p.supplier_id where s.name = 'Grossiste Koné' and p.label like 'sacs de sucre%'), 'qty', 1)), 'Awa')
  -> 'orders' ->> 0)::uuid as o9 \gset
select tests.eq((select origin || ' / ' || status from public.supplier_orders where id = :'o9'), 'equipe / a_appeler', 'commande de l''équipe : appelée sans redemander l''accord');
select tests.code(public._supply_team_order('[{"product_id": null, "qty": 1}]', 'Awa'), 'EMPTY', 'produit hors carnet refusé');
select tests.ok((public._supply_cancel(:'o9', 'Awa') ->> 'ok')::boolean, 'annulée par l''équipe');
select public.supply_agent_tick();
select tests.eq((select status from public.supplier_orders where id = :'o9'), 'annule', 'annulation : pas de secours');

-- 6. Outils
select tests.ok(abs(extract(epoch from public._supply_callback_at('dans 20 min') - now()) - 1200) < 2, '« dans 20 min »');
select tests.eq(to_char(public._supply_callback_at('rappelez à 23h59') at time zone 'Africa/Abidjan', 'HH24:MI'), '23:59', '« 23h59 »');
select tests.eq(public._supplier_short('Poissonnerie Port-Bouët'), 'Port-Bouët', 'mot court du fournisseur');
select tests.ok(public._supply_point() like '📊%Engagé%', 'point du jour');
select tests.login('chef');
select tests.ok(jsonb_array_length(public.supply_agent_overview() -> 'orders') >= 8, 'écran : commandes de l''agent');
select tests.ok((public.supply_agent_run() ->> 'ok')::boolean, 'chef : lancer un tour maintenant');
select public.supply_agent_configure('{"enabled": false}');
select tests.as_service();
select tests.eq(public.supply_agent_tick() ->> 'enabled', 'false', 'éteint à nouveau');
rollback;
