-- Bons invités : événement payé par le budget Réceptions, QR par invité, scan au comptoir, cuisine, budget rendu
begin;
select tests.setup();
\set d '(public.today_abidjan() + 1)'

select tests.ok(exists (select 1 from public.profiles where id = public._guest_profile() and is_blocked), 'compte système « Réceptions » créé et bloqué');

-- Droits
select tests.login('alice');
select tests.code(public.guest_event_create('Visite', :d, 'lunch', 3), 'FORBIDDEN', 'élève : pas d''événement');
select tests.code(public.guest_overview(), 'FORBIDDEN', 'élève : pas de budget');
select tests.login('agent');
select tests.code(public.guest_event_create('Visite', :d, 'lunch', 3), 'FORBIDDEN', 'agent de comptoir : pas d''événement');

-- Contrôles
select tests.login('caisse');
select tests.code(public.guest_event_create(' ', :d, 'lunch', 3), 'INVALID_NAME', 'nom obligatoire');
select tests.code(public.guest_event_create('Visite', :d, 'lunch', 0), 'INVALID_GUESTS', 'au moins 1 invité');
select tests.code(public.guest_event_create('Visite', public.today_abidjan() - 1, 'lunch', 3), 'INVALID_DATE', 'pas dans le passé');
select tests.code(public.guest_event_create('Visite', :d, 'lunch', 3, jsonb_build_array(jsonb_build_object('menu_item_id', tests.item('attieke_dinner'), 'qty', 1))),
  'INVALID_DISH', 'plat d''un autre repas refusé');
select tests.code(public.guest_event_create('Visite', :d, 'lunch', 2, jsonb_build_array(jsonb_build_object('menu_item_id', tests.item('garba_lunch'), 'qty', 3))),
  'INVALID_DISH', 'plus de plats que d''invités refusé');
select tests.code(public.guest_event_create('Grande délégation', :d, 'lunch', 200), 'BUDGET', 'budget du mois dépassé (200 × 2 500 > 300 000)');

-- Création : 3 invités, 2 garba prévus
select (public.guest_event_create('Visite du ministère', :d, 'lunch', 3,
  jsonb_build_array(jsonb_build_object('menu_item_id', tests.item('garba_lunch'), 'qty', 2)), 'Ministre + 2 conseillers') ->> 'event_id')::uuid as ev \gset
select tests.as_service();
select tests.eq((select count(*) from public.guest_vouchers where event_id = :'ev')::int, 3, '3 bons créés');
select tests.eq((select sum(total) from public.tickets t join public.guest_vouchers v on v.ticket_id = t.id where v.event_id = :'ev')::int, 0,
  'aucun argent pris sur un portefeuille');
select tests.eq((select balance from public.wallets where user_id = public._guest_profile()), 0, 'compte Réceptions : solde intact');
select tests.ok(exists (select 1 from public.notifications where user_id = tests.uid('chef') and type = 'guest_event'), 'cuisine prévenue');
select tests.login('caisse');
select tests.eq((public.guest_overview(:d) ->> 'engaged')::int, 7500, 'budget engagé : 3 × 2 500');
select tests.eq(jsonb_array_length(public.guest_event_vouchers(:'ev') -> 'vouchers'), 3, 'codes à imprimer');
select public.guest_event_vouchers(:'ev') -> 'vouchers' -> 0 ->> 'code' as c1 \gset
select public.guest_event_vouchers(:'ev') -> 'vouchers' -> 1 ->> 'code' as c2 \gset
select tests.ok(:'c1' ~ '^VATEL-INVITE:[0-9a-f-]{36}\.[0-9a-f]{32}$', 'format du QR invité');

-- Cuisine : les invités s'ajoutent aux clients attendus
select tests.login('chef');
select tests.eq((select (s ->> 'guests')::int from jsonb_array_elements(public.admin_forecast(:d) -> 'services') s where s ->> 'service' = 'lunch'), 3,
  'prévisions : 3 invités au déjeuner');
select tests.ok((select (s ->> 'expected')::int >= 3 from jsonb_array_elements(public.admin_forecast(:d) -> 'services') s where s ->> 'service' = 'lunch'),
  'prévisions : invités comptés dans les repas attendus');

-- Comptoir
select tests.login('alice');
select tests.code(public.guest_redeem(:'c1', :d, 'lunch'), 'FORBIDDEN', 'élève : ne scanne pas');
select tests.login('agent');
select tests.code(public.guest_redeem('VATEL-INVITE:' || gen_random_uuid() || '.' || md5('x'), :d, 'lunch'), 'INVALID_QR', 'bon inconnu');
select tests.code(public.guest_redeem(regexp_replace(:'c1', '.{4}$', '0000'), :d, 'lunch'), 'INVALID_QR', 'code secret faux');
select tests.code(public.guest_redeem(:'c1', public.today_abidjan(), 'lunch'), 'WRONG_DAY', 'bon d''un autre jour');
select public.guest_redeem(:'c1', :d, 'lunch') as r1 \gset
select tests.eq((:'r1')::jsonb ->> 'client', 'Invité · Visite du ministère', 'scan : « Invité · Visite du ministère »');
select tests.eq(((:'r1')::jsonb -> 'guest' ->> 'left')::int, 2, 'scan : reste 2 invités');
select tests.code(public.guest_redeem(:'c1', :d, 'lunch'), 'ALREADY_USED', 'pas deux fois le même bon');
select tests.ok((public.serve_dish(((:'r1')::jsonb ->> 'ticket_id')::uuid, tests.item('garba_lunch')) ->> 'ok')::boolean, 'plat servi à l''invité');
select tests.as_service();
select tests.eq((select served_qty from public.menu_items where id = tests.item('garba_lunch')), 1, 'portion comptée');
select tests.eq((select count(*) from public.notifications where user_id = public._guest_profile())::int, 0, 'aucune notification au compte système');

-- Annulation : les bons non utilisés reviennent au budget
select tests.login('caisse');
select tests.eq((public.guest_event_cancel(:'ev') ->> 'cancelled')::int, 2, 'annulation : 2 bons non utilisés annulés');
select tests.eq((public.guest_overview(:d) ->> 'engaged')::int, 2500, 'budget : seul le repas servi reste compté');
select tests.code(public.guest_event_cancel(:'ev'), 'NOT_FOUND', 'pas deux annulations');
select tests.login('agent');
select tests.code(public.guest_redeem(:'c2', :d, 'lunch'), 'CANCELLED', 'bon annulé refusé au comptoir');

-- Bons expirés : rendus au budget, sans remboursement à un portefeuille
select tests.login('caisse');
select (public.guest_event_create('Jury', :d, 'dinner', 2) ->> 'event_id')::uuid as ev2 \gset
select tests.as_service();
update public.tickets t set valid_until = now() - interval '1 minute' from public.guest_vouchers v where v.ticket_id = t.id and v.event_id = :'ev2';
select public.expire_tickets();
select tests.eq((select count(*) from public.transactions where user_id = public._guest_profile())::int, 0, 'expiration : aucun mouvement d''argent');
select tests.login('caisse');
select tests.eq((public.guest_overview(:d) ->> 'engaged')::int, 2500, 'expiration : bons rendus au budget');

-- Rapports et budget
select tests.login('chef');
select tests.eq((public.guest_report(:d, :d) ->> 'served')::int, 1, 'rapport : 1 repas invité servi');
select tests.eq((public.guest_report(:d, :d) ->> 'cost')::int, 2500, 'rapport : 2 500 F payés par l''école');
select tests.login('caisse');
select tests.code(public.guest_budget_set(500000), 'FORBIDDEN', 'caisse : ne change pas le budget');
select tests.login('admin');
select tests.ok((public.guest_budget_set(500000) ->> 'ok')::boolean, 'admin : budget changé');
select tests.eq((public.guest_overview(:d) ->> 'budget')::int, 500000, 'nouveau budget');
select tests.check_ledger();
rollback;
