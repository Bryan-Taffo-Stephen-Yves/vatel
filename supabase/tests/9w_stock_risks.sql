-- Ruptures : risque prévu (besoin d'aujourd'hui / demain > stock + en route), « stock bas » au chef ET à l'admin
begin;
select tests.setup();
select tests.as_service();
-- Demain : 55 portions d'attiéké poisson prévues × 0,2 kg = 11 kg de poisson ; stock 10 kg → manque 1 kg
select public._stock_risks() as r \gset
select tests.eq(jsonb_array_length(:'r'::jsonb), 1, 'un risque de rupture détecté');
select tests.eq(:'r'::jsonb -> 0 ->> 'name', 'Poisson', 'sur le poisson');
select tests.eq((:'r'::jsonb -> 0 ->> 'missing')::numeric, 1.00::numeric, 'il manque 1 kg');
select tests.eq(:'r'::jsonb -> 0 ->> 'day_label', 'demain', 'pour demain');

-- Des courses en cours couvrent le manque : plus de risque
insert into public.shopping_lists (status) values ('assigned') returning id as l \gset
insert into public.shopping_items (list_id, ingredient_id, label, qty, unit)
  values (:'l', (select id from public.ingredients where name = 'Poisson'), 'Poisson', 2, 'kg');
select tests.eq(jsonb_array_length(public._stock_risks()), 0, 'courses en route : risque levé');
delete from public.shopping_lists where id = :'l';

-- Écran : équipe seulement
select tests.login('chef');
select tests.eq(jsonb_array_length(public.stock_risks() -> 'risks'), 1, 'chef : voit le risque');
select tests.login('caisse');
select tests.ok((public.stock_risks() ->> 'ok')::boolean, 'caisse : voit aussi');
select tests.login('alice');
select tests.code(public.stock_risks(), 'FORBIDDEN', 'élève : non');
select tests.throws($$select public._stock_risks()$$, 'élève : fonction interne inaccessible');

-- Le point des achats annonce le risque
select tests.as_service();
update public.settings set value = '{"enabled": true, "time": "00:00", "last_sent_on": null}' where key = 'shopping_brief';
select public._shopping_brief();
select tests.ok((select bool_and(title like '⚠️%' and body like 'Risque de rupture : Poisson%') from public.notifications where type = 'shopping_brief'),
  'point des achats : « ⚠️ Risque de rupture : Poisson »');

-- Stock bas : chef ET admin prévenus, avec lien vers Stock
insert into public.stock_movements (ingredient_id, type, qty, reason)
  values ((select id from public.ingredients where name = 'Poisson'), 'loss', 2, 'test');
select tests.eq((select count(*) from public.notifications n join public.profiles p on p.id = n.user_id
                  where n.type = 'stock_low' and p.role in ('chef', 'admin'))::int, 2, 'stock bas : chef et admin prévenus');
select tests.ok((select bool_and(data ->> 'href' = '/admin/stock') from public.notifications where type = 'stock_low'), 'lien vers Stock');
rollback;
