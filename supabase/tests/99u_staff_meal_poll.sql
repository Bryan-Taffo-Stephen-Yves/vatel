-- Question du matin au personnel : une fois par jour, réponses OUI / NON, compte pour la cuisine
begin;
select tests.setup();
update public.settings set value = '[1,2,3,4,5,6,7]' where key = 'service_days';
update public.profiles set staff_job = 'securite' where id = tests.uid('bob');
update public.profiles set staff_job = 'entretien' where id = tests.uid('alice');

select tests.eq(public._staff_meal_answer(tests.uid('bob'), true) ->> 'code', 'NO_POLL', 'pas de réponse avant la question');
select tests.eq(public.staff_meal_poll(), 2, 'question envoyée aux 2 membres du personnel');
select tests.eq(public.staff_meal_poll(), 0, 'une seule fois par jour');
select tests.ok(exists (select 1 from public.notifications where user_id = tests.uid('bob') and type = 'staff_meal_poll'
                        and data -> 'buttons' ? '✅ Oui'), 'boutons Oui / Non');
select tests.ok((public._staff_meal_answer(tests.uid('bob'), true) ->> 'ok')::boolean, 'Bob répond OUI (WhatsApp)');
select tests.eq(public._staff_meal_answer(tests.uid('agent'), true) ->> 'code', 'NOT_STAFF', 'pas du personnel : ignoré (Jean répond normalement)');
select tests.login('alice');
select tests.ok((public.staff_meal_answer(false) ->> 'ok')::boolean, 'Alice répond NON (appli)');
select tests.login('admin');
select public.staff_overview() as o \gset
select tests.eq(:'o'::jsonb -> 'answers', '{"yes": 1, "no": 1, "none": 0}'::jsonb, 'compte du jour : 1 oui, 1 non');
select tests.as_service();
select tests.ok((public._staff_meal_answer(tests.uid('bob'), false) ->> 'ok')::boolean, 'Bob change d''avis');
select tests.eq((select answer from public.staff_meal_answers where user_id = tests.uid('bob')), false, 'réponse mise à jour');
select tests.login('bob');
select tests.throws($$select public.staff_meal_poll()$$, 'un employé ne déclenche pas la question');
rollback;
