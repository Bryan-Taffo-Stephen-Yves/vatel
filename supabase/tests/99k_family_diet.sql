-- Guide Vatel : régimes / allergies et comptes parents
begin;
select tests.setup();

-- Allergies et régime
select tests.login('alice');
select tests.code(public.set_my_diet(array['plutonium'], '{}'), 'INVALID', 'allergie inconnue refusée');
select tests.ok((public.set_my_diet(array['arachide', 'poisson'], array['vegetarien']) ->> 'ok')::boolean, 'allergies et régime enregistrés');
select tests.eq(public._diet_conflicts(array['arachide'], '{}', array['arachide', 'gluten'], '{}'), array['contient arachide'], 'plat avec arachide signalé');
select tests.eq(public._diet_conflicts('{}', array['vegetarien'], '{}', array['sans_porc']), array['pas végétarien'], 'plat non végétarien signalé');
select tests.eq(cardinality(public._diet_conflicts(array['lait'], array['sans_porc'], array['gluten'], array['sans_porc'])), 0, 'plat compatible : aucune raison');

select tests.eq(public._diet_conflicts('{}', array['sans_piment'], '{}', array['pimente', 'sans_porc']), array['pimenté (demande-le sans piment)'], 'plat pimenté signalé à qui ne mange pas fort');
select tests.ok((public.set_my_diet('{}', array['sans_piment']) ->> 'ok')::boolean, 'préférence « pas pimenté » enregistrée');

-- Parent : bob (compte parent, WhatsApp vérifié, numéro enregistré par l'école) suit alice
select tests.as_service();
select short_code as code from public.profiles where id = tests.uid('alice') \gset
select tests.login('bob');
select tests.code(public.parent_recharge_child(tests.uid('alice'), 5000), 'FORBIDDEN', 'pas de recharge sans lien');
select tests.as_service();
update public.profiles set is_parent = true where id = tests.uid('bob');
insert into public.whatsapp_links (user_id, phone) values (tests.uid('bob'), '+2250505050505');
insert into public.guardian_phones (child_id, phone, label) values (tests.uid('alice'), '+2250505050505', 'Père');
select tests.login('bob');
select tests.code(public.family_request('DB-0000'), 'NOT_FOUND', 'code inconnu');
select (public.family_request(lower(:'code')) ->> 'link_id')::uuid as l \gset

select tests.as_service();
select tests.ok(exists (select 1 from public.notifications where user_id = tests.uid('alice') and type = 'family_request'), 'enfant prévenu');
select tests.eq((select status from public.family_links where id = :'l'), 'active', 'numéro vérifié par l''école : lien actif tout de suite');

select tests.as_service();
select balance as before from public.wallets where user_id = tests.uid('alice') \gset
select tests.login('bob');
select tests.ok((public.parent_recharge_child(tests.uid('alice'), 5000) ->> 'ok')::boolean, 'parent recharge l''enfant');
select tests.as_service();
select tests.eq((select balance from public.wallets where user_id = tests.uid('alice')), :before + 5000, 'solde de l''enfant crédité');
select tests.login('bob');
select tests.ok((public.family_overview() -> 'children' -> 0 ->> 'balance')::int = :before + 5000, 'parent voit le solde');
select tests.code(public.parent_recharge_child(tests.uid('alice'), 5), 'INVALID_AMOUNT', 'montant trop petit refusé');

-- Solde bas de l'enfant → alerte au parent
select tests.as_service();
insert into public.notifications (user_id, type, title, body) values (tests.uid('alice'), 'low_balance', 'Solde bas', 'x');
select tests.ok(exists (select 1 from public.notifications where user_id = tests.uid('bob') and type = 'child_low_balance'), 'parent alerté du solde bas');

-- Un autre compte ne voit rien
select tests.login('chef');
select tests.eq(jsonb_array_length(public.family_overview() -> 'children'), 0, 'autre compte : aucun enfant');
select tests.code(public.parent_recharge_child(tests.uid('alice'), 5000), 'FORBIDDEN', 'autre compte : pas de recharge');

-- Délier
select tests.login('alice');
select tests.ok((public.family_unlink(:'l') ->> 'ok')::boolean, 'enfant peut délier');
rollback;
