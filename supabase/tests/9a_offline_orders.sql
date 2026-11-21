-- Commande hors ligne : envoyée au retour du réseau, clé anti-doublon, créneau choisi au moment de l'envoi, tout revérifié
begin;
select tests.setup();
select tests.as_service();
update public.settings set value = value || '{"same_day_only": false}' where key = 'orders';
select public.today_abidjan() + 1 as d \gset
select (public._service_window(:'d'::date, 'lunch')).starts as starts \gset
select tests.login('alice');
select public.set_pin('2580');
select public.simulate_recharge(30000);
select balance as b0 from public.wallets where user_id = tests.uid('alice') \gset
select gen_random_uuid() as k1 \gset

-- Envoi d'une commande préparée hors ligne (heure souhaitée : 1 h après l'ouverture)
select public.place_order_offline(:'k1', jsonb_build_array(jsonb_build_object('menu_item_id', tests.item('garba_lunch'), 'qty', 2)),
  :'starts'::timestamptz + interval '1 hour', '[]', '2580') as r \gset
select tests.ok((:'r'::jsonb ->> 'ok')::boolean, 'commande hors ligne acceptée au retour du réseau');
select tests.eq((:'r'::jsonb ->> 'pickup_at')::timestamptz, :'starts'::timestamptz + interval '1 hour', 'heure souhaitée retenue (libre)');
select balance as b1 from public.wallets where user_id = tests.uid('alice') \gset

-- Envoi rejoué (réseau coupé pendant la réponse) : même commande, pas de second débit
select public.place_order_offline(:'k1', jsonb_build_array(jsonb_build_object('menu_item_id', tests.item('garba_lunch'), 'qty', 2)),
  :'starts'::timestamptz + interval '1 hour', '[]', '2580') as r2 \gset
select tests.ok((:'r2'::jsonb ->> 'replayed')::boolean, 'renvoi : réponse rejouée');
select tests.eq(:'r2'::jsonb ->> 'order_no', :'r'::jsonb ->> 'order_no', 'renvoi : même numéro de commande');
select tests.eq((select balance from public.wallets where user_id = tests.uid('alice')), :b1, 'renvoi : pas de second débit');
select tests.eq((select count(*) from public.tickets where user_id = tests.uid('alice') and order_no = (:'r'::jsonb ->> 'order_no')::int)::int, 2,
  'renvoi : pas de tickets en double');

-- Mauvais PIN tapé hors ligne : refusé, et la même commande peut être renvoyée avec le bon PIN
select gen_random_uuid() as k2 \gset
select tests.code(public.place_order_offline(:'k2', jsonb_build_array(jsonb_build_object('menu_item_id', tests.item('attieke_lunch'), 'qty', 1)),
  null, '[]', '0000'), 'PIN_INVALID', 'mauvais PIN : refusé au retour du réseau');
select tests.ok((public.place_order_offline(:'k2', jsonb_build_array(jsonb_build_object('menu_item_id', tests.item('attieke_lunch'), 'qty', 1)),
  null, '[]', '2580') ->> 'ok')::boolean, 'même commande renvoyée avec le bon PIN : acceptée');

-- Créneau souhaité complet : on prend le suivant libre
select tests.as_service();
update public.settings set value = value || '{"slot_capacity": 2, "max_active_per_meal": 5}' where key = 'orders';
select tests.login('alice');
select public.place_order_offline(gen_random_uuid(), jsonb_build_array(jsonb_build_object('menu_item_id', tests.item('garba_lunch'), 'qty', 1)),
  :'starts'::timestamptz + interval '1 hour', '[]', '2580') as r3 \gset
select tests.ok((:'r3'::jsonb ->> 'ok')::boolean and (:'r3'::jsonb ->> 'pickup_at')::timestamptz > :'starts'::timestamptz + interval '1 hour',
  'créneau souhaité complet : créneau suivant pris');

-- Plat épuisé entre-temps : refusé, rien débité
select tests.as_service();
update public.menu_items set is_sold_out = true where id = tests.item('attieke_lunch');
select tests.login('alice');
select balance as b2 from public.wallets where user_id = tests.uid('alice') \gset
select tests.code(public.place_order_offline(gen_random_uuid(), jsonb_build_array(jsonb_build_object('menu_item_id', tests.item('attieke_lunch'), 'qty', 1)),
  null, '[]', '2580'), 'SOLD_OUT', 'plat épuisé pendant la coupure : refusé');
select tests.eq((select balance from public.wallets where user_id = tests.uid('alice')), :b2, 'plat épuisé : rien débité');

-- Solde devenu insuffisant : refusé
select tests.as_service();
update public.menu_items set is_sold_out = false where id = tests.item('attieke_lunch');
select tests.login('bob');
select public.set_pin('7391');
select tests.code(public.place_order_offline(gen_random_uuid(), jsonb_build_array(jsonb_build_object('menu_item_id', tests.item('attieke_lunch'), 'qty', 1)),
  null, '[]', '7391'), 'INSUFFICIENT_FUNDS', 'solde insuffisant : refusé');

-- La clé d'un autre ne sert à rien, et la table des clés n'est pas lisible
select tests.code(public.place_order_offline(:'k1', jsonb_build_array(jsonb_build_object('menu_item_id', tests.item('garba_lunch'), 'qty', 1)),
  null, '[]', '7391'), 'BAD_REQUEST', 'clé d''un autre élève : refusée');
select tests.throws($$select * from public.offline_order_keys$$, 'table des clés illisible pour un élève');
select tests.as_anon();
select tests.throws($$select public.place_order_offline(gen_random_uuid(), '[]', null, '[]', '1234')$$, 'visiteur non connecté : refusé');

-- Numéro de Jean pour le bouton « Appeler Jean »
select tests.as_service();
update public.settings set value = value || '{"call_phone": "+2250700000000", "whatsapp_phone": "+2250500000000"}' where key = 'jean';
select tests.login('alice');
select tests.eq(public.jean_contact() ->> 'call', '+2250700000000', 'numéro d''appel de Jean lisible par un élève');
select tests.ok((select count(*) = 0 from public.settings where key = 'jean'), 'le reste des réglages de Jean reste privé');
select tests.check_ledger();
rollback;
