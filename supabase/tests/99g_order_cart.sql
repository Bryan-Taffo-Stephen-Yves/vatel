-- Commande groupée (panier) : plusieurs plats en quantité + suppléments, un numéro, une confirmation ; jour même seulement
begin;
select tests.setup();
select public.today_abidjan() + 1 as d \gset
select (public._service_window(:'d'::date, 'lunch')).starts as starts \gset
select tests.login('alice');
select public.set_pin('2580');
select public.simulate_recharge(30000);

-- Jour même uniquement (réglage par défaut)
select tests.eq(public.order_slots(:'d'::date, 'lunch'), '[]'::jsonb, 'pas de créneau pour demain');
select tests.code(public.place_order_cart(jsonb_build_array(jsonb_build_object('menu_item_id', tests.item('garba_lunch'), 'qty', 1)),
  :'starts'::timestamptz + interval '1 hour', '[]', '2580'), 'TODAY_ONLY', 'plat de demain refusé');

-- Le reste se teste sur demain
select tests.as_service();
update public.settings set value = value || '{"same_day_only": false}' where key = 'orders';
select tests.login('alice');
select balance as before from public.wallets where user_id = tests.uid('alice') \gset

select tests.code(public.place_order_cart(jsonb_build_array(jsonb_build_object('menu_item_id', tests.item('garba_lunch'), 'qty', 11)),
  :'starts'::timestamptz + interval '1 hour', '[]', '2580'), 'TOO_MANY_DISHES', 'plus de 10 plats refusé');
select tests.code(public.place_order_cart(jsonb_build_array(jsonb_build_object('menu_item_id', tests.item('garba_lunch'), 'qty', 1),
  jsonb_build_object('menu_item_id', tests.item('attieke_dinner'), 'qty', 1)), :'starts'::timestamptz + interval '1 hour', '[]', '2580'),
  'MIXED_MEALS', 'déjeuner + dîner dans la même commande refusé');
select tests.code(public.place_order_cart(jsonb_build_array(jsonb_build_object('menu_item_id', tests.item('garba_lunch'), 'qty', 1)),
  :'starts'::timestamptz + interval '1 hour', jsonb_build_array(jsonb_build_object('extra_id', tests.extra('dessert'), 'qty', 2)), '2580'),
  'INVALID_EXTRA', '2 desserts pour 1 plat refusé');
select tests.code(public.place_order_cart(jsonb_build_array(jsonb_build_object('menu_item_id', tests.item('garba_lunch'), 'qty', 4)),
  :'starts'::timestamptz + interval '1 hour', '[]', '0000'), 'PIN_INVALID', 'mauvais PIN refusé');

-- 4 garba + 1 attiéké + 3 desserts, en une fois
select public.place_order_cart(jsonb_build_array(
    jsonb_build_object('menu_item_id', tests.item('garba_lunch'), 'qty', 4),
    jsonb_build_object('menu_item_id', tests.item('attieke_lunch'), 'qty', 1)),
  :'starts'::timestamptz + interval '1 hour',
  jsonb_build_array(jsonb_build_object('extra_id', tests.extra('dessert'), 'qty', 3)), '2580') as r \gset
select tests.ok((:'r'::jsonb ->> 'ok')::boolean, 'panier commandé : ' || (:'r'::jsonb ->> 'dish'));
select (:'r'::jsonb ->> 'order_no')::int as no \gset
select tests.eq((select count(*) from public.tickets where user_id = tests.uid('alice') and order_no = :no)::int, 5, '5 tickets, un seul numéro');
select tests.eq((select count(*) from public.tickets t, jsonb_array_elements(t.extras) e where t.user_id = tests.uid('alice') and t.order_no = :no)::int, 3, '3 desserts répartis');
select tests.eq((select max(jsonb_array_length(extras)) from public.tickets where user_id = tests.uid('alice') and order_no = :no), 1, 'au plus 1 supplément par plat ici');
select tests.eq((select sum(total) from public.tickets where user_id = tests.uid('alice') and order_no = :no)::int, (:'r'::jsonb ->> 'total')::int, 'total = somme des tickets');
select tests.eq((select balance from public.wallets where user_id = tests.uid('alice')), :before - (:'r'::jsonb ->> 'total')::int, 'débité une fois du total');
select tests.eq((select sold_qty from public.menu_items where id = tests.item('garba_lunch')), 4, '4 portions de garba réservées');
select tests.eq((select count(*) from public.notifications where user_id = tests.uid('alice') and type = 'order_placed')::int, 1, 'une seule notification au client');

-- Cuisine : une carte, statut appliqué à toute la commande
select tests.login('chef');
select tests.eq((select count(*) from jsonb_array_elements(public.kitchen_orders(:'d'::date) -> 'orders') o where (o ->> 'no')::int = :no)::int, 1, 'cuisine : une seule carte');
select tests.eq((select (o ->> 'qty')::int from jsonb_array_elements(public.kitchen_orders(:'d'::date) -> 'orders') o where (o ->> 'no')::int = :no), 5, 'carte : 5 plats');
select public.set_order_status((:'r'::jsonb ->> 'ticket_id')::uuid, 'ready');
select tests.eq((select count(*) from public.tickets where user_id = tests.uid('alice') and order_no = :no and prep_status = 'ready')::int, 5, 'prête : toute la commande');

-- Comptoir : un scan remet toute la commande (commande prête)
select tests.as_service();
select public.redeem_ticket(t.id, t.qr_nonce, tests.uid('agent'), :'d'::date, 'lunch') as sc
  from public.tickets t where t.id = (:'r'::jsonb ->> 'ticket_id')::uuid \gset
select tests.eq((:'sc'::jsonb -> 'order' ->> 'qty')::int, 5, 'scan : 5 plats remis d''un coup');
select tests.eq((select count(*) from public.tickets where user_id = tests.uid('alice') and order_no = :no and status = 'used')::int, 5, 'tous les tickets utilisés');

-- Demande Jean au format panier
select tests.as_service();
insert into public.order_requests (user_id, menu_item_id, pickup_at, items, extras)
values (tests.uid('alice'), tests.item('garba_lunch'), :'starts'::timestamptz + interval '90 minutes',
        jsonb_build_array(jsonb_build_object('menu_item_id', tests.item('garba_lunch'), 'qty', 2)), '[]')
returning token as t \gset
select tests.login('alice');
select public.confirm_order_request(:'t', '2580') as r2 \gset
select tests.ok((:'r2'::jsonb ->> 'ok')::boolean, 'demande Jean (panier) confirmée');
select tests.as_service();
select tests.eq((select cardinality(ticket_ids) from public.order_requests where token = :'t'), 2, 'demande : 2 tickets');

-- 3e commande pour le même repas : limite (2 commandes, pas 2 plats)
select tests.login('alice');
-- (la 1re est déjà remise : 1 en cours + celle-ci = 2)
select tests.ok((public.place_order_cart(jsonb_build_array(jsonb_build_object('menu_item_id', tests.item('garba_lunch'), 'qty', 1)),
  :'starts'::timestamptz + interval '1 hour', '[]', '2580') ->> 'ok')::boolean, '2e commande en cours acceptée');
select tests.code(public.place_order_cart(jsonb_build_array(jsonb_build_object('menu_item_id', tests.item('garba_lunch'), 'qty', 1)),
  :'starts'::timestamptz + interval '1 hour', '[]', '2580'), 'TOO_MANY_ORDERS', '3e commande en cours du même repas refusée');
rollback;
