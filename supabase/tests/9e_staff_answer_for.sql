-- Personnel sans WhatsApp : le chef d'équipe / l'administration répond « mange / ne mange pas » à sa place
begin;
select tests.setup();
select tests.login('admin');
select tests.ok((public.staff_set(tests.uid('bob'), 'securite') ->> 'ok')::boolean, 'Bob inscrit au personnel');

select tests.login('agent');
select tests.code(public.staff_meal_answer_for(tests.uid('bob'), true), 'FORBIDDEN', 'l''agent ne répond pas pour le personnel');
select tests.login('alice');
select tests.code(public.staff_meal_answer_for(tests.uid('bob'), true), 'FORBIDDEN', 'un élève ne répond pas pour le personnel');

select tests.login('admin');
select tests.code(public.staff_meal_answer_for(tests.uid('alice'), true), 'NOT_STAFF', 'pas du personnel : refusé');
select tests.ok((public.staff_meal_answer_for(tests.uid('bob'), true) ->> 'ok')::boolean, 'admin : Bob mange (sans question WhatsApp)');
select tests.ok((public.staff_overview() -> 'answers' ->> 'yes')::int >= 1, 'compté « oui » pour la cuisine');
select tests.ok((public.staff_meal_answer_for(tests.uid('bob'), false) ->> 'ok')::boolean, 'réponse changée en « non »');
select tests.ok((select answer = false from public.staff_meal_answers where user_id = tests.uid('bob') and service_date = public.today_abidjan()), 'réponse « non » enregistrée');
select tests.ok((public.staff_meal_answer_for(tests.uid('bob'), null) ->> 'ok')::boolean, 'réponse effacée');
select tests.ok(not exists (select 1 from public.staff_meal_answers where user_id = tests.uid('bob')), 'plus de réponse');
select tests.ok(exists (select 1 from public.audit_log where action = 'staff_meal_answer_for'), 'tracé dans le journal');
rollback;
