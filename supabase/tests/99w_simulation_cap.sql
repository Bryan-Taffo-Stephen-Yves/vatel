-- Mode démo : recharge simulée plafonnée par jour et par compte
begin;
select tests.setup();
update public.settings set value = value || '{"sim_daily_max": 100000}' where key = 'mobile_money';  -- plafond réel
select tests.login('alice');
select tests.ok((public.simulate_recharge(60000) ->> 'ok')::boolean, 'démo : 60 000 acceptés');
select tests.code(public.simulate_recharge(50000), 'SIMULATION_LIMIT', 'au-delà de 100 000 par jour : refusé');
select tests.ok((public.simulate_recharge(40000) ->> 'ok')::boolean, 'jusqu''au plafond : accepté');
select tests.code(public.simulate_recharge(100), 'SIMULATION_LIMIT', 'plafond atteint');
select tests.as_service();
insert into public.family_links (parent_id, child_id, status) values (tests.uid('bob'), tests.uid('alice'), 'active');
select tests.login('bob');
select tests.code(public.parent_recharge_child(tests.uid('alice'), 1000), 'SIMULATION_LIMIT', 'le parent aussi est plafonné pour ce compte');
rollback;
