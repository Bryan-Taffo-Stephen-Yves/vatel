-- Personnel de l'école (entretien, sécurité, administration…) : repas subventionné (décision du 20/11)
--  · l'admin ajoute l'employé (page Équipe) ; il reçoit une carte QR (son code DB-…), smartphone facultatif ;
--  · au comptoir, sur un créneau réservé (14h00 → 14h45 par défaut), l'agent scanne la carte et choisit le plat ;
--  · prix du déjeuner (2 500) = part de l'école (1 500, réglable) + part de l'employé (1 000), payée avec son compte ;
--  · 1 repas par jour (réglable) ; registre des repas et totaux pour l'administration (part payée par l'école).

alter table public.profiles add column if not exists staff_job text
  check (staff_job in ('entretien', 'securite', 'administration', 'cuisine', 'autre'));
grant select (staff_job) on public.profiles to authenticated;

insert into public.settings (key, value) values ('staff_meals',
  '{"school_share": 1500, "start": "14:00", "end": "14:45", "per_day": 1}')
on conflict (key) do nothing;

create table if not exists public.staff_meals (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references public.profiles (id),
  menu_item_id   uuid references public.menu_items (id) on delete set null,
  dish_id        uuid references public.dishes (id) on delete set null,
  service_date   date not null,
  price          int  not null check (price >= 0),
  school_share   int  not null check (school_share >= 0),
  employee_share int  not null check (employee_share >= 0),
  transaction_id uuid references public.transactions (id),
  agent_id       uuid references public.profiles (id),
  created_at     timestamptz not null default now()
);
create index if not exists staff_meals_day_idx on public.staff_meals (service_date, user_id);
alter table public.staff_meals enable row level security;
drop policy if exists staff_meals_read on public.staff_meals;
create policy staff_meals_read on public.staff_meals for select to authenticated
  using (user_id = auth.uid() or public.has_role('caissier'));
grant select on public.staff_meals to authenticated;
grant select, insert, update on public.staff_meals to service_role;

-- Créneau du personnel aujourd'hui (heure d'Abidjan)
create or replace function public._staff_window(p_date date default public.today_abidjan(),
                                                OUT starts_at timestamptz, OUT ends_at timestamptz)
language sql stable security definer set search_path = public, pg_temp as $$
  select (p_date + coalesce(public.setting('staff_meals') ->> 'start', '14:00')::time) at time zone 'Africa/Abidjan',
         (p_date + coalesce(public.setting('staff_meals') ->> 'end', '14:45')::time) at time zone 'Africa/Abidjan'
$$;

-- Admin : marquer / retirer un membre du personnel
create or replace function public.staff_set(p_user uuid, p_job text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not public.has_role('admin') then return public._fail('FORBIDDEN', 'Réservé à l''administration.'); end if;
  if p_job is not null and p_job not in ('entretien', 'securite', 'administration', 'cuisine', 'autre') then
    return public._fail('INVALID_JOB', 'Fonction inconnue.');
  end if;
  update public.profiles set staff_job = p_job where id = p_user;
  if not found then return public._fail('USER_NOT_FOUND', 'Personne introuvable.'); end if;
  perform public._audit('staff_set', p_user::text, jsonb_build_object('job', p_job));
  return jsonb_build_object('ok', true);
end $$;

-- Admin / caisse : liste du personnel et totaux de la période
create or replace function public.staff_overview(p_from date default date_trunc('month', public.today_abidjan())::date,
                                                 p_to date default public.today_abidjan()) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_cfg jsonb := public.setting('staff_meals');
begin
  if not public.has_role('caissier') then return public._fail('FORBIDDEN', 'Réservé à l''administration.'); end if;
  return jsonb_build_object('ok', true, 'settings', v_cfg,
    'price', coalesce((public.setting('services') -> 'lunch' ->> 'price')::int, 0),
    'totals', (select jsonb_build_object('meals', count(*), 'school', coalesce(sum(school_share), 0), 'employees', coalesce(sum(employee_share), 0))
                 from public.staff_meals where service_date between p_from and p_to),
    'staff', coalesce((
      select jsonb_agg(jsonb_build_object('id', p.id, 'full_name', p.full_name, 'short_code', p.short_code, 'phone', p.phone,
               'job', p.staff_job, 'balance', w.balance,
               'meals', (select count(*) from public.staff_meals s where s.user_id = p.id and s.service_date between p_from and p_to),
               'today', exists (select 1 from public.staff_meals s where s.user_id = p.id and s.service_date = public.today_abidjan()))
             order by p.full_name)
        from public.profiles p join public.wallets w on w.user_id = p.id
       where p.staff_job is not null), '[]'::jsonb));
end $$;

-- Comptoir : retrouver un membre du personnel (carte QR « DABALI:DB-1234 », code ou nom)
create or replace function public.staff_lookup(p_query text) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_q text := regexp_replace(upper(btrim(coalesce(p_query, ''))), '^DABALI:', '');
  v_code text;
  v_win record;
  v_cfg jsonb := public.setting('staff_meals');
begin
  if not public.has_role('agent') then return public._fail('FORBIDDEN', 'Compte agent requis.'); end if;
  if v_q ~ '^(DB)?[- ]?[0-9]{4,6}$' then v_code := 'DB-' || regexp_replace(v_q, '\D', '', 'g'); end if;
  select * into v_win from public._staff_window();
  return jsonb_build_object('ok', true,
    'window', jsonb_build_object('start', v_cfg ->> 'start', 'end', v_cfg ->> 'end', 'open', now() between v_win.starts_at and v_win.ends_at),
    'results', coalesce((
      select jsonb_agg(jsonb_build_object('id', p.id, 'full_name', p.full_name, 'short_code', p.short_code, 'job', p.staff_job,
               'avatar', p.avatar, 'balance', w.balance, 'blocked', p.is_blocked,
               'meals_today', (select count(*) from public.staff_meals s where s.user_id = p.id and s.service_date = public.today_abidjan()))
             order by p.full_name)
        from public.profiles p join public.wallets w on w.user_id = p.id
       where p.staff_job is not null
         and (case when v_code is not null then p.short_code = v_code
                   when length(v_q) >= 3 then p.full_name ilike '%' || replace(replace(v_q, '%', ''), '_', '') || '%'
                   else false end)), '[]'::jsonb));
end $$;

-- Comptoir : servir le repas subventionné (part de l'employé débitée de son compte)
create or replace function public.staff_meal_serve(p_user uuid, p_menu_item_id uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := auth.uid();
  v_cfg jsonb := public.setting('staff_meals');
  v_price int := coalesce((public.setting('services') -> 'lunch' ->> 'price')::int, 0);
  v_school int;
  v_emp int;
  v_p public.profiles;
  v_mi record;
  v_win record;
  v_hits text[];
  v_balance int;
  v_tx public.transactions;
begin
  if not public.has_role('agent') then return public._fail('FORBIDDEN', 'Compte agent requis.'); end if;
  select * into v_p from public.profiles where id = p_user;
  if not found or v_p.staff_job is null then return public._fail('NOT_STAFF', 'Cette personne n''est pas inscrite au repas du personnel.'); end if;
  if v_p.is_blocked then return public._fail('ACCOUNT_BLOCKED', 'Compte bloqué.'); end if;
  select * into v_win from public._staff_window();
  if now() not between v_win.starts_at and v_win.ends_at then
    return public._fail('OUTSIDE_WINDOW', 'Repas du personnel de ' || (v_cfg ->> 'start') || ' à ' || (v_cfg ->> 'end') || ' seulement.');
  end if;
  perform pg_advisory_xact_lock(hashtext('staff_meal:' || p_user::text));
  if (select count(*) from public.staff_meals where user_id = p_user and service_date = public.today_abidjan())
     >= coalesce((v_cfg ->> 'per_day')::int, 1) then
    return public._fail('ALREADY_SERVED', v_p.full_name || ' a déjà pris son repas aujourd''hui.');
  end if;

  select mi.*, d.name as dish_name into v_mi
    from public.menu_items mi join public.menus m on m.id = mi.menu_id join public.dishes d on d.id = mi.dish_id
   where mi.id = p_menu_item_id and m.status = 'published'
     and mi.service_date = public.today_abidjan() and mi.service = 'lunch'
     for no key update of mi;
  if not found then return public._fail('WRONG_ITEM', 'Ce plat n''est pas au menu du déjeuner d''aujourd''hui.'); end if;
  if v_mi.is_sold_out or v_mi.is_full then return public._fail('SOLD_OUT', v_mi.dish_name || ' est épuisé.'); end if;
  select public._severe_hits(v_p.severe_allergies, d.allergens, d.traces) into v_hits from public.dishes d where d.id = v_mi.dish_id;
  if cardinality(v_hits) > 0 then
    return public._fail('ALLERGY_SEVERE', 'Allergie grave : ' || v_mi.dish_name || ' contient ' || array_to_string(v_hits, ', ') || '. Servez un autre plat.');
  end if;

  v_school := least(coalesce((v_cfg ->> 'school_share')::int, 0), v_price);
  v_emp := v_price - v_school;
  select balance into v_balance from public.wallets where user_id = p_user for update;
  if v_balance < v_emp then
    return public._fail('INSUFFICIENT_FUNDS', 'Solde insuffisant (' || public.format_fcfa(v_balance) || ') : il faut '
      || public.format_fcfa(v_emp) || '. Rechargez à la caisse.', jsonb_build_object('balance', v_balance));
  end if;
  if v_emp > 0 then
    v_tx := public._wallet_move(p_user, -v_emp, 'purchase', p_performed_by => v_uid,
              p_note => 'Repas du personnel · ' || v_mi.dish_name || ' (part école : ' || public.format_fcfa(v_school) || ')');
  end if;
  insert into public.staff_meals (user_id, menu_item_id, dish_id, service_date, price, school_share, employee_share, transaction_id, agent_id)
  values (p_user, v_mi.id, v_mi.dish_id, public.today_abidjan(), v_price, v_school, v_emp, v_tx.id, v_uid);
  update public.menu_items set sold_qty = sold_qty + 1, served_qty = served_qty + 1 where id = v_mi.id;
  insert into public.stock_movements (ingredient_id, type, qty, reason, menu_item_id, created_by)
  select rl.ingredient_id, 'out', rl.qty_per_portion, 'Repas du personnel', v_mi.id, v_uid
    from public.recipe_lines rl where rl.dish_id = v_mi.dish_id;
  perform public._notify(p_user, 'staff_meal', 'Bon appétit 🍽️',
    v_mi.dish_name || ' · ' || public.format_fcfa(v_emp) || ' payés (l''école paie ' || public.format_fcfa(v_school) || ').');
  return jsonb_build_object('ok', true, 'dish', v_mi.dish_name, 'full_name', v_p.full_name,
                            'employee_share', v_emp, 'school_share', v_school,
                            'balance', (select balance from public.wallets where user_id = p_user));
end $$;

revoke all on function public._staff_window(date) from public, anon, authenticated;
revoke all on function public.staff_set(uuid, text), public.staff_overview(date, date), public.staff_lookup(text),
  public.staff_meal_serve(uuid, uuid) from public, anon;
grant execute on function public.staff_set(uuid, text), public.staff_overview(date, date), public.staff_lookup(text),
  public.staff_meal_serve(uuid, uuid) to authenticated;
