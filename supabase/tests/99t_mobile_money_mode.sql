-- Interrupteur simulation / argent réel : en argent réel, la recharge simulée est refusée par la base
begin;
select tests.setup();
select tests.login('alice');
select tests.ok((public.simulate_recharge(1000) ->> 'ok')::boolean, 'simulation (par défaut) : recharge démo acceptée');
select tests.as_service();
update public.settings set value = '{"mode": "jeko"}' where key = 'mobile_money';
insert into public.family_links (parent_id, child_id, status) values (tests.uid('bob'), tests.uid('alice'), 'active');
select tests.login('alice');
select tests.code(public.simulate_recharge(1000), 'SIMULATION_OFF', 'argent réel : recharge simulée refusée');
select tests.login('bob');
select tests.code(public.parent_recharge_child(tests.uid('alice'), 1000), 'SIMULATION_OFF', 'argent réel : recharge parent simulée refusée');
select tests.login('alice');
select tests.ok((public.payment_start(2000, 'wave', '+2250701020304') ->> 'ok')::boolean, 'argent réel : le paiement Jèko reste possible');
rollback;
