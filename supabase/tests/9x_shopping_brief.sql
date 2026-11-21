-- Point des achats envoyé au chef et à l'admin : une fois par jour à l'heure réglée, ou à la demande
begin;
select tests.setup();
select tests.as_service();
-- Demain : attiéké poisson prévu → il manque du poisson (liste non vide)
update public.settings set value = '{"enabled": true, "time": "00:00", "last_sent_on": null}' where key = 'shopping_brief';
select public._shopping_brief() as r \gset
select tests.ok((:'r'::jsonb ->> 'sent')::boolean, 'heure passée : point envoyé');
select tests.ok((:'r'::jsonb ->> 'items')::int >= 1, 'au moins un article à acheter');
select tests.eq((select count(*) from public.notifications where type = 'shopping_brief')::int, 2, 'chef et admin prévenus (2 notifications)');
select tests.ok((select bool_and(data ->> 'href' = '/admin/courses') from public.notifications where type = 'shopping_brief'), 'lien vers la page Courses');
select tests.ok((select count(*) = 0 from public.notifications n join public.profiles p on p.id = n.user_id
                  where n.type = 'shopping_brief' and p.role not in ('chef', 'admin')), 'personne d''autre ne reçoit le point');
select tests.eq(public._shopping_brief() ->> 'why', 'already_sent', 'une seule fois par jour');

update public.settings set value = '{"enabled": true, "time": "23:59", "last_sent_on": null}' where key = 'shopping_brief';
select tests.ok((public._shopping_brief() ->> 'why') in ('too_early', 'already_sent') or now() at time zone 'Africa/Abidjan' >= current_date + time '23:59',
  'avant l''heure : rien');
update public.settings set value = '{"enabled": false, "time": "00:00", "last_sent_on": null}' where key = 'shopping_brief';
select tests.eq(public._shopping_brief() ->> 'why', 'disabled', 'désactivé : rien');

-- À la demande (page Courses)
select tests.login('alice');
select tests.code(public.shopping_brief_send(), 'FORBIDDEN', 'élève : non');
select tests.throws($$select public._shopping_brief(true)$$, 'élève : fonction interne inaccessible');
select tests.login('agent');
select tests.code(public.shopping_brief_send(), 'FORBIDDEN', 'agent du comptoir : non');
select tests.login('chef');
select tests.ok((public.shopping_brief_send() ->> 'sent')::boolean, 'chef : point envoyé à la demande');
select tests.as_service();
select tests.eq((select count(*) from public.notifications where type = 'shopping_brief')::int, 4, 'chef et admin prévenus à nouveau');

-- Rien à acheter : pas de point
update public.ingredients set stock_qty = 1000;
select tests.login('admin');
select tests.code(public.shopping_brief_send(), 'NOTHING', 'liste vide : pas de point envoyé');
rollback;
