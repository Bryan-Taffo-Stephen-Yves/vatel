-- 14 allergènes, allergies posées par le parent, alerte au parent, étiquettes cuisine, trous dans le menu
begin;
select tests.setup();
select public.today_abidjan() + 1 as d \gset
select (public._service_window(:'d'::date, 'lunch')).starts as starts \gset
select tests.as_service();
update public.settings set value = value || '{"same_day_only": false}' where key = 'orders';
update public.dishes set allergens = '{}', traces = array['céleri'], diet_tags = '{}' where id = (select dish_id from public.menu_items where id = tests.item('attieke_lunch'));

-- 14 allergènes officiels
select tests.eq(cardinality(public._allergen_list()), 14, '14 allergènes officiels');
select tests.login('alice');
select tests.ok((public.set_my_diet(array['sulfites', 'lupin'], '{}') ->> 'ok')::boolean, 'nouveaux allergènes acceptés');
select public.set_my_diet('{}', '{}');

-- Lien parent bob → alice
select tests.as_service();
select short_code as code from public.profiles where id = tests.uid('alice') \gset
select tests.login('bob');
select tests.code(public.parent_set_child_diet(tests.uid('alice'), array['céleri'], '{}'), 'FORBIDDEN', 'pas avant que l''enfant accepte');
select (public.family_request(:'code') ->> 'link_id')::uuid as l \gset
select tests.login('alice');
select public.family_respond(:'l', true);

-- Le parent pose céleri (grave) et arachide ; l'enfant ne peut pas les retirer
select tests.login('bob');
select tests.ok((public.parent_set_child_diet(tests.uid('alice'), array['céleri', 'arachide'], array['céleri']) ->> 'ok')::boolean, 'parent pose les allergies');
select tests.eq(public.family_child_diet(tests.uid('alice')) -> 'severe', '["céleri"]'::jsonb, 'parent voit l''allergie grave');
select tests.login('alice');
select public.set_my_diet(array['lait'], '{}');
select public.set_my_severe_allergies('{}');
select tests.as_service();
select tests.eq((select allergies @> array['céleri', 'arachide', 'lait'] from public.profiles where id = tests.uid('alice')), true, 'enfant ne peut pas retirer les allergies du parent');
select tests.eq((select severe_allergies from public.profiles where id = tests.uid('alice')), array['céleri'], 'ni leur caractère grave');
select tests.ok(exists (select 1 from public.notifications where user_id = tests.uid('alice') and type = 'family_diet'), 'enfant prévenu');

-- Grave posée par le parent : commande bloquée (traces de céleri)
select tests.login('alice');
select public.set_pin('2580');
select public.simulate_recharge(30000);
select tests.code(public.place_order_cart(jsonb_build_array(jsonb_build_object('menu_item_id', tests.item('attieke_lunch'), 'qty', 1)),
  :'starts'::timestamptz + interval '1 hour', '[]', '2580'), 'ALLERGY_SEVERE', 'traces de céleri : bloqué');

-- Plat signalé non grave (régime) : commandé, parent prévenu une fois
select public.set_my_diet(array['lait'], array['vegetarien']);
select tests.ok((public.place_order_cart(jsonb_build_array(jsonb_build_object('menu_item_id', tests.item('garba_lunch'), 'qty', 2)),
  :'starts'::timestamptz + interval '1 hour', '[]', '2580') ->> 'ok')::boolean, 'plat non végétarien commandé quand même');
select tests.as_service();
select tests.eq((select count(*) from public.notifications where user_id = tests.uid('bob') and type = 'child_diet_alert')::int, 1, 'parent prévenu une seule fois');

-- L'élève déclare lui-même « poisson » grave ; le parent le verrouille puis le retire : il reste (c'est celui de l'élève)
select tests.login('alice');
select public.set_my_diet(array['lait', 'poisson'], array['vegetarien']);
select public.set_my_severe_allergies(array['poisson']);
select tests.login('bob');
select public.parent_set_child_diet(tests.uid('alice'), array['céleri', 'arachide', 'poisson'], array['céleri', 'poisson']);
select public.parent_set_child_diet(tests.uid('alice'), array['céleri', 'arachide'], array['céleri']);
select tests.as_service();
select tests.ok((select 'poisson' = any (allergies) and 'poisson' = any (severe_allergies) from public.profiles where id = tests.uid('alice')),
  'le parent ne peut pas effacer l''allergie grave déclarée par l''élève');

-- Deuxième parent : il ne peut pas effacer ce que le premier a posé
insert into public.family_links (parent_id, child_id, status, accepted_at) values (tests.uid('caisse'), tests.uid('alice'), 'active', now());
select tests.login('caisse');
select tests.eq(public.family_child_diet(tests.uid('alice')) -> 'parent_allergies', '[]'::jsonb, 'le 2e parent ne voit que ses propres verrous');
select public.parent_set_child_diet(tests.uid('alice'), array['lait'], '{}');
select tests.as_service();
select tests.ok((select allergies @> array['céleri', 'arachide', 'lait', 'poisson'] and 'céleri' = any (severe_allergies) from public.profiles where id = tests.uid('alice')),
  'le 2e parent n''efface pas les allergies du 1er');
-- Lien retiré : les verrous de ce parent tombent, ceux de l'élève restent
delete from public.family_links where parent_id = tests.uid('bob') and child_id = tests.uid('alice');
select tests.ok((select not ('céleri' = any (allergies)) and 'poisson' = any (allergies) from public.profiles where id = tests.uid('alice')),
  'lien retiré : les allergies posées par ce parent tombent, celles de l''élève restent');

-- Cuisine : étiquettes du client ; production : trous
select tests.login('chef');
select tests.ok(public.kitchen_diet_flags(:'d') -> 'clients' -> (tests.uid('alice')::text) -> 'diets' = '["vegetarien"]'::jsonb, 'cuisine voit le régime du client');
select tests.ok(public.production_diet_gaps(:'d') -> 'gaps' @> '[{"service":"lunch","who":"végétariens"}]'::jsonb, 'aucun plat végétarien au déjeuner : signalé');
select tests.login('alice');
select tests.code(public.kitchen_diet_flags(:'d'), 'FORBIDDEN', 'réservé à la cuisine');
rollback;
