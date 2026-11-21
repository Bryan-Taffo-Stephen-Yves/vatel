-- Gaspillage dans l'assiette : statistiques par plat, accès réservé
begin;
select tests.setup();
select tests.as_service();
select dish_id as dg from public.menu_items where id = tests.item('garba_lunch') \gset
select dish_id as da from public.menu_items where id = tests.item('attieke_lunch') \gset
insert into public.plate_scans (service, dish_id, left_pct, items) values
  ('lunch', :'dg', 60, '[{"name":"Poisson","left_pct":80},{"name":"attiéké","left_pct":40}]'),
  ('lunch', :'dg', 40, '[{"name":"poisson","left_pct":60},{"name":"attiéké","left_pct":10}]'),
  ('lunch', :'da', 5, '[{"name":"attiéké","left_pct":5}]');
-- Photo prise avant de manger (depuis un avis) : ne compte pas
insert into public.plate_scans (service, dish_id, left_pct, items, source, before_meal) values ('lunch', :'da', 100, '[]', 'avis', true);
select tests.login('chef');
select public.plate_waste_stats(public.today_abidjan(), public.today_abidjan()) as s \gset
select tests.eq((:'s'::jsonb ->> 'scans')::int, 3, '3 assiettes comptées (photo d''avant repas ignorée)');
select tests.eq((:'s'::jsonb ->> 'empty_rate')::int, 33, '1 assiette sur 3 vide');
select tests.eq(:'s'::jsonb -> 'dishes' -> 0 ->> 'avg_left', '50', 'plat le plus laissé en premier (50 %)');
select tests.eq(:'s'::jsonb -> 'dishes' -> 0 -> 'worst' -> 0 ->> 'name', 'poisson', 'élément le plus laissé : poisson (casse ignorée)');
select tests.login('alice');
select tests.code(public.plate_waste_stats(public.today_abidjan(), public.today_abidjan()), 'FORBIDDEN', 'réservé à la cuisine');
select tests.eq((select count(*) from public.plate_scans)::int, 0, 'un élève ne lit pas les assiettes');
rollback;
