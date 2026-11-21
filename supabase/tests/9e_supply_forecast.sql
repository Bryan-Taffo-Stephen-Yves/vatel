-- Achats calés sur les prévisions : portions du guide de production, frais acheté seulement pour ses jours de conservation
begin;
select tests.setup();
select tests.as_service();
-- Jeu de test : demain, attiéké poisson au déjeuner (2 prévus) et au dîner (50 prévus), 0,2 kg de poisson par portion ;
-- pas d'historique ni de ticket → on suit le menu (au moins 5 portions par plat) : 5 + 50 = 55 portions = 11 kg de poisson.
update public.ingredients set shelf_life_days = 2 where name = 'Poisson';   -- stock 10 kg, seuil 9,9

select tests.eq((select need from public._supply_needs() where name = 'Poisson'), 11.00::numeric, 'besoin : 55 portions prévues × 0,2 kg = 11 kg');
select tests.eq((select to_order from public._supply_needs() where name = 'Poisson'), 1.00::numeric,
  'poisson (frais, 2 jours) : on achète juste ce qui manque (11 − 10 = 1 kg), pas de réserve');

update public.ingredients set shelf_life_days = 1 where name = 'Poisson';
select tests.eq((select to_order from public._supply_needs() where name = 'Poisson'), 0::numeric,
  'se garde 1 jour : rien acheté aujourd''hui pour le repas de demain');

update public.ingredients set shelf_life_days = null where name = 'Poisson';
select tests.eq((select to_order from public._supply_needs() where name = 'Poisson'), 20.80::numeric,
  'produit sec : réserve gardée (11 + 2 × 9,9 − 10 = 20,8)');

-- Le chef valide la production du dîner à 20 portions : les achats suivent
update public.ingredients set shelf_life_days = 2 where name = 'Poisson';
update public.menu_items set planned_qty = 20, production_validated_at = now() where id = tests.item('attieke_dinner');
select tests.eq((select need from public._supply_needs() where name = 'Poisson'), 5.00::numeric, 'production validée (20 + 5 portions) : besoin 5 kg');
select tests.eq((select to_order from public._supply_needs() where name = 'Poisson'), 0::numeric, 'stock suffisant : rien à acheter');

-- Plat souvent laissé dans l'assiette : la prévision réduit déjà les portions (champ cut du calcul)
select tests.ok((select bool_and(cut between 0 and 0.25) from public._menu_portions(public.today_abidjan() + 1)), 'réduction des portions entre 0 et 25 %');

-- Fiche de courses de l'employé : même logique (frais sans réserve)
update public.menu_items set production_validated_at = null, planned_qty = 50 where id = tests.item('attieke_dinner');
select tests.ok((select to_buy from public._shopping_needs() where name = 'Poisson') <= 2,
  'fiche de courses : 1 à 2 kg de poisson, pas le seuil complet de 9,9 kg en plus');

-- Droits
select tests.login('alice');
select tests.throws($$select public.admin_forecast(public.today_abidjan())$$, 'élève : pas de prévisions');
select tests.throws($$select public._forecast_core(public.today_abidjan())$$, 'élève : calcul interne inaccessible');
select tests.throws($$select * from public._supply_needs()$$, 'élève : besoins d''achat inaccessibles');
select tests.code(public.ingredient_set_shelf_life((select id from public.ingredients where name = 'Poisson'), 3), 'FORBIDDEN', 'élève : ne règle pas la conservation');
select tests.login('chef');
select tests.ok(public.admin_forecast(public.today_abidjan() + 1) ? 'items', 'chef : prévisions toujours lisibles');
select tests.code(public.ingredient_set_shelf_life((select id from public.ingredients where name = 'Poisson'), 90), 'INVALID', 'conservation > 60 jours refusée');
select tests.ok((public.ingredient_set_shelf_life((select id from public.ingredients where name = 'Poisson'), 3) ->> 'ok')::boolean, 'chef : conservation réglée');
rollback;
