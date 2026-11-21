-- Règle d'annulation : remboursée avant l'heure limite ; après, possible mais sans remboursement ; rappel 30 min avant
begin;
select tests.setup();
update public.settings set value = value || '{"same_day_only": false}' where key = 'orders';
select public.today_abidjan() + 1 as d \gset
select (public._service_window(:'d'::date, 'lunch')).starts as starts \gset
select tests.login('alice');
select public.set_pin('2580');
select public.simulate_recharge(20000);
select public.place_order(tests.item('garba_lunch'), :'starts'::timestamptz + interval '1 hour', '{}', '2580') ->> 'ticket_id' as o1 \gset
select tests.ok(public.ticket_cancel_deadline(:'o1') < :'starts'::timestamptz, 'heure limite affichée (avant le début du service)');
select tests.login('bob');
select tests.ok(public.ticket_cancel_deadline(:'o1') is null, 'un autre élève ne lit pas l''heure limite');

-- Heure limite dépassée (délai réglé très long pour le test)
select tests.as_service();
update public.settings set value = jsonb_set(value, '{cancel_before_service_minutes}', '100000') where key = 'orders';
select sold_qty as sold0 from public.menu_items where id = tests.item('garba_lunch') \gset
select tests.login('alice');
select balance as b0 from public.wallets where user_id = tests.uid('alice') \gset
select tests.code(public.cancel_ticket(:'o1'), 'NO_REFUND_CONFIRM', 'après l''heure limite : confirmation demandée');
select tests.eq((select status::text from public.tickets where id = :'o1'), 'valid', 'sans confirmation : rien n''est annulé');
select public.cancel_ticket(:'o1', true) as r \gset
select tests.ok((:'r'::jsonb ->> 'ok')::boolean and (:'r'::jsonb ->> 'refunded')::int = 0, 'annulée sans remboursement');
select tests.eq((select balance from public.wallets where user_id = tests.uid('alice')), :b0, 'solde inchangé : pas de remboursement');
select tests.eq((select status::text from public.tickets where id = :'o1'), 'cancelled', 'commande annulée');
select tests.as_service();
select tests.eq((select sold_qty from public.menu_items where id = tests.item('garba_lunch')), :sold0 - 1, 'plat pas encore préparé : remis en vente');
select tests.check_ledger();

-- Avant l'heure limite : toujours remboursée
update public.settings set value = jsonb_set(value, '{cancel_before_service_minutes}', '90') where key = 'orders';
select tests.login('alice');
select public.place_order(tests.item('garba_lunch'), :'starts'::timestamptz + interval '1 hour', '{}', '2580') ->> 'ticket_id' as o2 \gset
select balance as b1 from public.wallets where user_id = tests.uid('alice') \gset
select tests.ok((public.cancel_ticket(:'o2') ->> 'refunded')::int > 0, 'avant l''heure limite : remboursée');
select tests.ok((select balance from public.wallets where user_id = tests.uid('alice')) > :b1, 'solde recrédité');

-- Rappel : l'heure limite tombe dans 20 min
select public.place_order(tests.item('garba_lunch'), :'starts'::timestamptz + interval '1 hour', '{}', '2580') ->> 'ticket_id' as o3 \gset
select tests.as_service();
update public.settings set value = jsonb_set(value, '{cancel_before_service_minutes}',
  to_jsonb(floor(extract(epoch from (:'starts'::timestamptz - now() - interval '20 minutes')) / 60)::int)) where key = 'orders';
select tests.eq(public.remind_cancel_deadlines(), 1, 'rappel envoyé 30 min avant l''heure limite');
select tests.eq(public.remind_cancel_deadlines(), 0, 'une seule fois');
select tests.ok(exists (select 1 from public.notifications where user_id = tests.uid('alice') and type = 'order_cancel_reminder'
                        and body like '%annule avant%'), 'message : « annule avant … tu seras remboursé »');
select tests.login('alice');
select tests.throws($$select public.remind_cancel_deadlines()$$, 'un élève ne déclenche pas les rappels');
rollback;
