-- Allergie grave : commande bloquée, plat refusé au comptoir, alerte pour l'agent ; traces
begin;
select tests.setup();
select public.today_abidjan() + 1 as d \gset
select (public._service_window(:'d'::date, 'lunch')).starts as starts \gset
select tests.as_service();
update public.settings set value = value || '{"same_day_only": false}' where key = 'orders';
update public.dishes set allergens = array['poisson'], traces = '{}' where id = (select dish_id from public.menu_items where id = tests.item('garba_lunch'));
update public.dishes set allergens = '{}', traces = array['arachide'] where id = (select dish_id from public.menu_items where id = tests.item('attieke_lunch'));

select tests.eq(public._severe_hits(array['arachide'], array['gluten'], array['arachide']), array['arachide'], 'traces comptées pour une allergie grave');
select tests.eq(cardinality(public._severe_hits(array['arachide'], array['gluten'], '{}')), 0, 'plat sans l''allergène : rien');

select tests.login('alice');
select public.set_pin('2580');
select public.simulate_recharge(30000);
select public.set_my_diet(array['poisson', 'arachide'], '{}');
select tests.ok((public.set_my_severe_allergies(array['poisson', 'lait']) ->> 'ok')::boolean, 'allergie grave enregistrée');
select tests.as_service();
select tests.eq((select severe_allergies from public.profiles where id = tests.uid('alice')), array['poisson'], 'grave seulement parmi ses allergies');

-- Commande : plat avec poisson refusé, plat avec traces d'arachide (allergie non grave) accepté
select tests.login('alice');
select tests.code(public.place_order_cart(jsonb_build_array(jsonb_build_object('menu_item_id', tests.item('garba_lunch'), 'qty', 1)),
  :'starts'::timestamptz + interval '1 hour', '[]', '2580'), 'ALLERGY_SEVERE', 'plat dangereux refusé à la commande');
select public.place_order_cart(jsonb_build_array(jsonb_build_object('menu_item_id', tests.item('attieke_lunch'), 'qty', 1)),
  :'starts'::timestamptz + interval '1 hour', '[]', '2580') as r \gset
select tests.ok((:'r'::jsonb ->> 'ok')::boolean, 'plat sans allergène grave accepté');

-- Comptoir : alerte pour la commande (traces d'arachide)
select tests.login('agent');
select public.counter_allergy_alert((:'r'::jsonb ->> 'ticket_id')::uuid) as a \gset
select tests.eq(:'a'::jsonb -> 'severe', '["poisson"]'::jsonb, 'agent voit l''allergie grave');
select tests.eq(:'a'::jsonb -> 'order_risks' -> 0 -> 'reasons', '["traces de arachide"]'::jsonb, 'agent voit les traces dans la commande');
select tests.login('alice');
select tests.code(public.counter_allergy_alert((:'r'::jsonb ->> 'ticket_id')::uuid), 'FORBIDDEN', 'réservé aux agents');

-- Ticket repas : le plat dangereux ne peut pas être servi
select tests.login('alice');
select (public.purchase_tickets('lunch') -> 'ticket_ids' ->> 0) as t \gset
select tests.as_service();
select qr_nonce as n from public.tickets where id = :'t' \gset
select public.redeem_ticket(:'t', :'n', tests.uid('agent'), :'d', 'lunch');
select tests.login('agent');
select tests.ok(public.counter_allergy_alert(:'t') -> 'dish_risks' -> (tests.item('garba_lunch')::text) -> 'severe' = '["poisson"]'::jsonb, 'plat du jour dangereux signalé à l''agent');
select tests.code(public.serve_dish(:'t', tests.item('garba_lunch')), 'ALLERGY_SEVERE', 'plat dangereux refusé au comptoir');
select tests.ok((public.serve_dish(:'t', tests.item('attieke_lunch')) ->> 'ok')::boolean, 'autre plat servi');

-- L'appli lit ces colonnes du profil (droits colonne par colonne)
select tests.ok(has_column_privilege('authenticated', 'public.profiles', 'allergies', 'select')
  and has_column_privilege('authenticated', 'public.profiles', 'diets', 'select')
  and has_column_privilege('authenticated', 'public.profiles', 'severe_allergies', 'select'), 'allergies, régime et allergies graves lisibles par l''appli');

-- Retirer l'allergie retire son caractère grave
select tests.login('alice');
select public.set_my_diet(array['arachide'], '{}');
select tests.as_service();
select tests.eq(cardinality((select severe_allergies from public.profiles where id = tests.uid('alice'))), 0, 'allergie retirée : plus grave');
rollback;
