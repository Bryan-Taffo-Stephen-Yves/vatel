-- Page « Point achats » (/admin/fournisseurs) : elle lit supplier_orders et supply_events directement.
-- Vérifie que seuls la cuisine et l'administration voient les commandes fournisseurs (prix, fournisseurs, appels).
begin;
select tests.setup();
select tests.as_service();
insert into public.supplier_orders (supplier_name, call_phone, items, budget, status, quoted_total, origin)
values ('Grossiste test', '+2250700000000', '[{"label": "sacs de riz", "qty": 2, "usual_price": 20000}]', 40000, 'refuse', 52000, 'agent')
returning id as o \gset
insert into public.supply_events (order_id, kind, message) values (:'o', 'refuse', 'Prix trop haut : 52 000 F au lieu de 40 000 F');

select tests.login('chef');
select tests.eq((select count(*) from public.supplier_orders)::int, 1, 'chef : voit les commandes fournisseurs');
select tests.eq((select count(*) from public.supply_events where order_id = :'o')::int, 1, 'chef : voit le journal (raison du refus)');
select tests.login('admin');
select tests.eq((select count(*) from public.supplier_orders)::int, 1, 'admin : voit les commandes fournisseurs');
select tests.login('alice');
select tests.eq((select count(*) from public.supplier_orders)::int, 0, 'élève : ne voit rien');
select tests.eq((select count(*) from public.supply_events)::int, 0, 'élève : ne voit pas le journal');
select tests.login('agent');
select tests.eq((select count(*) from public.supplier_orders)::int, 0, 'agent du comptoir : ne voit rien');
select tests.login('chef');
select tests.throws($$update public.supplier_orders set status = 'commande'$$, 'page en lecture seule : le statut ne se modifie pas en direct');
rollback;
