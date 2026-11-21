-- Repas du personnel : 1 500 payés par l'école, 1 000 par l'employé (son compte), créneau réservé, 1 par jour
begin;
select tests.setup();
-- Plat du déjeuner servi aujourd'hui, créneau du personnel ouvert maintenant
update public.menu_items set service_date = public.today_abidjan() where id = tests.item('garba_lunch');
update public.settings set value = jsonb_build_object('school_share', 1500, 'per_day', 1,
  'start', to_char((now() - interval '10 minutes') at time zone 'Africa/Abidjan', 'HH24:MI'),
  'end', to_char((now() + interval '10 minutes') at time zone 'Africa/Abidjan', 'HH24:MI')) where key = 'staff_meals';

-- Seul l'admin inscrit le personnel
select tests.login('agent');
select tests.code(public.staff_set(tests.uid('bob'), 'securite'), 'FORBIDDEN', 'l''agent ne peut pas inscrire le personnel');
select tests.code(public.staff_meal_serve(tests.uid('bob'), tests.item('garba_lunch')), 'NOT_STAFF', 'pas inscrit : pas de repas subventionné');
select tests.login('admin');
select tests.ok((public.staff_set(tests.uid('bob'), 'securite') ->> 'ok')::boolean, 'Bob inscrit (sécurité)');
select tests.code(public.staff_set(tests.uid('bob'), 'pilote'), 'INVALID_JOB', 'fonction inconnue refusée');

-- Solde insuffisant
select tests.as_service();
select balance as b0 from public.wallets where user_id = tests.uid('bob') \gset
select public._wallet_move(tests.uid('bob'), 500 - :b0, case when 500 - :b0 < 0 then 'purchase'::public.tx_type else 'bonus'::public.tx_type end) where :b0 <> 500;
select tests.login('agent');
select tests.code(public.staff_meal_serve(tests.uid('bob'), tests.item('garba_lunch')), 'INSUFFICIENT_FUNDS', 'solde < 1 000 : refusé');

-- Comptoir : carte QR → repas servi, 1 000 débités, 1 500 pour l'école
select tests.as_service();
select public._wallet_move(tests.uid('bob'), 2000, 'bonus');
select tests.login('agent');
select tests.eq(jsonb_array_length(public.staff_lookup('DABALI:' || (select short_code from public.profiles where id = tests.uid('bob'))) -> 'results'), 1,
  'carte QR reconnue');
select tests.ok((public.staff_lookup('xx') -> 'window' ->> 'open')::boolean, 'créneau du personnel ouvert');
select public.staff_meal_serve(tests.uid('bob'), tests.item('garba_lunch')) as r \gset
select tests.ok((:'r'::jsonb ->> 'ok')::boolean, 'repas servi');
select tests.eq((:'r'::jsonb ->> 'employee_share')::int, 1000, 'part de l''employé : 1 000');
select tests.eq((:'r'::jsonb ->> 'school_share')::int, 1500, 'part de l''école : 1 500');
select tests.eq((:'r'::jsonb ->> 'balance')::int, 1500, 'compte débité de 1 000 (2 500 → 1 500)');
select tests.code(public.staff_meal_serve(tests.uid('bob'), tests.item('garba_lunch')), 'ALREADY_SERVED', 'un seul repas par jour');
select tests.as_service();
select tests.check_ledger();

-- Hors créneau
update public.settings set value = value || jsonb_build_object(
  'start', to_char((now() + interval '1 hour') at time zone 'Africa/Abidjan', 'HH24:MI'),
  'end', to_char((now() + interval '2 hours') at time zone 'Africa/Abidjan', 'HH24:MI')) where key = 'staff_meals';
update public.staff_meals set service_date = service_date - 1;
select tests.login('agent');
select tests.code(public.staff_meal_serve(tests.uid('bob'), tests.item('garba_lunch')), 'OUTSIDE_WINDOW', 'hors du créneau du personnel : refusé');

-- Administration : totaux (part de l'école), lecture réservée
select tests.login('admin');
select public.staff_overview(public.today_abidjan() - 7, public.today_abidjan()) as o \gset
select tests.eq((:'o'::jsonb -> 'totals' ->> 'school')::int, 1500, 'total payé par l''école');
select tests.eq((:'o'::jsonb -> 'totals' ->> 'meals')::int, 1, '1 repas du personnel');
select tests.login('alice');
select tests.code(public.staff_overview(), 'FORBIDDEN', 'un élève ne voit pas le registre');
select tests.eq((select count(*) from public.staff_meals)::int, 0, 'un élève ne lit pas les repas des autres');
rollback;
