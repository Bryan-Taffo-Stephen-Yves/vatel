-- Statistiques du parent : repas, dépenses, dernière recharge, cadeaux et envois — lien ACTIF obligatoire
begin;
select tests.setup();
select tests.as_service();
update public.profiles set is_parent = true where id = tests.uid('bob');
insert into public.family_links (parent_id, child_id, status, accepted_at) values (tests.uid('bob'), tests.uid('alice'), 'active', now());

select tests.login('alice');
select public.set_pin('2580');
select public.simulate_recharge(20000);
select public.purchase_tickets('lunch', 2, '{}', '2580') as p \gset
select tests.ok((:'p'::jsonb ->> 'ok')::boolean, 'Alice achète 2 tickets');
select tests.ok((public.purchase_tickets('lunch', 1, '{}', '2580', tests.uid('agent')) ->> 'ok')::boolean, 'Alice offre un repas à un camarade');
select tests.ok((public.transfer_funds(tests.uid('agent'), 1000, '2580') ->> 'ok')::boolean, 'Alice envoie 1 000 F à un camarade');

-- Un repas servi aujourd'hui
select tests.as_service();
update public.tickets set status = 'used', used_at = now()
 where id = (select id from public.tickets where user_id = tests.uid('alice') order by created_at limit 1);
select balance as bal from public.wallets where user_id = tests.uid('alice') \gset
select coalesce(-sum(amount), 0) as spent from public.transactions where user_id = tests.uid('alice') and type = 'purchase' \gset

select tests.login('bob');
select public.family_child_stats(tests.uid('alice'), 'week') as s \gset
select tests.ok((:'s'::jsonb ->> 'ok')::boolean, 'parent lié : statistiques lisibles');
select tests.eq(jsonb_array_length(:'s'::jsonb -> 'days'), 5, 'ligne de 5 jours (lundi → vendredi)');
select tests.eq((:'s'::jsonb ->> 'meals')::int, 1, '1 repas pris');
select tests.eq((:'s'::jsonb ->> 'spent')::int, :spent, 'montant dépensé = achats (dont le repas offert)');
select tests.eq((:'s'::jsonb -> 'last_recharge' ->> 'amount')::int, 20000, 'dernière recharge : 20 000 F');
select tests.eq((:'s'::jsonb -> 'last_recharge' ->> 'left')::int, least(20000 - :spent - 1000, :bal), 'reste de la recharge = 20 000 − dépenses − envoi');
select tests.eq(jsonb_array_length(:'s'::jsonb -> 'gifts'), 1, 'repas offert listé à part');
select tests.eq(:'s'::jsonb -> 'gifts' -> 0 ->> 'to', 'Agent Yao', 'repas offert : à qui');
select tests.eq((:'s'::jsonb -> 'transfers' -> 0 ->> 'amount')::int, 1000, 'argent envoyé listé à part');
select tests.ok((public.family_child_stats(tests.uid('alice'), 'month') ->> 'meals')::int >= 1, 'période « ce mois »');
select tests.ok((public.family_child_stats(tests.uid('alice'), 'since_recharge') ->> 'ok')::boolean, 'période « depuis la dernière recharge »');

-- Sans lien actif : rien
select tests.login('agent');
select tests.code(public.family_child_stats(tests.uid('alice'), 'week'), 'FORBIDDEN', 'compte non lié : refusé');
select tests.login('alice');
select tests.code(public.family_child_stats(tests.uid('bob'), 'week'), 'FORBIDDEN', 'l''enfant ne lit pas les stats de son parent');
select tests.as_service();
update public.family_links set status = 'pending' where parent_id = tests.uid('bob');
select tests.login('bob');
select tests.code(public.family_child_stats(tests.uid('alice'), 'week'), 'FORBIDDEN', 'lien en attente : refusé');
select tests.as_anon();
select tests.throws($$select public.family_child_stats('00000000-0000-0000-0000-00000000a001', 'week')$$, 'visiteur : refusé');
rollback;
