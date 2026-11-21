-- Affluence par le rythme des scans au comptoir : écarts courts = beaucoup de monde, écarts qui s'allongent = la file diminue
begin;
select tests.setup();
select tests.as_service();
-- Dîner de demain, on regarde à 19h
create temp table _s as select public.today_abidjan() + 1 d,
  (public.today_abidjan() + 1 + time '18:00')::timestamp at time zone 'Africa/Abidjan' t0,
  (public.today_abidjan() + 1 + time '21:00')::timestamp at time zone 'Africa/Abidjan' t1,
  (public.today_abidjan() + 1 + time '19:00')::timestamp at time zone 'Africa/Abidjan' t;
create function pg_temp.scan(p_at timestamptz) returns void language sql as $$
  insert into public.tickets (user_id, buyer_id, service, service_date, dish_id, total, valid_from, valid_until, status, used_at)
  select tests.uid('alice'), tests.uid('alice'), 'dinner', (select d from _s), (select dish_id from public.menu_items where id = tests.item('attieke_dinner')), 2500,
         (select t0 from _s), (select t1 from _s) + interval '6 hours', 'used', p_at
$$;

-- 1. Rush qui monte : avant, un scan par minute ; maintenant, un toutes les 15 s
select pg_temp.scan((select t from _s) - make_interval(secs => x)) from unnest(array[0, 15, 30, 45, 60, 75, 135, 195, 255, 315, 375]) x;
select public._scan_rhythm((select t from _s)) as r \gset
select tests.eq((:'r')::jsonb ->> 'level', 'high', 'un scan toutes les 15 s : forte affluence');
select tests.eq(((:'r')::jsonb ->> 'interval_s')::int, 15, 'intervalle médian : 15 s');
select tests.eq(((:'r')::jsonb ->> 'per_min')::numeric, 4.0, '4 passages par minute');
select tests.eq((:'r')::jsonb ->> 'trend', 'rising', 'écarts 4 fois plus courts qu''avant : la file grossit');
select tests.ok((:'r')::jsonb ->> 'text' like 'Un passage toutes les 15 s au comptoir : forte affluence. Les passages s''accélèrent%', 'phrase claire pour l''équipe');
select tests.eq(jsonb_array_length((:'r')::jsonb -> 'gaps'), 10, '10 écarts pour le petit graphique');
select tests.eq(((:'r')::jsonb -> 'gaps' ->> 9)::int, 15, 'le dernier écart (le plus récent) est à droite');

-- 2. Deux minutes et demie sans scan : le comptoir s'est vidé
select public._scan_rhythm((select t from _s) + interval '150 seconds') as r2 \gset
select tests.eq((:'r2')::jsonb ->> 'trend', 'falling', 'plus de scan depuis 150 s : la file diminue');
select tests.eq((:'r2')::jsonb ->> 'level', 'low', 'c''est calme');

-- 3. Une heure plus tard : écarts qui passent de 15 s à 45 s
select pg_temp.scan((select t from _s) + interval '1 hour' - make_interval(secs => x)) from unnest(array[0, 45, 90, 135, 180, 225, 240, 255, 270, 285, 300]) x;
select public._scan_rhythm((select t from _s) + interval '1 hour') as r3 \gset
select tests.eq((:'r3')::jsonb ->> 'level', 'mid', 'un scan toutes les 45 s : affluence moyenne');
select tests.eq((:'r3')::jsonb ->> 'trend', 'falling', 'écarts 3 fois plus longs : la file diminue');

-- 4. Personne
select public._scan_rhythm((select t from _s) + interval '3 hours') as r4 \gset
select tests.eq((:'r4')::jsonb ->> 'level', 'none', 'aucun scan : rien à dire');

-- 5. Pilote : renfort proposé quand le comptoir est sous pression et que la caméra ne voit pas la file
select public._pilot_rhythm('{"suggestions": [], "queue_count": null}', (select d from _s), 'dinner', (select t from _s)) as p \gset
select tests.ok(exists (select 1 from jsonb_array_elements((:'p')::jsonb -> 'suggestions') s where s ->> 'kind' = 'queue'
  and s ->> 'title' = 'Comptoir sous pression' and s ->> 'text' like 'Un passage toutes les 15 s, et ça s''accélère%'), 'pilote : renfort proposé');
select tests.eq((:'p')::jsonb -> 'rhythm' ->> 'level', 'high', 'pilote : le rythme est affiché');
select tests.ok(not exists (select 1 from jsonb_array_elements(public._pilot_rhythm('{"suggestions": [], "queue_count": 4}', (select d from _s), 'dinner', (select t from _s)) -> 'suggestions') s
  where s ->> 'kind' = 'queue'), 'la caméra voit une petite file : pas de renfort');
select tests.ok(not exists (select 1 from jsonb_array_elements(public._pilot_rhythm('{"suggestions": [], "queue_count": null}', (select d from _s), 'dinner', (select t from _s) + interval '150 seconds') -> 'suggestions') s
  where s ->> 'kind' = 'queue'), 'la file diminue : pas de renfort');
select public._pilot_do((select d from _s), 'dinner', 'dismiss', 'queue', null, (select t from _s));
select tests.ok(not exists (select 1 from jsonb_array_elements(public._pilot_rhythm('{"suggestions": [], "queue_count": null}', (select d from _s), 'dinner', (select t from _s) + interval '1 minute') -> 'suggestions') s
  where s ->> 'kind' = 'queue'), 'renfort écarté : ne revient pas pendant 20 min');

-- Droits
select tests.login('alice');
select tests.code(public.scan_rhythm(), 'FORBIDDEN', 'élève : pas de rythme du comptoir');
select tests.login('agent');
select tests.ok(public.scan_rhythm() ->> 'ok' = 'true', 'agent : voit le rythme');
select tests.login('chef');
select tests.ok(public.pilot_state() ->> 'ok' = 'true', 'chef : le pilote répond toujours');
rollback;
