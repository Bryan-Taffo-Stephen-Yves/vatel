-- Caméra réglée depuis l'ordinateur : zones partagées, photo de réglage à la demande, réservée à l'équipe, effacée en 24 h
begin;
select tests.setup();
select '[{"id":"t1","kind":"table","seats":4,"x":0.1,"y":0.2,"w":0.2,"h":0.15},{"id":"q","kind":"queue","seats":0,"x":0.6,"y":0.1,"w":0.3,"h":0.5}]'::jsonb as z \gset

-- L'admin (ordinateur) demande une photo, puis trace les zones
select tests.login('admin');
select tests.ok((public.vision_snapshot_request() ->> 'ok')::boolean, 'admin : demande une photo de réglage');
-- Le téléphone (agent) voit la demande et envoie la photo
select tests.login('agent');
select tests.ok((public.vision_setup_get() ->> 'snapshot_requested_at') is not null, 'téléphone : voit la demande de photo');
select tests.code(public.vision_snapshot_put('data:image/png;base64,AAAA'), 'INVALID', 'photo autre que JPEG refusée');
select tests.code(public.vision_snapshot_put('data:image/jpeg;base64,' || repeat('A', 700000)), 'INVALID', 'photo trop lourde refusée');
select tests.ok((public.vision_snapshot_put('data:image/jpeg;base64,/9j/AAAA') ->> 'ok')::boolean, 'téléphone : envoie la photo');
select tests.ok((public.vision_setup_get() ->> 'snapshot') is null, 'téléphone (agent) : ne relit pas la photo');
select tests.ok((public.vision_setup_get() ->> 'snapshot_requested_at') is null, 'demande satisfaite');
select tests.code(public.vision_snapshot_request(), 'FORBIDDEN', 'agent : ne demande pas de photo');

select tests.login('admin');
select tests.ok((public.vision_setup_get() ->> 'snapshot') like 'data:image/jpeg%', 'admin : voit la photo pour tracer');
select tests.code(public.vision_zones_save('[{"id":"x","kind":"porte","x":0,"y":0,"w":0.2,"h":0.2}]'), 'INVALID', 'type de zone inconnu refusé');
select tests.code(public.vision_zones_save('[{"id":"x","kind":"table","seats":40,"x":0,"y":0,"w":0.2,"h":0.2}]'), 'INVALID', 'plus de 20 places refusé');
select tests.code(public.vision_zones_save('[{"id":"x","kind":"table","seats":4,"x":1.4,"y":0,"w":0.2,"h":0.2}]'), 'INVALID', 'zone hors de l''image refusée');
select tests.ok((public.vision_zones_save(:'z') ->> 'ok')::boolean, 'admin : zones enregistrées');

-- Le téléphone reprend les zones
select tests.login('agent');
select tests.eq(jsonb_array_length(public.vision_setup_get() -> 'zones'), 2, 'téléphone : reçoit les 2 zones');

-- Personne d'autre
select tests.login('alice');
select tests.code(public.vision_setup_get(), 'FORBIDDEN', 'élève : rien');
select tests.code(public.vision_snapshot_put('data:image/jpeg;base64,/9j/AAAA'), 'FORBIDDEN', 'élève : ne peut pas envoyer de photo');
select tests.code(public.vision_zones_save(:'z'), 'FORBIDDEN', 'élève : ne peut pas changer les zones');
select tests.throws($$select * from public.vision_setup$$, 'table illisible en direct');
select tests.login('caisse');
select tests.code(public.vision_setup_get(), 'FORBIDDEN', 'caisse : rien');

-- Photo de plus de 24 h : effacée pour de bon ; et effaçable d'un clic
select tests.as_service();
update public.vision_setup set snapshot_at = now() - interval '25 hours' where id = 1;
select tests.login('admin');
select tests.ok((public.vision_setup_get() ->> 'snapshot') is null, 'photo de plus de 24 h : plus renvoyée');
select tests.as_service();
select tests.ok((select snapshot is null from public.vision_setup where id = 1), 'photo de plus de 24 h : supprimée de la base');
select tests.login('agent');
select public.vision_snapshot_put('data:image/jpeg;base64,/9j/BBBB');
select tests.login('chef');
select tests.ok((public.vision_snapshot_clear() ->> 'ok')::boolean, 'chef : efface la photo');
select tests.as_service();
select tests.ok((select snapshot is null and zones <> '[]' from public.vision_setup where id = 1), 'photo effacée, zones gardées');
rollback;
