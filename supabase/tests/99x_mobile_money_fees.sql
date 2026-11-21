-- Frais Mobile Money payés par l'élève : calculés en base, figés par paiement, vérifiés au franc près par le webhook
begin;
select tests.setup();
select tests.as_service();
update public.settings set value = value || '{"mode": "jeko", "fee_percent": 0}'::jsonb where key = 'mobile_money';

-- Taux 0 : rien ne change (la cantine absorbe les frais)
select tests.eq(public._mobile_money_fee(500), 0, 'taux 0 : pas de frais');
select tests.login('alice');
select public.payment_start(500, 'wave', '+2250701020304') as r0 \gset
select tests.eq((:'r0'::jsonb ->> 'total')::int, 500, 'taux 0 : total = montant');

-- Taux 1,6 % : 500 F crédités → 509 F payés (la cantine reçoit 500 après commission)
select tests.as_service();
update public.settings set value = value || '{"fee_percent": 1.6}'::jsonb where key = 'mobile_money';
select tests.eq(public._mobile_money_fee(500), 9, '1,6 % de 500 F → 9 F de frais');
select tests.eq(public._mobile_money_fee(5000), 82, '1,6 % de 5 000 F → 82 F de frais');
update public.payments set created_at = now() - interval '1 minute';
select tests.login('alice');
select public.payment_start(500, 'wave', '+2250701020304') as r \gset
select tests.eq((:'r'::jsonb ->> 'amount')::int, 500, 'montant crédité inchangé');
select tests.eq((:'r'::jsonb ->> 'fee')::int, 9, 'frais renvoyés');
select tests.eq((:'r'::jsonb ->> 'total')::int, 509, 'total débité = 509 F');
select tests.throws($$select public._mobile_money_fee(500)$$, 'un élève ne peut pas appeler le calcul interne');

-- Le taux change après le départ : les frais du paiement restent figés
select tests.as_service();
update public.settings set value = value || '{"fee_percent": 5}'::jsonb where key = 'mobile_money';
select tests.eq((select fee from public.payments where reference = :'r'::jsonb ->> 'reference'), 9, 'frais figés au départ du paiement');

-- Webhook : montant sans les frais → refusé ; montant + frais → crédit de 500 F seulement
select balance as b0 from public.wallets where user_id = tests.uid('alice') \gset
select tests.eq(public._payment_success(:'r'::jsonb ->> 'reference', 'pr_f', 50000, 'tx_f', 'wave') ->> 'code', 'amount_mismatch',
  'payé sans les frais : refusé');
update public.payments set status = 'pending', error_reason = null where reference = :'r'::jsonb ->> 'reference';
select tests.eq(public._payment_success(:'r'::jsonb ->> 'reference', 'pr_f', 50900, 'tx_f', 'wave') ->> 'code', 'paid', 'payé 509 F : confirmé');
select tests.eq((select balance from public.wallets where user_id = tests.uid('alice')), :b0 + 500, 'compte crédité de 500 F (pas 509)');
select tests.ok((select note from public.transactions where user_id = tests.uid('alice') order by created_at desc limit 1) like '%frais%',
  'historique : frais indiqués');

-- Taux absurde : plafonné à 10 %
update public.settings set value = value || '{"fee_percent": 80}'::jsonb where key = 'mobile_money';
select tests.eq(public._mobile_money_fee(1000), 112, 'taux plafonné à 10 % (1 000 F → 112 F)');
update public.settings set value = value || '{"fee_percent": -3}'::jsonb where key = 'mobile_money';
select tests.eq(public._mobile_money_fee(1000), 0, 'taux négatif → 0');

-- Un élève ne peut pas modifier le taux ni ses frais
select tests.login('alice');
update public.settings set value = value || '{"fee_percent": 0}'::jsonb where key = 'mobile_money';
select tests.eq((select (value ->> 'fee_percent')::numeric from public.settings where key = 'mobile_money'), -3::numeric, 'un élève ne change pas le taux');
select tests.throws($$update public.payments set fee = 0$$, 'un élève ne modifie pas un paiement');
select tests.check_ledger();
rollback;
