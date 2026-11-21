-- Caméra sur téléphone : seuls les agents envoient des relevés ; l'affluence passe en « direct »
begin;
select tests.setup();
select tests.as_service();
insert into public.rooms (name, total_tables) values ('Réfectoire', 4);
select tests.login('alice');
select tests.code(public.vision_report(5, 2, 4, 3, 1, 16, 9), 'FORBIDDEN', 'un élève ne peut pas envoyer de relevé');
select tests.login('agent');
select public.vision_report(5, 2, 4, 3, 1, 16, 9) as r \gset
select tests.ok((:'r'::jsonb ->> 'ok')::boolean, 'agent : relevé enregistré');
select tests.as_service();
select tests.ok((select queue_count = 3 and occupied_tables = 2 and seats_free = 9 and rate = 50 from public.occupancy_snapshots order by id desc limit 1),
  'relevé : 3 dans la file, 2 tables sur 4 (50 %), 9 places libres');
select tests.login('agent');
select tests.ok((public.vision_report(6, 2, 4, 3, 1, 16, 9) ->> 'skipped')::boolean, 'pas plus d''un relevé toutes les 5 s');
rollback;
