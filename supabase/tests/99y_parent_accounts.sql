-- Comptes parents : un élève ne peut pas se faire « parrainer » par un ami
begin;
select tests.setup();
select short_code as code from public.profiles where id = tests.uid('alice') \gset

-- 1. Un compte élève ne peut suivre personne (même avec WhatsApp)
select tests.as_service();
insert into public.whatsapp_links (user_id, phone) values (tests.uid('bob'), '+2250505050505');
select tests.login('bob');
select tests.code(public.family_request(:'code'), 'PARENT_ONLY', 'élève (ami) : refusé');

-- 2. Compte parent sans WhatsApp vérifié : refusé
select tests.as_service();
update public.profiles set is_parent = true where id = tests.uid('caisse');
select tests.login('caisse');
select tests.code(public.family_request(:'code'), 'WHATSAPP_REQUIRED', 'parent sans WhatsApp vérifié : refusé');

-- 3. Compte parent avec WhatsApp, mais numéro non enregistré par l'école : refusé
select tests.as_service();
insert into public.whatsapp_links (user_id, phone) values (tests.uid('caisse'), '+2250707070707');
select tests.login('caisse');
select tests.code(public.family_request(:'code'), 'NOT_GUARDIAN', 'numéro inconnu de l''école : refusé');

-- 4. L'admin enregistre le numéro du parent (saisi sur 10 chiffres) ; seul l'admin peut le faire
select tests.code(public.guardian_set(:'code', '0707070707', 'Mère'), 'FORBIDDEN', 'la caisse ne peut pas enregistrer un parent');
select tests.login('admin');
select tests.eq(public.guardian_set(:'code', '07 07 07 07 07', 'Mère') -> 'phones' -> 0 ->> 'phone', '+2250707070707', 'numéro enregistré au format +225');
select tests.code(public.guardian_set('DB-0000', '0707070707'), 'NOT_FOUND', 'élève inconnu');

-- 5. Le vrai parent est accepté tout de suite ; un parent ne peut pas être suivi comme un élève
select tests.login('caisse');
select tests.eq(public.family_request(:'code') ->> 'status', 'active', 'parent vérifié : lien actif');
select tests.ok((public.payment_start(2000, 'wave', '+2250707070707', tests.uid('alice')) ->> 'ok')::boolean, 'le parent peut payer la recharge de l''enfant');
select short_code as pcode from public.profiles where id = tests.uid('caisse') \gset
select tests.code(public.family_request(:'pcode'), 'NOT_FOUND', 'on ne suit pas un compte parent');

-- 6. Numéro retiré par l'école : le lien tombe
select tests.login('admin');
select public.guardian_set(:'code', '0707070707', null, true);
select tests.as_service();
select tests.eq((select count(*) from public.family_links where child_id = tests.uid('alice'))::int, 0, 'numéro retiré : le parent ne suit plus l''élève');
select tests.login('alice');
select tests.code(public.guardian_list(:'code'), 'FORBIDDEN', 'un élève ne voit pas les numéros de ses parents enregistrés');
rollback;
