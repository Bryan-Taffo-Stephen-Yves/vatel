-- Bons invités (délégations, visite du ministère…) : repas payés par l'école, sans compte.
--  · la caisse ou l'admin crée un événement (nom, jour, repas, nombre d'invités, plats prévus) ;
--  · un ticket par invité, au nom du compte système « Réceptions de l'école » (il ne se connecte jamais) :
--    même chemin que les élèves au comptoir (scan, choix du plat, portions, stock), à 0 F pour les portefeuilles ;
--  · le coût est pris sur le budget « Réceptions » du mois (réglage) : seuls les repas servis ou encore valables
--    comptent, un bon non utilisé revient au budget tout seul à la fin du service ;
--  · QR imprimé « VATEL-INVITE:<ticket>.<code secret> » (le code secret = qr_nonce du ticket, 128 bits) ;
--  · la cuisine compte les invités en plus des clients habituels (prévisions, guide de production) ;
--  · ligne « Réceptions » dans les rapports.

insert into public.settings (key, value) values ('guest_budget', '{"monthly": 300000}') on conflict (key) do nothing;

-- ───────── Compte système « Réceptions de l'école » (sans mot de passe ni identité : aucune connexion possible) ─────────
create or replace function public._guest_profile() returns uuid language sql immutable set search_path = public, pg_temp as $$
  select '00000000-0000-4000-8000-00000000ec01'::uuid
$$;

-- jetons à '' (comme le seed) : des jetons NULL font échouer la liste des utilisateurs du tableau de bord Supabase
insert into auth.users (instance_id, id, aud, role, email, encrypted_password, raw_app_meta_data, raw_user_meta_data,
                        confirmation_token, recovery_token, email_change_token_new, email_change, created_at, updated_at)
values ('00000000-0000-0000-0000-000000000000', public._guest_profile(), 'authenticated', 'authenticated', 'receptions@ecole.invalid',
        null, '{"provider":"system"}', '{"full_name":"Réceptions de l''école"}', '', '', '', '', now(), now())
on conflict (id) do nothing;
update public.profiles set is_blocked = true, full_name = 'Réceptions de l''école' where id = public._guest_profile();

-- ───────── Événements et bons ─────────
create table if not exists public.guest_events (
  id           uuid primary key default gen_random_uuid(),
  name         text not null check (length(btrim(name)) between 2 and 80),
  service_date date not null,
  service      public.service_kind not null,
  guests       int  not null check (guests between 1 and 300),
  unit_price   int  not null check (unit_price >= 0),          -- prix d'un repas (réglage des services) au moment de la création
  dishes       jsonb not null default '[]',                   -- plats prévus [{menu_item_id, name, qty}] (indication pour la cuisine)
  note         text check (length(note) <= 300),
  cancelled_at timestamptz,
  created_by   uuid references public.profiles (id),
  created_at   timestamptz not null default now()
);
create index if not exists guest_events_date_idx on public.guest_events (service_date);

create table if not exists public.guest_vouchers (
  ticket_id uuid primary key references public.tickets (id) on delete cascade,
  event_id  uuid not null references public.guest_events (id) on delete cascade,
  seq       int  not null,
  unique (event_id, seq)
);

alter table public.guest_events enable row level security;
alter table public.guest_vouchers enable row level security;
drop policy if exists guest_events_read on public.guest_events;
create policy guest_events_read on public.guest_events for select to authenticated using (public.has_role('caissier', 'chef', 'agent'));
grant select on public.guest_events to authenticated;
grant select, insert, update on public.guest_events, public.guest_vouchers to service_role;
-- guest_vouchers : aucune lecture directe (les codes secrets passent par guest_event_vouchers)

-- Montant pris sur le budget pour un mois : repas servis + bons encore valables (les bons expirés ou annulés sont rendus)
create or replace function public._guest_engaged(p_month date) returns int
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(sum(e.unit_price), 0)::int
    from public.guest_vouchers v join public.guest_events e on e.id = v.event_id join public.tickets t on t.id = v.ticket_id
   where date_trunc('month', e.service_date) = date_trunc('month', p_month) and t.status in ('used', 'valid')
$$;

-- ───────── Création d'un événement (caisse ou admin) ─────────
create or replace function public.guest_event_create(p_name text, p_date date, p_service public.service_kind, p_guests int,
  p_dishes jsonb default '[]', p_note text default null) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_price int; v_budget int; v_engaged int; v_win record; v_event uuid; v_dishes jsonb; v_ticket uuid; i int;
begin
  if not public.has_role('caissier') then return public._fail('FORBIDDEN', 'Réservé à la caisse et à l''administration.'); end if;
  if p_name is null or length(btrim(p_name)) not between 2 and 80 then return public._fail('INVALID_NAME', 'Donnez un nom à l''événement (2 à 80 caractères).'); end if;
  if p_guests is null or p_guests not between 1 and 300 then return public._fail('INVALID_GUESTS', 'Nombre d''invités : de 1 à 300.'); end if;
  if p_date is null or p_date < public.today_abidjan() or p_date > public.today_abidjan() + 60 then
    return public._fail('INVALID_DATE', 'Choisissez un jour entre aujourd''hui et dans 60 jours.');
  end if;
  if p_note is not null and length(p_note) > 300 then return public._fail('INVALID_NOTE', 'Note trop longue (300 caractères au plus).'); end if;
  select * into v_win from public.service_window(p_date, p_service);
  if v_win.ends_at is null then return public._fail('INVALID_SERVICE', 'Repas inconnu.'); end if;
  if v_win.ends_at <= now() then return public._fail('SERVICE_OVER', 'Ce repas est déjà terminé.'); end if;
  v_price := coalesce((public.setting('services') -> p_service::text ->> 'price')::int, 0);

  -- Plats prévus : uniquement des plats du menu de ce jour et de ce repas, quantités ≤ nombre d'invités
  select coalesce(jsonb_agg(jsonb_build_object('menu_item_id', mi.id, 'name', d.name, 'qty', x.qty) order by d.name), '[]')
    into v_dishes
    from (select (e ->> 'menu_item_id')::uuid id, sum((e ->> 'qty')::int) qty from jsonb_array_elements(coalesce(p_dishes, '[]')) e
           where (e ->> 'qty')::int > 0 group by 1) x
    join public.menu_items mi on mi.id = x.id and mi.service_date = p_date and mi.service = p_service
    join public.dishes d on d.id = mi.dish_id;
  if jsonb_array_length(v_dishes) <> (select count(distinct e ->> 'menu_item_id') from jsonb_array_elements(coalesce(p_dishes, '[]')) e where (e ->> 'qty')::int > 0) then
    return public._fail('INVALID_DISH', 'Un plat choisi n''est pas au menu de ce repas.');
  end if;
  if (select coalesce(sum((e ->> 'qty')::int), 0) from jsonb_array_elements(v_dishes) e) > p_guests then
    return public._fail('INVALID_DISH', 'Plus de plats prévus que d''invités.');
  end if;

  -- Budget du mois (verrou : deux créations en même temps ne dépassent pas le budget)
  perform pg_advisory_xact_lock(hashtext('guest_budget'));
  v_budget := coalesce((public.setting('guest_budget') ->> 'monthly')::int, 0);
  v_engaged := public._guest_engaged(p_date);
  if v_engaged + p_guests * v_price > v_budget then
    return public._fail('BUDGET', 'Budget Réceptions du mois dépassé : reste ' || public.fcfa(greatest(v_budget - v_engaged, 0))
      || ', il faut ' || public.fcfa(p_guests * v_price) || '.', jsonb_build_object('remaining', greatest(v_budget - v_engaged, 0)));
  end if;

  insert into public.guest_events (name, service_date, service, guests, unit_price, dishes, note, created_by)
  values (btrim(p_name), p_date, p_service, p_guests, v_price, v_dishes, nullif(btrim(p_note), ''), auth.uid()) returning id into v_event;
  for i in 1 .. p_guests loop
    insert into public.tickets (user_id, buyer_id, service, service_date, total, valid_from, valid_until, gift_from)
    values (public._guest_profile(), public._guest_profile(), p_service, p_date, 0,
            v_win.starts_at - interval '30 minutes', v_win.ends_at, 'Invité · ' || btrim(p_name))
    returning id into v_ticket;
    insert into public.guest_vouchers (ticket_id, event_id, seq) values (v_ticket, v_event, i);
  end loop;
  perform public._audit('guest_event_create', v_event::text, jsonb_build_object('name', p_name, 'guests', p_guests, 'date', p_date, 'service', p_service));
  perform public._notify_roles('{chef}', 'guest_event', 'Délégation : ' || btrim(p_name),
    p_guests || ' invité(s) · ' || lower(public.service_label(p_service)) || ' ' || public._day_label(p_date), jsonb_build_object('href', '/admin/production'));
  return jsonb_build_object('ok', true, 'event_id', v_event, 'cost', p_guests * v_price);
end $$;

-- Annulation : les bons pas encore utilisés sont annulés et reviennent au budget
create or replace function public.guest_event_cancel(p_event uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_n int;
begin
  if not public.has_role('caissier') then return public._fail('FORBIDDEN', 'Réservé à la caisse et à l''administration.'); end if;
  update public.guest_events set cancelled_at = now() where id = p_event and cancelled_at is null;
  if not found then return public._fail('NOT_FOUND', 'Événement introuvable ou déjà annulé.'); end if;
  update public.tickets t set status = 'cancelled', cancelled_at = now()
    from public.guest_vouchers v where v.ticket_id = t.id and v.event_id = p_event and t.status = 'valid';
  get diagnostics v_n = row_count;
  perform public._audit('guest_event_cancel', p_event::text, jsonb_build_object('cancelled', v_n));
  return jsonb_build_object('ok', true, 'cancelled', v_n);
end $$;

-- Codes à imprimer (un QR par invité)
create or replace function public.guest_event_vouchers(p_event uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare e public.guest_events;
begin
  if not public.has_role('caissier') then return public._fail('FORBIDDEN', 'Réservé à la caisse et à l''administration.'); end if;
  select * into e from public.guest_events where id = p_event;
  if not found then return public._fail('NOT_FOUND', 'Événement introuvable.'); end if;
  return jsonb_build_object('ok', true, 'event', jsonb_build_object('name', e.name, 'date', e.service_date, 'service', e.service,
      'service_label', public.service_label(e.service), 'day', public._day_label(e.service_date), 'dishes', e.dishes),
    'vouchers', (select coalesce(jsonb_agg(jsonb_build_object('seq', v.seq, 'status', t.status,
                    'code', 'VATEL-INVITE:' || t.id || '.' || t.qr_nonce) order by v.seq), '[]')
                   from public.guest_vouchers v join public.tickets t on t.id = v.ticket_id where v.event_id = p_event));
end $$;

-- Écran Caisse : budget du mois et événements
create or replace function public.guest_overview(p_month date default public.today_abidjan()) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_budget int := coalesce((public.setting('guest_budget') ->> 'monthly')::int, 0); v_engaged int := public._guest_engaged(p_month);
begin
  if not public.has_role('caissier') then return public._fail('FORBIDDEN', 'Réservé à la caisse et à l''administration.'); end if;
  return jsonb_build_object('ok', true, 'budget', v_budget, 'engaged', v_engaged, 'remaining', greatest(v_budget - v_engaged, 0),
    'spent', (select coalesce(sum(e.unit_price), 0) from public.guest_vouchers v join public.guest_events e on e.id = v.event_id
               join public.tickets t on t.id = v.ticket_id where t.status = 'used' and date_trunc('month', e.service_date) = date_trunc('month', p_month)),
    'prices', (select jsonb_object_agg(k, (public.setting('services') -> k ->> 'price')::int) from jsonb_object_keys(public.setting('services')) k),
    'events', (select coalesce(jsonb_agg(x order by x.service_date desc, x.created_at desc), '[]') from (
      select e.id, e.name, e.service_date, e.service, public.service_label(e.service) service_label, e.guests, e.unit_price, e.dishes, e.note,
             e.cancelled_at, e.created_at,
             count(*) filter (where t.status = 'used') used, count(*) filter (where t.status = 'valid') valid,
             count(*) filter (where t.status in ('expired', 'cancelled')) returned
        from public.guest_events e join public.guest_vouchers v on v.event_id = e.id join public.tickets t on t.id = v.ticket_id
       where e.service_date >= date_trunc('month', p_month)::date - 7
       group by e.id) x));
end $$;

-- Budget mensuel (admin)
create or replace function public.guest_budget_set(p_monthly int) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not public.has_role('admin') then return public._fail('FORBIDDEN', 'Réservé à l''administrateur.'); end if;
  if p_monthly is null or p_monthly not between 0 and 100000000 then return public._fail('INVALID', 'Montant invalide.'); end if;
  update public.settings set value = jsonb_build_object('monthly', p_monthly) where key = 'guest_budget';
  perform public._audit('guest_budget_set', 'guest_budget', jsonb_build_object('monthly', p_monthly));
  return jsonb_build_object('ok', true, 'monthly', p_monthly);
end $$;

-- ───────── Comptoir : scan d'un bon invité ─────────
create or replace function public.guest_redeem(p_code text, p_service_date date, p_service public.service_kind) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare m text[]; v_ticket uuid; v_event uuid; e public.guest_events; v_seq int; r jsonb; v_left int;
begin
  if not public.has_role('agent') then return public._fail('FORBIDDEN', 'Compte agent requis.'); end if;
  m := regexp_match(btrim(coalesce(p_code, '')), '^VATEL-INVITE:([0-9a-f-]{36})\.([0-9a-f]{32})$', 'i');
  if m is null then return public._fail('INVALID_QR', 'QR invalide.'); end if;
  v_ticket := m[1]::uuid;
  select v.event_id, v.seq into v_event, v_seq from public.guest_vouchers v where v.ticket_id = v_ticket;
  if v_event is null then return public._fail('INVALID_QR', 'QR invalide.'); end if;
  select * into e from public.guest_events where id = v_event;
  if e.service_date <> p_service_date then
    return public._fail('WRONG_DAY', 'Bon invité « ' || e.name || ' » valable ' || public._day_label(e.service_date) || '.');
  end if;
  r := public.redeem_ticket(v_ticket, lower(m[2]), auth.uid(), p_service_date, p_service);
  if not coalesce((r ->> 'ok')::boolean, false) then return r; end if;
  select count(*) into v_left from public.guest_vouchers v join public.tickets t on t.id = v.ticket_id
   where v.event_id = e.id and t.status = 'valid';
  return r || jsonb_build_object('client', 'Invité · ' || e.name, 'gift_from', null, 'batch_size', null, 'remaining', null,
    'guest', jsonb_build_object('event', e.name, 'seq', v_seq, 'guests', e.guests, 'left', v_left, 'dishes', e.dishes));
end $$;

-- ───────── Cuisine : les invités s'ajoutent aux clients attendus ─────────
create or replace function public.admin_forecast(p_date date) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare r jsonb;
begin
  if not public.has_role('chef') then raise exception 'forbidden' using errcode = '42501'; end if;
  with svc as (
    select s.svc, s.o, w.starts_at, w.ends_at,
      (select avg(c)::numeric from (
          select (select count(*) from tickets t where t.service_date = h and t.service = s.svc and t.status = 'used'
                     and t.user_id <> public._guest_profile()) c
            from unnest(array[p_date - 7, p_date - 14, p_date - 21, p_date - 28]) h
           where public._service_on_menu(h, s.svc)) z) hist,
      (select count(*) from tickets t where t.service = s.svc and t.status = 'valid' and t.user_id <> public._guest_profile()
          and t.valid_until > w.starts_at and t.valid_from < w.ends_at) outstanding,
      (select count(*) from tickets t where t.service = s.svc and t.user_id = public._guest_profile()
          and t.service_date = p_date and t.status in ('valid', 'used')) guests
      from unnest(enum_range(null::public.service_kind)) with ordinality s(svc, o)
      cross join lateral public.service_window(p_date, s.svc) w
     where exists (select 1 from menu_items mi join menus m on m.id = mi.menu_id
                    where mi.service_date = p_date and mi.service = s.svc)
  ), svc2 as (
    select *, (greatest(round(coalesce(hist, 0)), outstanding) + guests)::int expected_total,
           case when hist is not null then 'history' else 'tickets' end basis from svc
  ), items as (
    select mi.id, mi.service, mi.dish_id, d.name, mi.planned_qty, mi.prepared_qty, mi.served_qty,
           p.popularity, p.observed, p.days, p.stars, p.prior
      from menu_items mi join menus m on m.id = mi.menu_id join dishes d on d.id = mi.dish_id
      join public._dish_popularity(p_date) p on p.dish_id = mi.dish_id
     where mi.service_date = p_date
  ), shares as (
    select i.*, s.expected_total, s.basis,
           i.popularity / sum(i.popularity) over (partition by i.service) share
      from items i join svc2 s on s.svc = i.service
  ), rec as (
    select *, round(expected_total * share)::int expected, ceil(expected_total * share * 1.05)::int recommended from shares
  ), needs as (
    select ing.id, ing.name, ing.unit, ing.stock_qty, ing.alert_threshold, ing.unit_cost,
           round(sum(rl.qty_per_portion * rec.recommended), 2) need
      from rec join recipe_lines rl on rl.dish_id = rec.dish_id join ingredients ing on ing.id = rl.ingredient_id
     group by ing.id
  )
  select jsonb_build_object(
    'date', p_date,
    'services', (select coalesce(jsonb_agg(jsonb_build_object('service', svc, 'label', public.service_label(svc),
                   'history', round(hist), 'outstanding', outstanding, 'guests', guests, 'expected', expected_total, 'basis', basis,
                   'guest_events', (select coalesce(jsonb_agg(jsonb_build_object('name', e.name, 'guests', e.guests, 'dishes', e.dishes) order by e.created_at), '[]')
                                      from public.guest_events e where e.service_date = p_date and e.service = svc2.svc and e.cancelled_at is null))
                   order by o), '[]') from svc2),
    'items', (select coalesce(jsonb_agg(jsonb_build_object(
                'id', id, 'service', service, 'dish', name, 'planned', planned_qty, 'prepared', prepared_qty,
                'served', served_qty, 'share', round(share * 100), 'expected', expected, 'recommended', recommended,
                'popularity', round(popularity, 2), 'observed', round(observed, 2), 'days', days, 'stars', stars, 'prior', prior,
                'basis', case when days >= 5 then 'dish' else 'prior' end)
                order by service, recommended desc), '[]') from rec),
    'ingredients', (select coalesce(jsonb_agg(jsonb_build_object(
                'id', id, 'name', name, 'unit', unit, 'stock', stock_qty, 'need', need,
                'to_buy', greatest(round(need - stock_qty + alert_threshold, 2), 0),
                'cost', ceil(greatest(need - stock_qty + alert_threshold, 0) * unit_cost)) order by name), '[]') from needs)
  ) into r;
  return r;
end $$;

-- ───────── Rapports : ligne « Réceptions » ─────────
create or replace function public.guest_report(p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not public.has_role('caissier', 'chef') then return public._fail('FORBIDDEN', 'Réservé à l''administration.'); end if;
  return (select jsonb_build_object('ok', true, 'events', count(distinct e.id),
            'served', count(*) filter (where t.status = 'used'),
            'returned', count(*) filter (where t.status in ('expired', 'cancelled')),
            'cost', coalesce(sum(e.unit_price) filter (where t.status = 'used'), 0))
            from public.guest_events e join public.guest_vouchers v on v.event_id = e.id join public.tickets t on t.id = v.ticket_id
           where e.service_date between p_from and p_to);
end $$;

-- Pas de rappel « ton ticket expire » ni de points pour le compte système
create or replace function public._guest_no_reminder() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.user_id = public._guest_profile() then return null; end if;
  return new;
end $$;
drop trigger if exists notifications_guest_skip on public.notifications;
create trigger notifications_guest_skip before insert on public.notifications
  for each row when (new.user_id = '00000000-0000-4000-8000-00000000ec01') execute function public._guest_no_reminder();

revoke all on function public._guest_engaged(date), public._guest_no_reminder() from public, anon, authenticated;
revoke all on function public.guest_event_create(text, date, public.service_kind, int, jsonb, text), public.guest_event_cancel(uuid),
  public.guest_event_vouchers(uuid), public.guest_overview(date), public.guest_budget_set(int),
  public.guest_redeem(text, date, public.service_kind), public.guest_report(date, date) from public, anon;
grant execute on function public.guest_event_create(text, date, public.service_kind, int, jsonb, text), public.guest_event_cancel(uuid),
  public.guest_event_vouchers(uuid), public.guest_overview(date), public.guest_budget_set(int),
  public.guest_redeem(text, date, public.service_kind), public.guest_report(date, date) to authenticated;
