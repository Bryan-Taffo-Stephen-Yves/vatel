-- Repas du personnel : question du matin « Tu manges à la cantine aujourd'hui ? » (appli + WhatsApp par Jean)
--  · chaque jour de service à 07h30 (Abidjan), une seule fois ; réponses OUI / NON par WhatsApp (ou dans l'appli) ;
--  · la cuisine voit le compte du jour : oui / non / sans réponse (page Équipe).

create table if not exists public.staff_meal_answers (
  user_id      uuid not null references public.profiles (id) on delete cascade,
  service_date date not null,
  answer       boolean not null,
  answered_at  timestamptz not null default now(),
  primary key (user_id, service_date)
);
alter table public.staff_meal_answers enable row level security;
drop policy if exists staff_meal_answers_read on public.staff_meal_answers;
create policy staff_meal_answers_read on public.staff_meal_answers for select to authenticated
  using (user_id = auth.uid() or public.has_role('caissier'));
grant select on public.staff_meal_answers to authenticated;
grant select, insert, update on public.staff_meal_answers to service_role;

-- Envoi de la question (cron 07h30) : une fois par jour, jours de service seulement
create or replace function public.staff_meal_poll() returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_today date := public.today_abidjan();
  v_cfg jsonb := public.setting('staff_meals');
  v_emp int := greatest(coalesce((public.setting('services') -> 'lunch' ->> 'price')::int, 0)
                        - coalesce((v_cfg ->> 'school_share')::int, 0), 0);
  v_n int;
begin
  if not (public.setting('service_days') @> to_jsonb(extract(isodow from v_today)::int)) then return 0; end if;
  insert into public.notifications (user_id, type, title, body, data)
  select p.id, 'staff_meal_poll', 'Tu manges à la cantine aujourd''hui ?',
         'Repas du personnel de ' || (v_cfg ->> 'start') || ' à ' || (v_cfg ->> 'end') || ' · ' || public.format_fcfa(v_emp)
           || ' (l''école paie le reste). Réponds OUI ou NON.',
         jsonb_build_object('buttons', jsonb_build_array('✅ Oui', '❌ Non'), 'date', v_today)
    from public.profiles p
   where p.staff_job is not null and not p.is_blocked
     and not exists (select 1 from public.notifications n where n.user_id = p.id and n.type = 'staff_meal_poll'
                       and n.created_at >= (v_today::timestamp at time zone 'Africa/Abidjan'));
  get diagnostics v_n = row_count;
  return v_n;
end $$;

-- Réponse (Jean sur WhatsApp, côté serveur) : seulement si la question a été posée aujourd'hui
create or replace function public._staff_meal_answer(p_user uuid, p_answer boolean) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_today date := public.today_abidjan(); v_name text;
begin
  select full_name into v_name from public.profiles where id = p_user and staff_job is not null;
  if not found then return jsonb_build_object('ok', false, 'code', 'NOT_STAFF'); end if;
  if not exists (select 1 from public.notifications where user_id = p_user and type = 'staff_meal_poll'
                   and created_at >= (v_today::timestamp at time zone 'Africa/Abidjan')) then
    return jsonb_build_object('ok', false, 'code', 'NO_POLL');
  end if;
  insert into public.staff_meal_answers (user_id, service_date, answer) values (p_user, v_today, p_answer)
  on conflict (user_id, service_date) do update set answer = excluded.answer, answered_at = now();
  return jsonb_build_object('ok', true, 'first_name', split_part(v_name, ' ', 1), 'answer', p_answer,
                            'start', public.setting('staff_meals') ->> 'start', 'end', public.setting('staff_meals') ->> 'end');
end $$;

-- Réponse depuis l'appli (membre du personnel connecté)
create or replace function public.staff_meal_answer(p_answer boolean) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare r jsonb;
begin
  if auth.uid() is null then return public._fail('AUTH_REQUIRED', 'Connexion requise.'); end if;
  r := public._staff_meal_answer(auth.uid(), p_answer);
  if not (r ->> 'ok')::boolean then return public._fail(r ->> 'code', 'Pas de question en cours aujourd''hui.'); end if;
  return r;
end $$;

-- Vue d'ensemble du personnel : + réponses du jour (pour la cuisine)
create or replace function public.staff_overview(p_from date default date_trunc('month', public.today_abidjan())::date,
                                                 p_to date default public.today_abidjan()) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_cfg jsonb := public.setting('staff_meals'); v_today date := public.today_abidjan();
begin
  if not public.has_role('caissier') then return public._fail('FORBIDDEN', 'Réservé à l''administration.'); end if;
  return jsonb_build_object('ok', true, 'settings', v_cfg,
    'price', coalesce((public.setting('services') -> 'lunch' ->> 'price')::int, 0),
    'totals', (select jsonb_build_object('meals', count(*), 'school', coalesce(sum(school_share), 0), 'employees', coalesce(sum(employee_share), 0))
                 from public.staff_meals where service_date between p_from and p_to),
    'answers', (select jsonb_build_object(
                  'yes', count(*) filter (where a.answer),
                  'no', count(*) filter (where a.answer = false),
                  'none', count(*) filter (where a.answer is null))
                  from public.profiles p left join public.staff_meal_answers a on a.user_id = p.id and a.service_date = v_today
                 where p.staff_job is not null and not p.is_blocked),
    'staff', coalesce((
      select jsonb_agg(jsonb_build_object('id', p.id, 'full_name', p.full_name, 'short_code', p.short_code, 'phone', p.phone,
               'job', p.staff_job, 'balance', w.balance, 'whatsapp', exists (select 1 from public.whatsapp_links l where l.user_id = p.id),
               'answer', (select a.answer from public.staff_meal_answers a where a.user_id = p.id and a.service_date = v_today),
               'meals', (select count(*) from public.staff_meals s where s.user_id = p.id and s.service_date between p_from and p_to),
               'today', exists (select 1 from public.staff_meals s where s.user_id = p.id and s.service_date = v_today))
             order by p.full_name)
        from public.profiles p join public.wallets w on w.user_id = p.id
       where p.staff_job is not null), '[]'::jsonb));
end $$;

-- La question part aussi sur WhatsApp
create or replace function public._whatsapp_dispatch() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_url text := public.setting('jean') ->> 'function_url';
begin
  if v_url is null or to_regproc('net.http_post') is null then return null; end if;
  if new.type not in ('order_placed', 'order_preparing', 'order_ready', 'order_pickup_reminder', 'order_missed', 'menu_changed',
                      'voice_code', 'order_link', 'order_cancel_reminder', 'staff_meal_poll',
                      'low_balance', 'child_low_balance', 'child_diet_alert', 'family_request', 'family_diet') then return null; end if;
  if not exists (select 1 from public.whatsapp_links where user_id = new.user_id) then return null; end if;
  perform net.http_post(
    url := v_url,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-jean-secret', public._jean_secret()),
    body := jsonb_build_object('notification_id', new.id));
  return null;
exception when others then
  return null;
end $$;

revoke all on function public.staff_meal_poll(), public._staff_meal_answer(uuid, boolean) from public, anon, authenticated;
grant execute on function public.staff_meal_poll(), public._staff_meal_answer(uuid, boolean) to service_role;
revoke all on function public.staff_meal_answer(boolean) from public, anon;
grant execute on function public.staff_meal_answer(boolean) to authenticated;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('vatel-staff-meal-poll', '30 7 * * *', 'select public.staff_meal_poll()');
  end if;
end $$;
