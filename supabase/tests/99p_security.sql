-- Durcissement : fonctions internes fermées, réglages techniques réservés à l'équipe
begin;
select tests.setup();
select tests.as_service();
insert into public.settings (key, value) values ('jean', '{"green_api_id": "123"}')
  on conflict (key) do update set value = excluded.value;

-- Fonctions internes : refusées aux visiteurs et aux élèves
select tests.as_anon();
select tests.throws($$select public._supply_event(gen_random_uuid(), 'note', 'faux')$$, 'visiteur : pas de faux événement fournisseur');
select tests.throws($$select public._delivery_event(gen_random_uuid(), 'note', 'faux')$$, 'visiteur : pas de faux événement de livraison');
select tests.login('alice');
select tests.throws($$select public._order_summary(tests.uid('bob'), 1, current_date)$$, 'élève : ne lit pas la commande d''un autre');
select tests.throws($$select public._recompute_diet(tests.uid('bob'))$$, 'élève : pas d''appel direct à _recompute_diet');

-- Réglages privés
select tests.as_anon();
select tests.ok(public.setting('jean') is null, 'visiteur : réglage WhatsApp caché (setting)');
select tests.ok(not exists (select 1 from public.settings where key = 'jean'), 'visiteur : réglage WhatsApp caché (table)');
select tests.ok(public.setting('services') is not null, 'visiteur : horaires des services toujours lisibles');
select tests.login('alice');
select tests.ok(public.setting('jean') is null, 'élève : réglage WhatsApp caché');
select tests.ok(exists (select 1 from public.settings where key = 'orders'), 'élève : réglages de commande lisibles');
select tests.login('agent');
select tests.ok(public.setting('jean') is not null, 'agent : réglage WhatsApp lisible');
select tests.login('admin');
select tests.ok(exists (select 1 from public.settings where key = 'jean'), 'admin : tous les réglages lisibles');

-- Les fonctions du serveur lisent toujours les réglages privés et utilisent les fonctions internes
select tests.login('alice');
select tests.ok((public.family_overview() ->> 'ok')::boolean, 'élève : la vue famille marche toujours');
select public.set_my_diet(array['arachide'], array[]::text[]) as r \gset
select tests.ok((:'r'::jsonb ->> 'ok')::boolean, 'élève : modifier ses allergies marche toujours (_recompute_diet interne)');
rollback;
