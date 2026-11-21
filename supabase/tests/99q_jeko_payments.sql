-- Paiement réel des recharges (Jèko) : départ contrôlé, crédit unique, montant vérifié, Face ID au départ
begin;
select tests.setup();

-- Départ : numéro, montant, moyen contrôlés
select tests.login('alice');
select tests.code(public.payment_start(5000, 'wave', '0701020304'), 'INVALID_PHONE', 'numéro au mauvais format refusé');
select tests.code(public.payment_start(50, 'wave', '+2250701020304'), 'INVALID_AMOUNT', 'montant trop petit refusé');
select tests.code(public.payment_start(5000, 'paypal', '+2250701020304'), 'INVALID_METHOD', 'moyen inconnu refusé');
select tests.code(public.payment_start(5000, 'wave', '+2250701020304', tests.uid('bob')), 'FORBIDDEN', 'pas de recharge pour un compte non lié');

select public.payment_start(5000, 'wave', '+2250701020304') as r \gset
select tests.ok((:'r'::jsonb ->> 'ok')::boolean and (:'r'::jsonb ->> 'reference') like 'VAT-%', 'paiement démarré, référence VAT-…');
select tests.code(public.payment_start(5000, 'wave', '+2250701020304'), 'TOO_FAST', '15 s entre deux tentatives');
select tests.throws($$select public._payment_success('x', null, 500000, null, 'wave')$$, 'un élève ne peut pas valider un paiement lui-même');

-- Le webhook confirme : crédit unique, montant contrôlé
select tests.as_service();
select balance as b0 from public.wallets where user_id = tests.uid('alice') \gset
select tests.eq(public._payment_success(:'r'::jsonb ->> 'reference', 'pr_1', 400000, 'tx_1', 'wave') ->> 'code', 'amount_mismatch',
  'montant différent : refusé');
select tests.eq((select balance from public.wallets where user_id = tests.uid('alice')), :b0, 'montant différent : rien crédité');

update public.payments set status = 'pending', error_reason = null where reference = :'r'::jsonb ->> 'reference';
select tests.eq(public._payment_success(:'r'::jsonb ->> 'reference', 'pr_1', 500000, 'tx_1', 'wave') ->> 'code', 'paid', 'paiement confirmé');
select tests.eq(public._payment_success(:'r'::jsonb ->> 'reference', 'pr_1', 500000, 'tx_1', 'wave') ->> 'code', 'already_paid',
  'webhook rejoué : pas de second crédit');
select tests.eq((select balance from public.wallets where user_id = tests.uid('alice')), :b0 + 5000, 'solde crédité une seule fois (+5 000)');
select tests.ok(exists (select 1 from public.notifications where user_id = tests.uid('alice') and title = 'Recharge reçue'), 'notification envoyée');
select tests.check_ledger();

-- Face ID activé : demandé au départ, mais le crédit arrivé plus tard passe
update public.profiles set biometric_enabled = true, biometric_ok_until = null where id = tests.uid('alice');
update public.payments set created_at = now() - interval '1 minute' where payer_id = tests.uid('alice');
select tests.login('alice');
select tests.code(public.payment_start(2000, 'orange', '+2250701020304'), 'BIOMETRIC_REQUIRED', 'Face ID demandé au départ');
select tests.as_service();
update public.profiles set biometric_ok_until = now() + interval '2 minutes' where id = tests.uid('alice');
select tests.login('alice');
select public.payment_start(2000, 'orange', '+2250701020304') as r2 \gset
select tests.as_service();
update public.profiles set biometric_ok_until = null where id = tests.uid('alice');
select tests.eq(public._payment_success(:'r2'::jsonb ->> 'reference', 'pr_2', 200000, 'tx_2', 'orange') ->> 'code', 'paid',
  'crédit du webhook accepté sans nouvelle confirmation Face ID');
select tests.throws($$select public._wallet_move(tests.uid('alice'), 100, 'recharge')$$, 'une recharge ordinaire reste bloquée sans Face ID');

-- Échec relu chez Jèko : seulement s'il était en attente
select tests.eq((public._payment_error(:'r2'::jsonb ->> 'reference', 'error') ->> 'updated')::boolean, false, 'un paiement réussi ne repasse pas en échec');

-- Parent : recharge l'enfant lié
insert into public.family_links (parent_id, child_id, status) values (tests.uid('bob'), tests.uid('alice'), 'active');
select tests.login('bob');
select public.payment_start(3000, 'mtn', '+2250501020304', tests.uid('alice')) as r3 \gset
select tests.as_service();
select balance as b1 from public.wallets where user_id = tests.uid('alice') \gset
select public._payment_success(:'r3'::jsonb ->> 'reference', 'pr_3', 300000, 'tx_3', 'mtn');
select tests.eq((select balance from public.wallets where user_id = tests.uid('alice')), :b1 + 3000, 'parent : le compte de l''enfant est crédité');

-- Lecture : chacun ne voit que ses paiements
select tests.login('agent');
select tests.eq((select count(*) from public.payments)::int, 0, 'un autre utilisateur ne voit aucun paiement');
select tests.login('alice');
select tests.eq((select count(*) from public.payments)::int, 3, 'l''élève voit ses paiements et ceux faits pour lui');
rollback;
