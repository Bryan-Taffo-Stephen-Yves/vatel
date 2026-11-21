-- Rapport du lundi : bilan de la semaine passée, notification au chef et à l'admin, contexte enrichi de l'assistant du menu
begin;
select tests.setup();
select tests.as_service();
\set lw '(public.today_abidjan() - 7)'
-- un instant de la semaine passée (mercredi midi)
create temp table _w as select ((:lw - (extract(isodow from :lw)::int - 1)) + 2)::timestamp at time zone 'Africa/Abidjan' + interval '12 hours' as t0;
create function pg_temp.rate(p_dish text, p_stars int[], p_complaints text[] default '{}', p_comment text default null, p_photo text default null)
returns void language sql as $$
  with t as (
    insert into public.tickets (user_id, buyer_id, service, service_date, dish_id, total, valid_from, valid_until, status, used_at)
    select tests.uid('alice'), tests.uid('alice'), 'lunch', ((select t0 from _w) at time zone 'Africa/Abidjan')::date,
           (select id from public.dishes where name = p_dish), 2500, (select t0 from _w) - interval '1 hour', (select t0 from _w) + interval '2 hours',
           'used', (select t0 from _w) from unnest(p_stars) returning id, dish_id)
  insert into public.ratings (ticket_id, user_id, dish_id, stars, complaints, comment, photo_path, created_at)
  select t.id, tests.uid('alice'), t.dish_id, s.stars, p_complaints, p_comment, p_photo, (select t0 from _w) + interval '30 minutes'
    from (select id, dish_id, row_number() over () rn from t) t
    join (select stars, row_number() over () rn from unnest(p_stars) stars) s on s.rn = t.rn
$$;
select pg_temp.rate('Garba', array[5, 5, 5, 5, 5, 4], '{}', 'Le meilleur garba de la semaine, bien pimenté !');
select pg_temp.rate('Plateau VIP', array[2, 2], array['fade', 'trop_sale'], 'Le poisson était fade et le riz trop salé.', 'u/vip.jpg');
select pg_temp.rate('Plateau VIP', array[1], array['fade']);
insert into public.plate_scans (service_date, service, dish_id, left_pct, source)
select ((select t0 from _w) at time zone 'Africa/Abidjan')::date, 'lunch', (select id from public.dishes where name = 'Plateau VIP'), p, 'agent'
  from unnest(array[50, 40]) p;

select tests.login('alice');
select tests.code(public.weekly_report(), 'FORBIDDEN', 'élève : pas de rapport');
select tests.login('chef');
select public.weekly_report() as r \gset
select tests.eq((:'r')::jsonb -> 'best' -> 0 ->> 'name', 'Garba', 'à garder : Garba');
select tests.eq((:'r')::jsonb -> 'worst' -> 0 ->> 'name', 'Plateau VIP', 'à revoir : Plateau VIP');
select tests.eq(((:'r')::jsonb -> 'worst' -> 0 ->> 'left_pct')::int, 45, '% laissé dans l''assiette (photos) : 45 %');
select tests.eq((:'r')::jsonb -> 'worst' -> 0 ->> 'top_complaint', 'fade', 'plainte la plus fréquente : fade (3 fois, trop salé 2 fois)');
select tests.eq((:'r')::jsonb -> 'complaints' -> 0 ->> 'code', 'fade', 'plaintes par type, la plus fréquente d''abord');
select tests.eq(((:'r')::jsonb ->> 'served')::int, 9, '9 repas servis la semaine passée');
select tests.eq(jsonb_array_length((:'r')::jsonb -> 'photos'), 2, 'photos d''assiettes de la semaine (2 avis avec photo)');
select tests.ok(exists (select 1 from jsonb_array_elements((:'r')::jsonb -> 'comments') c where c ->> 'comment' like 'Le poisson était fade%'), 'commentaire négatif marquant');
select tests.ok((:'r')::jsonb -> 'advice' ->> 0 like 'À garder : « Garba » 😍%', 'conseil : à garder');
select tests.ok((:'r')::jsonb -> 'advice' ->> 1 like 'À revoir : « Plateau VIP » %45 % laissé, surtout « fade » : réduire la portion%', 'conseil : à revoir, avec le % laissé et la plainte');
select tests.eq((public.weekly_report(public.today_abidjan() - 400) ->> 'ratings')::int, 0, 'semaine sans avis : rapport vide, sans erreur');

-- Lundi 8h : notification au chef et à l'admin (pas aux élèves), avec le lien vers le rapport
select tests.as_service();
select tests.ok(public.send_weekly_report() >= 2, 'rapport envoyé au chef et à l''admin');
select tests.ok(exists (select 1 from public.notifications where user_id = tests.uid('chef') and type = 'weekly_report'
  and body like 'À garder : Garba 😍 · À revoir : Plateau VIP (45 % laissé)' and data ->> 'href' like '/admin/rapports/semaine?semaine=%'), 'notification du chef : courte et avec le lien');
select tests.ok(not exists (select 1 from public.notifications where user_id = tests.uid('alice') and type = 'weekly_report'), 'pas de rapport pour les élèves');

-- Assistant du menu : % laissé, types de plaintes, avis récents et conseils de la semaine passée
select tests.login('chef');
select public.menu_ai_context((public.today_abidjan() - (extract(isodow from public.today_abidjan())::int - 1)) + 7) as c \gset
select tests.ok(exists (select 1 from jsonb_array_elements((:'c')::jsonb -> 'plats') p where p ->> 'nom' = 'Plateau VIP'
  and (p -> 'plaintes_types_30j' ->> 'fade')::int = 3 and (p -> 'plaintes_types_30j' ->> 'trop_sale')::int = 2 and (p ->> 'laisse_pct_30j')::int = 45 and jsonb_array_length(p -> 'avis_recents') = 2),
  'assistant : % laissé, types de plaintes et avis récents du plat');
select tests.ok(jsonb_typeof((:'c')::jsonb -> 'rapport_semaine_passee' -> 'conseils') = 'array', 'assistant : conseils du rapport de la semaine passée');
rollback;
