-- Palmarès des plats (avis du mois, repas servis, % laissé) et gaspillage pris en compte dans les prévisions
begin;
select tests.setup();
\set d '(public.today_abidjan() + 1)'
select tests.as_service();

-- Données du mois : 3 plats notés (un avis = un repas servi)
create temp table _dish as select id, name from public.dishes;
create function pg_temp.rate(p_dish text, p_stars int[], p_user text default 'alice') returns void language sql as $$
  with t as (
    insert into public.tickets (user_id, buyer_id, service, service_date, dish_id, total, valid_from, valid_until, status, used_at)
    select tests.uid(p_user), tests.uid(p_user), 'lunch', public.today_abidjan(), (select id from public.dishes where name = p_dish), 2500,
           now() - interval '3 hours', now() + interval '1 hour', 'used', now() - interval '2 hours'
      from unnest(p_stars) returning id, dish_id)
  insert into public.ratings (ticket_id, user_id, dish_id, stars)
  select t.id, tests.uid(p_user), t.dish_id, s.stars
    from (select id, dish_id, row_number() over () rn from t) t
    join (select stars, row_number() over () rn from unnest(p_stars) stars) s on s.rn = t.rn
$$;
select pg_temp.rate('Garba', array[5, 5, 5, 5, 5, 5, 5, 5]);
select pg_temp.rate('Attiéké poisson braisé', array[4, 4, 3, 4]);
select pg_temp.rate('Plateau VIP', array[2, 1, 3]);
-- Assiettes rendues : le Plateau VIP revient à moitié plein
insert into public.plate_scans (service_date, service, dish_id, left_pct, source)
select public.today_abidjan() - 1, 'lunch', (select id from _dish where name = 'Plateau VIP'), p, 'agent' from unnest(array[50, 60, 40]) p;
insert into public.plate_scans (service_date, service, dish_id, left_pct, source)
select public.today_abidjan() - 1, 'lunch', (select id from _dish where name = 'Garba'), p, 'agent' from unnest(array[0, 10, 5]) p;

select tests.login('alice');
select tests.code(public.dish_leaderboard(), 'FORBIDDEN', 'élève : pas de palmarès');
select tests.login('chef');
select public.dish_leaderboard() as lb \gset
select tests.eq((:'lb')::jsonb -> 'best' -> 0 ->> 'name', 'Garba', 'le plus aimé : Garba (8 avis à 5★)');
select tests.eq((:'lb')::jsonb -> 'worst' -> 0 ->> 'name', 'Plateau VIP', 'le moins aimé : Plateau VIP');
select tests.eq(((:'lb')::jsonb -> 'worst' -> 0 ->> 'left_pct')::int, 50, '% laissé dans l''assiette : 50 %');
select tests.eq(((:'lb')::jsonb -> 'best' -> 0 ->> 'ratings')::int, 8, 'nombre d''avis');
select tests.ok(((:'lb')::jsonb ->> 'advice') like 'Le plus aimé : « Garba » (5,0★%Le moins aimé : « Plateau VIP » (2,0★, 50 % laissé%réduire la portion%',
  'phrase de conseil au chef');
select tests.eq(jsonb_array_length((:'lb')::jsonb -> 'best') + jsonb_array_length((:'lb')::jsonb -> 'worst'), 3, 'un plat n''est jamais dans les deux listes');

-- Un plat noté une seule fois à 5★ ne passe pas devant un plat très bien noté souvent
select tests.as_service();
insert into public.dishes (name, category_id, base_price) select 'Nouveau plat', category_id, 2000 from public.dishes limit 1;
select pg_temp.rate('Nouveau plat', array[5], 'bob');
select tests.login('chef');
select tests.eq(public.dish_leaderboard() -> 'best' -> 0 ->> 'name', 'Garba', 'note pondérée par le nombre d''avis');

-- Mois sans avis
select tests.ok((public.dish_leaderboard(public.today_abidjan() - 400) ->> 'advice') like 'Pas encore d''avis%', 'mois sans avis : message clair');

-- Prévisions : le % laissé réduit les besoins en ingrédients et donne un conseil
select tests.as_service();
insert into public.menu_items (menu_id, service_date, service, dish_id, price, planned_qty)
select (select menu_id from public.menu_items where id = tests.item('vip_dinner')), :d, 'lunch', id, 6000, 40 from public.dishes where name = 'Plateau VIP';
insert into public.recipe_lines (dish_id, ingredient_id, qty_per_portion)
select (select id from public.dishes where name = 'Plateau VIP'), id, 1 from public.ingredients where name = 'Poisson';
select tests.login('chef');
select public.admin_forecast(:d) as f \gset
select tests.eq((select (i ->> 'left_pct')::int from jsonb_array_elements((:'f')::jsonb -> 'items') i where i ->> 'dish' = 'Plateau VIP' and i ->> 'service' = 'lunch'), 50,
  'prévisions : % laissé du plat');
select tests.eq((select (i ->> 'portion_cut')::int from jsonb_array_elements((:'f')::jsonb -> 'items') i where i ->> 'dish' = 'Plateau VIP' and i ->> 'service' = 'lunch'), 25,
  'prévisions : portions réduites de 25 % (moitié de 50 %)');
select tests.ok(((:'f')::jsonb -> 'waste_advice' ->> 0) like '« Plateau VIP » : 50 % laissé%réduites de 25 %%revoir la recette%', 'prévisions : conseil au chef');
select tests.ok(not exists (select 1 from jsonb_array_elements_text((:'f')::jsonb -> 'waste_advice') a where a like '%Garba%'), 'plat presque fini : pas de conseil');
select tests.ok((select (i ->> 'left_pct') is null from jsonb_array_elements((:'f')::jsonb -> 'items') i where i ->> 'dish' = 'Attiéké poisson braisé' limit 1),
  'moins de 3 assiettes : pas de % laissé');
rollback;
