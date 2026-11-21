-- Guide de production : proposition (reprises + marge), validation du chef, restes, apprentissage des reprises
begin;
select tests.setup();
select public.today_abidjan() + 1 as d \gset

-- Accès réservé à la cuisine
select tests.login('alice');
select tests.throws($$select public.production_plan(public.today_abidjan() + 1)$$, 'client : guide de production interdit');
select tests.code(public.validate_production(:'d'::date, '[]'), 'FORBIDDEN', 'client : validation interdite');

-- 60 tickets déjeuner valables demain → des repas attendus
select tests.as_service();
insert into public.tickets (user_id, buyer_id, service, total, valid_from, valid_until)
select tests.uid('alice'), tests.uid('alice'), 'lunch', 2500, now(), (public.service_window(:'d'::date, 'lunch')).ends_at
  from generate_series(1, 60);
select tests.login('chef');
select public.production_plan(:'d'::date) as p \gset
select tests.ok(jsonb_array_length(:'p'::jsonb -> 'items') > 0, 'plan : des plats proposés');
select tests.ok(bool_and((i ->> 'proposed')::int >= (i ->> 'expected')::int and (i ->> 'proposed')::int % 5 = 0),
  'proposé ≥ attendus, arrondi à 5') from jsonb_array_elements(:'p'::jsonb -> 'items') i;
select tests.ok((select jsonb_array_length(i -> 'ingredients') > 0 and (i -> 'ingredients' -> 0 ->> 'qty')::numeric = round(0.2 * (i ->> 'portions')::int, 2)
  from jsonb_array_elements(:'p'::jsonb -> 'items') i where (i ->> 'id')::uuid = tests.item('attieke_lunch')), 'ingrédients = recette × portions');
select tests.ok((:'p'::jsonb ->> 'validated_all')::boolean = false, 'rien de validé au départ');

-- Reprises : un plat très repris est proposé plus haut qu'un plat peu repris à demande égale
select tests.as_service();
update public.dishes set seconds_rate = 0.50 where id = (select dish_id from menu_items where id = tests.item('garba_lunch'));
select tests.login('chef');
select tests.ok((select (i ->> 'proposed')::int from jsonb_array_elements(public.production_plan(:'d'::date) -> 'items') i where (i ->> 'id')::uuid = tests.item('garba_lunch'))
  > (select (i ->> 'proposed')::int from jsonb_array_elements(:'p'::jsonb -> 'items') i where (i ->> 'id')::uuid = tests.item('garba_lunch')),
  'reprises 50 % : proposition plus haute');

-- Validation : planned_qty et prepared_qty fixés, proposition gardée
select tests.ok((public.validate_production(:'d'::date, jsonb_build_array(jsonb_build_object('id', tests.item('garba_lunch'), 'qty', 120))) ->> 'ok')::boolean, 'chef : quantité validée');
select tests.eq((select planned_qty from public.menu_items where id = tests.item('garba_lunch')), 120, 'limite de vente = 120');
select tests.eq((select prepared_qty from public.menu_items where id = tests.item('garba_lunch')), 120, 'production = 120');
select tests.ok((select proposed_qty is not null and production_validated_at is not null from public.menu_items where id = tests.item('garba_lunch')), 'proposition et validation gardées');
select tests.ok((select (i ->> 'validated')::boolean and (i ->> 'portions')::int = 120 from jsonb_array_elements(public.production_plan(:'d'::date) -> 'items') i where (i ->> 'id')::uuid = tests.item('garba_lunch')),
  'plan : quantité validée affichée');
select tests.as_service();
update public.menu_items set sold_qty = 30 where id = tests.item('garba_lunch');
select tests.login('chef');
select tests.code(public.validate_production(:'d'::date, jsonb_build_array(jsonb_build_object('id', tests.item('garba_lunch'), 'qty', 20))), 'BELOW_SOLD', 'pas moins que les portions déjà réservées');

-- Restes : enregistrés, bornés, et comptés comme gaspillage
select tests.code(public.record_leftovers(jsonb_build_array(jsonb_build_object('id', tests.item('garba_lunch'), 'leftover', 500))), 'INVALID_QTY', 'restes > préparé refusés');
select tests.ok((public.record_leftovers(jsonb_build_array(jsonb_build_object('id', tests.item('garba_lunch'), 'leftover', 8))) ->> 'ok')::boolean, 'restes enregistrés');
select tests.eq((public.admin_waste(:'d'::date, :'d'::date) ->> 'lost')::int, 8, 'gaspillage = restes saisis');

-- Apprentissage : 120 préparés, 8 restes, 80 servis → 32 reprises = 40 % observé, mélangé à l'a priori
select tests.as_service();
update public.dishes set seconds_rate = 0.10 where id = (select dish_id from menu_items where id = tests.item('garba_lunch'));
update public.menu_items set served_qty = 80 where id = tests.item('garba_lunch');
select tests.eq((select observed from public._dish_seconds(:'d'::date + 1) s where s.dish_id = (select dish_id from menu_items where id = tests.item('garba_lunch'))), 0.400, 'reprises observées : 40 %');
select tests.eq((select rate from public._dish_seconds(:'d'::date + 1) s where s.dish_id = (select dish_id from menu_items where id = tests.item('garba_lunch'))), 0.150, 'mélange avec l''a priori : (1×40 % + 5×10 %) / 6 = 15 %');

-- Menu publié → le chef est prévenu
select tests.as_service();
update public.menus set status = 'submitted' where id = (select menu_id from menu_items where id = tests.item('garba_lunch'));
update public.menus set status = 'published' where id = (select menu_id from menu_items where id = tests.item('garba_lunch'));
select tests.ok(exists (select 1 from public.notifications where user_id = tests.uid('chef') and type = 'production_ready'), 'chef prévenu : guide de production prêt');
rollback;
