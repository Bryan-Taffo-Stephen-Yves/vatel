-- Tournée d'achats suivie en direct (§20.6 a) : un coursier « type Yango » (simulé) passe chez plusieurs fournisseurs,
-- achète les articles un par un, puis livre la cantine. Chaque étape devient un événement : affiché sur la page de
-- suivi publique (/suivi/[jeton]) et envoyé dans le groupe WhatsApp de l'équipe. L'équipe peut modifier la liste en
-- direct (seulement ce qui n'est pas encore acheté). Mouvement simulé : une avancée toutes les 10 s (pg_cron).

-- Point de livraison (la cantine) et réglages de la simulation
insert into public.settings (key, value) values ('delivery', jsonb_build_object(
  'canteen', jsonb_build_object('name', 'Cantine Dabali', 'address', 'Cocody, Abidjan', 'lat', 5.3600, 'lng', -3.9900),
  'courier_start', jsonb_build_object('lat', 5.3240, 'lng', -4.0190, 'address', 'Plateau'),
  'speed', 30,            -- 10 s réelles = 300 s de trajet simulé
  'stop_minutes', 5,      -- temps passé à chaque arrêt (pour l'heure d'arrivée)
  'courier', jsonb_build_object('name', 'Moussa K.', 'phone', '+2250700000000', 'vehicle', 'Moto · AB 1234 CI')))
on conflict (key) do nothing;

create table if not exists public.suppliers (
  id        uuid primary key default gen_random_uuid(),
  name      text not null unique,
  kind      text not null default 'autre',
  district  text,
  address   text,
  phone     text,
  lat       numeric(9,6) not null,
  lng       numeric(9,6) not null,
  is_active boolean not null default true
);
insert into public.suppliers (name, kind, district, address, phone, lat, lng) values
  ('Boucherie Bamba', 'boucherie', 'Treichville', 'Marché de Treichville', '+2250700000101', 5.2990, -4.0040),
  ('Grossiste Koné', 'grossiste', 'Adjamé', 'Marché Gouro, Adjamé', '+2250700000102', 5.3560, -4.0230),
  ('Marché de Cocody', 'marche', 'Cocody', 'Grand marché de Cocody', '+2250700000103', 5.3470, -3.9930),
  ('Poissonnerie Port-Bouët', 'poissonnerie', 'Port-Bouët', 'Débarcadère de Port-Bouët', '+2250700000104', 5.2560, -3.9260)
on conflict (name) do nothing;

create table if not exists public.delivery_runs (
  id            uuid primary key default gen_random_uuid(),
  title         text not null default 'Courses du jour',
  status        text not null default 'prete' check (status in ('prete', 'en_route', 'achats', 'vers_cantine', 'livre', 'receptionne', 'annule')),
  mode          text not null default 'simulation' check (mode in ('simulation', 'reel')),
  track_token   text not null unique default encode(extensions.gen_random_bytes(12), 'hex'),
  courier_name  text, courier_phone text, vehicle text,
  route         jsonb,                 -- { coords: [[lat,lng]…], cum: [secondes…], source: 'osrm'|'ligne' }
  route_idx     int not null default 0,
  target_stop   uuid,
  eta_at        timestamptz,
  created_by    uuid references public.profiles (id),
  created_at    timestamptz not null default now(),
  started_at    timestamptz, delivered_at timestamptz, received_at timestamptz,
  updated_at    timestamptz not null default now()
);
create table if not exists public.delivery_stops (
  id          uuid primary key default gen_random_uuid(),
  run_id      uuid not null references public.delivery_runs (id) on delete cascade,
  seq         int not null,
  supplier_id uuid references public.suppliers (id),
  name        text not null, district text, phone text,
  lat         numeric(9,6) not null, lng numeric(9,6) not null,
  route_idx   int,                     -- position de l'arrêt dans l'itinéraire
  status      text not null default 'a_faire' check (status in ('a_faire', 'en_cours', 'fait', 'annule')),
  arrived_at  timestamptz, done_at timestamptz
);
create table if not exists public.delivery_items (
  id             uuid primary key default gen_random_uuid(),
  run_id         uuid not null references public.delivery_runs (id) on delete cascade,
  stop_id        uuid not null references public.delivery_stops (id) on delete cascade,
  ingredient_id  uuid references public.ingredients (id),
  label          text not null,        -- « poulets », « sacs de riz 25 kg »
  qty            numeric(10,2) not null check (qty > 0),
  stock_qty      numeric(10,2),        -- quantité ajoutée au stock à la réception (unité de l'ingrédient)
  emoji          text not null default '🛒',
  done_text      text,                 -- message quand c'est acheté (sinon généré)
  price_expected int not null default 0,
  price_paid     int,
  status         text not null default 'a_acheter' check (status in ('a_acheter', 'achete', 'annule')),
  bought_at      timestamptz,
  created_at     timestamptz not null default now()
);
create table if not exists public.delivery_events (
  id      bigint generated always as identity primary key,
  run_id  uuid not null references public.delivery_runs (id) on delete cascade,
  at      timestamptz not null default now(),
  kind    text not null,               -- depart, arrivee, achat, arret_fini, vers_cantine, livre, equipe, jean, changement, reception
  message text not null,
  author  text
);
create index if not exists delivery_events_run on public.delivery_events (run_id, id);
create index if not exists delivery_stops_run on public.delivery_stops (run_id, seq);
create index if not exists delivery_items_run on public.delivery_items (run_id, stop_id);

alter table public.suppliers enable row level security;
alter table public.delivery_runs enable row level security;
alter table public.delivery_stops enable row level security;
alter table public.delivery_items enable row level security;
alter table public.delivery_events enable row level security;
create policy "fournisseurs : cuisine" on public.suppliers for select to authenticated using (public.has_role('chef', 'agent', 'caissier'));
create policy "tournées : cuisine" on public.delivery_runs for select to authenticated using (public.has_role('chef'));
grant select on public.suppliers, public.delivery_runs to authenticated;
grant all on public.suppliers, public.delivery_runs, public.delivery_stops, public.delivery_items, public.delivery_events to service_role;

-- ───────── Utilitaires ─────────
create or replace function public._fmt_qty(p numeric) returns text language sql immutable as $$
  select replace(trim(trailing '.' from trim(trailing '0' from to_char(p, 'FM999990.99'))), '.', ',')
$$;
create or replace function public._hm(p timestamptz) returns text language sql stable as $$
  select to_char(p at time zone 'Africa/Abidjan', 'HH24"h"MI')
$$;

/** Secondes de trajet restantes (route) + arrêts restants × temps d'arrêt → heure d'arrivée à la cantine */
create or replace function public._delivery_eta(p_run uuid) returns timestamptz
language sql stable security definer set search_path = public, pg_temp as $$
  select now()
    + make_interval(secs => greatest(coalesce(((r.route -> 'cum' ->> (jsonb_array_length(r.route -> 'cum') - 1))::numeric
                                        - (r.route -> 'cum' ->> r.route_idx)::numeric), 0), 0))
    + make_interval(mins => (select count(*)::int from delivery_stops s where s.run_id = r.id and s.status in ('a_faire', 'en_cours'))
                            * coalesce((public.setting('delivery') ->> 'stop_minutes')::int, 5))
    from delivery_runs r where r.id = p_run and r.route is not null
$$;

create or replace function public._delivery_event(p_run uuid, p_kind text, p_msg text, p_author text default null) returns void
language sql security definer set search_path = public, pg_temp as $$
  insert into delivery_events (run_id, kind, message, author) values (p_run, p_kind, p_msg, p_author);
  update delivery_runs set updated_at = now() where id = p_run;
$$;

create or replace function public._delivery_item_text(i public.delivery_items) returns text
language sql immutable as $$
  select coalesce(i.done_text, i.emoji || ' ' || public._fmt_qty(i.qty) || ' ' || i.label || ' acheté' ||
                  case when i.qty > 1 then 's' else '' end)
         || coalesce(' (' || replace(to_char(coalesce(i.price_paid, i.price_expected), 'FM999G999G999'), ',', ' ') || ' F)', '')
$$;

-- ───────── Création d'une tournée de démo (chef) ─────────
create or replace function public.delivery_create_demo() returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_cfg jsonb := public.setting('delivery'); v_run uuid; v_s1 uuid; v_s2 uuid; v_s3 uuid;
  ing jsonb := (select jsonb_object_agg(name, id) from ingredients);
begin
  if not public.has_role('chef') then return public._fail('FORBIDDEN', 'Réservé à la cuisine.'); end if;
  insert into delivery_runs (title, courier_name, courier_phone, vehicle, created_by)
  values ('Courses du ' || to_char(public.today_abidjan(), 'DD/MM'), v_cfg -> 'courier' ->> 'name', v_cfg -> 'courier' ->> 'phone',
          v_cfg -> 'courier' ->> 'vehicle', auth.uid())
  returning id into v_run;
  insert into delivery_stops (run_id, seq, supplier_id, name, district, phone, lat, lng)
    select v_run, 1, id, name, district, phone, lat, lng from suppliers where name = 'Boucherie Bamba' returning id into v_s1;
  insert into delivery_stops (run_id, seq, supplier_id, name, district, phone, lat, lng)
    select v_run, 2, id, name, district, phone, lat, lng from suppliers where name = 'Grossiste Koné' returning id into v_s2;
  insert into delivery_stops (run_id, seq, supplier_id, name, district, phone, lat, lng)
    select v_run, 3, id, name, district, phone, lat, lng from suppliers where name = 'Marché de Cocody' returning id into v_s3;
  insert into delivery_items (run_id, stop_id, ingredient_id, label, qty, stock_qty, emoji, done_text, price_expected) values
    (v_run, v_s1, (ing ->> 'Poulet')::uuid, 'poulets', 20, 30, '🍗', '🍗 Les 20 poulets ont été récupérés par le coursier', 56000),
    (v_run, v_s2, (ing ->> 'Riz')::uuid, 'sacs de riz (25 kg)', 2, 50, '🍚', null, 37000),
    (v_run, v_s2, (ing ->> 'Huile')::uuid, 'bidon d''huile (20 L)', 1, 20, '🛢️', null, 21500),
    (v_run, v_s3, (ing ->> 'Tomate')::uuid, 'sacs de tomates', 2, 50, '🍅', null, 18000),
    (v_run, v_s3, (ing ->> 'Banane plantain')::uuid, 'kg de banane plantain', 15, 15, '🍌', '🍌 Les 15 kg de banane plantain ont été achetés', 7500),
    (v_run, v_s3, (ing ->> 'Oignon')::uuid, 'kg d''oignons', 5, 5, '🧅', null, 4000);
  perform public._delivery_event(v_run, 'creation', '📝 Tournée créée : ' || (select string_agg(name, ' → ' order by seq) from delivery_stops where run_id = v_run) || ' → cantine.', null);
  return jsonb_build_object('ok', true, 'run_id', v_run, 'track_token', (select track_token from delivery_runs where id = v_run));
end $$;
revoke all on function public.delivery_create_demo() from public, anon;
grant execute on function public.delivery_create_demo() to authenticated;

-- Itinéraire calculé par l'Edge Function (OSRM) → enregistré ici, point de départ = position actuelle
create or replace function public._delivery_set_route(p_run uuid, p_route jsonb, p_stop_idx jsonb) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare k text;
begin
  update delivery_runs set route = p_route, route_idx = 0, updated_at = now() where id = p_run;
  for k in select jsonb_object_keys(p_stop_idx) loop
    update delivery_stops set route_idx = (p_stop_idx ->> k)::int where id = k::uuid and run_id = p_run;
  end loop;
  update delivery_runs set eta_at = public._delivery_eta(p_run) where id = p_run;
end $$;
revoke all on function public._delivery_set_route(uuid, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public._delivery_set_route(uuid, jsonb, jsonb) to service_role;

-- Départ (appelé par l'Edge Function après le calcul de l'itinéraire)
create or replace function public._delivery_start(p_run uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_first public.delivery_stops; v_eta timestamptz;
begin
  select * into v_first from delivery_stops where run_id = p_run and status = 'a_faire' order by seq limit 1;
  update delivery_runs set status = 'en_route', started_at = now(), target_stop = v_first.id where id = p_run;
  v_eta := public._delivery_eta(p_run);
  update delivery_runs set eta_at = v_eta where id = p_run;
  perform public._delivery_event(p_run, 'depart', '🛵 Le coursier ' || coalesce((select courier_name from delivery_runs where id = p_run), '')
    || ' est parti vers ' || v_first.name || coalesce(' (' || v_first.district || ')', '') || ' · retour à la cantine prévu vers ' || public._hm(v_eta) || '.');
end $$;
revoke all on function public._delivery_start(uuid) from public, anon, authenticated;
grant execute on function public._delivery_start(uuid) to service_role;

-- ───────── Simulation : une avancée toutes les 10 s ─────────
create or replace function public.delivery_tick() returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare r public.delivery_runs; s public.delivery_stops; i public.delivery_items; v_n int := 0;
  v_speed int := coalesce((public.setting('delivery') ->> 'speed')::int, 30);
  v_cum jsonb; v_last int; v_target int; v_new int; v_next public.delivery_stops; v_eta timestamptz; v_list text;
begin
  for r in select * from delivery_runs where mode = 'simulation' and status in ('en_route', 'achats', 'vers_cantine') and route is not null for update skip locked loop
    v_n := v_n + 1;
    v_cum := r.route -> 'cum'; v_last := jsonb_array_length(v_cum) - 1;

    if r.status = 'achats' then
      select * into s from delivery_stops where id = r.target_stop;
      select * into i from delivery_items where stop_id = s.id and status = 'a_acheter' order by created_at limit 1;
      if found then
        update delivery_items set status = 'achete', price_paid = price_expected, bought_at = now() where id = i.id returning * into i;
        perform public._delivery_event(r.id, 'achat', public._delivery_item_text(i));
        continue;
      end if;
      update delivery_stops set status = 'fait', done_at = now() where id = s.id;
      select * into v_next from delivery_stops where run_id = r.id and status = 'a_faire' order by seq limit 1;
      if found then
        update delivery_runs set status = 'en_route', target_stop = v_next.id where id = r.id;
        perform public._delivery_event(r.id, 'arret_fini', '✔️ Fini chez ' || s.name || ' · direction ' || v_next.name || coalesce(' (' || v_next.district || ')', '') || '.');
      else
        update delivery_runs set status = 'vers_cantine', target_stop = null where id = r.id;
        v_eta := public._delivery_eta(r.id);
        update delivery_runs set eta_at = v_eta where id = r.id;
        perform public._delivery_event(r.id, 'vers_cantine', '✅ Le coursier a fini les achats et est désormais en route vers vous · arrivée vers '
          || public._hm(v_eta) || ' (dans ' || greatest(1, ceil(extract(epoch from v_eta - now()) / 60))::int || ' min).');
      end if;
      continue;
    end if;

    -- En mouvement vers l'arrêt visé (ou la cantine)
    if r.status = 'en_route' then select route_idx into v_target from delivery_stops where id = r.target_stop;
    else v_target := v_last; end if;
    v_target := coalesce(v_target, v_last);
    select coalesce(max(k), r.route_idx) into v_new
      from generate_series(r.route_idx, v_target) k
     where (v_cum ->> k)::numeric <= (v_cum ->> r.route_idx)::numeric + v_speed * 10;
    if v_new = r.route_idx and v_new < v_target then v_new := v_new + 1; end if;
    update delivery_runs set route_idx = v_new where id = r.id;

    if v_new >= v_target then
      if r.status = 'en_route' then
        update delivery_stops set status = 'en_cours', arrived_at = now() where id = r.target_stop returning * into s;
        update delivery_runs set status = 'achats' where id = r.id;
        perform public._delivery_event(r.id, 'arrivee', '📍 Le coursier est arrivé chez ' || s.name || coalesce(' (' || s.district || ')', '') || '.');
      else
        select string_agg(public._fmt_qty(qty) || ' ' || label, ', ' order by created_at) into v_list from delivery_items where run_id = r.id and status = 'achete';
        update delivery_runs set status = 'livre', delivered_at = now(), eta_at = now() where id = r.id;
        perform public._delivery_event(r.id, 'livre', '📦 Livré à la cantine : ' || coalesce(v_list, 'rien') || '. À réceptionner dans l''appli.');
        perform public._notify_roles('{chef}', 'delivery_done', 'Courses livrées 📦', coalesce(v_list, '') || ' · à réceptionner',
          jsonb_build_object('href', '/admin/livraisons'));
      end if;
    end if;
    update delivery_runs set eta_at = public._delivery_eta(r.id) where id = r.id and status <> 'livre';
  end loop;
  return v_n;
end $$;
revoke all on function public.delivery_tick() from public, anon, authenticated;
grant execute on function public.delivery_tick() to service_role;

-- ───────── Changements demandés par l'équipe (via Jean ou la page) ─────────
-- Annule des articles pas encore achetés ; un arrêt sans article restant est annulé. Renvoie s'il faut recalculer l'itinéraire.
create or replace function public._delivery_cancel_items(p_run uuid, p_items uuid[], p_author text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_done text; v_cancel text; v_stops text; v_reroute boolean := false;
begin
  select string_agg(label, ', ') into v_done from delivery_items where run_id = p_run and id = any (p_items) and status = 'achete';
  with c as (update delivery_items set status = 'annule' where run_id = p_run and id = any (p_items) and status = 'a_acheter' returning label)
  select string_agg(label, ', ') into v_cancel from c;
  with st as (
    update delivery_stops s set status = 'annule' where s.run_id = p_run and s.status = 'a_faire'
       and not exists (select 1 from delivery_items i where i.stop_id = s.id and i.status <> 'annule') returning s.name)
  select string_agg(name, ', ') into v_stops from st;
  if v_stops is not null then
    v_reroute := true;
    update delivery_runs r set target_stop = (select id from delivery_stops where run_id = p_run and status = 'a_faire' order by seq limit 1)
     where r.id = p_run and r.status = 'en_route' and (select status from delivery_stops where id = r.target_stop) = 'annule';
    update delivery_runs set status = 'vers_cantine' where id = p_run and status = 'en_route' and target_stop is null;
  end if;
  if v_cancel is not null then
    perform public._delivery_event(p_run, 'changement', '❌ Annulé à la demande de ' || coalesce(p_author, 'l''équipe') || ' : ' || v_cancel
      || coalesce('. Le coursier ne passe plus chez ' || v_stops, '') || '.', p_author);
  end if;
  return jsonb_build_object('ok', true, 'cancelled', v_cancel, 'already_bought', v_done, 'stops_cancelled', v_stops, 'reroute', v_reroute);
end $$;
revoke all on function public._delivery_cancel_items(uuid, uuid[], text) from public, anon, authenticated;
grant execute on function public._delivery_cancel_items(uuid, uuid[], text) to service_role;

-- Ajoute un article à un arrêt pas encore terminé
create or replace function public._delivery_add_item(p_run uuid, p_stop uuid, p_label text, p_qty numeric, p_author text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare s public.delivery_stops;
begin
  select * into s from delivery_stops where id = p_stop and run_id = p_run;
  if not found or s.status in ('fait', 'annule') then return public._fail('STOP_DONE', 'Cet arrêt est déjà terminé.'); end if;
  if p_qty is null or p_qty <= 0 or length(coalesce(p_label, '')) < 2 then return public._fail('INVALID', 'Article invalide.'); end if;
  insert into delivery_items (run_id, stop_id, label, qty, emoji) values (p_run, p_stop, left(p_label, 60), p_qty, '➕');
  perform public._delivery_event(p_run, 'changement', '➕ Ajouté à la demande de ' || coalesce(p_author, 'l''équipe') || ' : '
    || public._fmt_qty(p_qty) || ' ' || p_label || ' chez ' || s.name || '.', p_author);
  return jsonb_build_object('ok', true);
end $$;
revoke all on function public._delivery_add_item(uuid, uuid, text, numeric, text) from public, anon, authenticated;
grant execute on function public._delivery_add_item(uuid, uuid, text, numeric, text) to service_role;

-- ───────── Réception : le stock remonte ─────────
create or replace function public.delivery_receive(p_run uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare r public.delivery_runs; v_n int;
begin
  if not public.has_role('chef') then return public._fail('FORBIDDEN', 'Réservé à la cuisine.'); end if;
  select * into r from delivery_runs where id = p_run for update;
  if not found then return public._fail('NOT_FOUND', 'Tournée introuvable.'); end if;
  if r.status <> 'livre' then return public._fail('NOT_DELIVERED', 'La tournée n''est pas encore livrée.'); end if;
  insert into stock_movements (ingredient_id, type, qty, reason, created_by)
  select ingredient_id, 'in', stock_qty, 'Livraison coursier : ' || label, auth.uid()
    from delivery_items where run_id = p_run and status = 'achete' and ingredient_id is not null and stock_qty > 0;
  get diagnostics v_n = row_count;
  update delivery_runs set status = 'receptionne', received_at = now() where id = p_run;
  perform public._delivery_event(p_run, 'reception', '🧾 Réceptionné par ' || (select full_name from profiles where id = auth.uid())
    || ' : ' || v_n || ' article(s) ajoutés au stock.');
  return jsonb_build_object('ok', true, 'stock_lines', v_n);
end $$;
revoke all on function public.delivery_receive(uuid) from public, anon;
grant execute on function public.delivery_receive(uuid) to authenticated;

-- ───────── Page de suivi publique (lien partagé dans le groupe) ─────────
create or replace function public.delivery_track(p_token text) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare r public.delivery_runs; v_cfg jsonb := public.setting('delivery');
begin
  select * into r from delivery_runs where track_token = p_token;
  if not found or length(p_token) < 20 then return public._fail('NOT_FOUND', 'Suivi introuvable.'); end if;
  return jsonb_build_object('ok', true,
    'run', jsonb_build_object('id', r.id, 'title', r.title, 'status', r.status, 'mode', r.mode, 'courier_name', r.courier_name,
      'courier_phone', r.courier_phone, 'vehicle', r.vehicle, 'eta_at', r.eta_at, 'started_at', r.started_at,
      'delivered_at', r.delivered_at, 'target_stop', r.target_stop, 'updated_at', r.updated_at,
      'position', case when r.route is not null then r.route -> 'coords' -> r.route_idx end),
    'canteen', v_cfg -> 'canteen',
    'route', case when r.route is not null then jsonb_build_object('coords', r.route -> 'coords', 'idx', r.route_idx) end,
    'stops', (select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'seq', s.seq, 'name', s.name, 'district', s.district, 'phone', s.phone,
               'lat', s.lat, 'lng', s.lng, 'status', s.status, 'arrived_at', s.arrived_at, 'done_at', s.done_at,
               'items', (select coalesce(jsonb_agg(jsonb_build_object('id', i.id, 'label', i.label, 'qty', i.qty, 'emoji', i.emoji,
                          'status', i.status, 'price', coalesce(i.price_paid, i.price_expected)) order by i.created_at), '[]')
                          from delivery_items i where i.stop_id = s.id)) order by s.seq), '[]') from delivery_stops s where s.run_id = r.id),
    'events', (select coalesce(jsonb_agg(jsonb_build_object('id', e.id, 'at', e.at, 'kind', e.kind, 'message', e.message, 'author', e.author) order by e.id desc), '[]')
                 from (select * from delivery_events where run_id = r.id order by id desc limit 60) e));
end $$;
revoke all on function public.delivery_track(text) from public;
grant execute on function public.delivery_track(text) to anon, authenticated;

-- ───────── Envoi au groupe WhatsApp (si configuré) ─────────
create or replace function public._delivery_dispatch() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_url text := public.setting('jean') ->> 'function_url';
begin
  if v_url is null or public.setting('jean') ->> 'group_id' is null or to_regproc('net.http_post') is null then return null; end if;
  if new.kind in ('equipe') then return null; end if;   -- message déjà dans le groupe
  perform net.http_post(url := v_url,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-jean-secret', public._jean_secret()),
    body := jsonb_build_object('delivery_event_id', new.id));
  return null;
exception when others then return null;
end $$;
create or replace trigger delivery_events_dispatch after insert on public.delivery_events
  for each row execute function public._delivery_dispatch();

-- Tic de simulation toutes les 10 secondes
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('dabali-delivery-tick', '10 seconds', 'select public.delivery_tick()');
  end if;
end $$;
