-- Caméra d'affluence réglée DEPUIS L'ORDINATEUR : le téléphone est fixé en hauteur, on trace les tables à la souris.
--  · Les zones (tables, file) sont gardées en base : le téléphone les reprend tout seul (plus besoin d'y toucher).
--  · Pour tracer, l'ordinateur demande UNE photo de réglage au téléphone. C'est la seule image qui quitte le téléphone :
--    prise à la demande, visible seulement par la cuisine et l'administration, effacée au bout de 24 h ou d'un clic.
--    Conseil : la prendre salle vide. L'analyse en continu reste sur le téléphone et n'envoie que des nombres.

create table if not exists public.vision_setup (
  id                     int primary key default 1 check (id = 1),     -- une seule caméra (un seul réfectoire)
  zones                  jsonb not null default '[]',                   -- [{id, kind: table|queue, seats, x, y, w, h}] en 0..1
  zones_updated_at       timestamptz,
  zones_by               uuid references public.profiles (id),
  snapshot               text,                                          -- data:image/jpeg;base64,… (photo de réglage)
  snapshot_at            timestamptz,
  snapshot_requested_at  timestamptz,
  snapshot_requested_by  uuid references public.profiles (id)
);
insert into public.vision_setup (id) values (1) on conflict (id) do nothing;
alter table public.vision_setup enable row level security;   -- aucune lecture directe : tout passe par les fonctions
revoke all on public.vision_setup from anon, authenticated;
grant all on public.vision_setup to service_role;

-- Zones valides : 60 au plus, coordonnées dans l'image, places 0 à 20
create or replace function public._vision_zones_ok(p jsonb) returns boolean
language sql immutable set search_path = public, pg_temp as $$
  select jsonb_typeof(p) = 'array' and jsonb_array_length(p) <= 60 and not exists (
    select 1 from jsonb_array_elements(p) z
     where jsonb_typeof(z) <> 'object' or coalesce(z ->> 'kind', '') not in ('table', 'queue')
        or length(coalesce(z ->> 'id', '')) not between 1 and 64
        or (z ->> 'x')::numeric not between 0 and 1 or (z ->> 'y')::numeric not between 0 and 1
        or (z ->> 'w')::numeric not between 0.01 and 1 or (z ->> 'h')::numeric not between 0.01 and 1
        or coalesce((z ->> 'seats')::int, 0) not between 0 and 20)
$$;

-- Ménage : photo de plus de 24 h supprimée pour de bon (à chaque lecture des réglages)
create or replace function public._vision_snapshot_purge() returns void
language sql security definer set search_path = public, pg_temp as $$
  update public.vision_setup set snapshot = null, snapshot_at = null where id = 1 and snapshot_at < now() - interval '24 hours';
$$;

-- Lecture : le téléphone (agent) reçoit les zones et la demande de photo ; la photo n'est donnée qu'à la cuisine / l'admin
create or replace function public.vision_setup_get() returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v public.vision_setup; v_editor boolean := public.has_role('chef');
begin
  if not public.has_role('agent', 'chef') then return public._fail('FORBIDDEN', 'Réservé à l''équipe.'); end if;
  perform public._vision_snapshot_purge();
  select * into v from public.vision_setup where id = 1;
  return jsonb_build_object('ok', true, 'zones', coalesce(v.zones, '[]'), 'zones_updated_at', v.zones_updated_at,
    'snapshot_requested_at', v.snapshot_requested_at,
    'snapshot_at', case when v.snapshot_at > now() - interval '24 hours' then v.snapshot_at end,
    'snapshot', case when v_editor and v.snapshot_at > now() - interval '24 hours' then v.snapshot end);
end $$;

-- Enregistrer les zones (ordinateur, ou téléphone si on trace au doigt)
create or replace function public.vision_zones_save(p_zones jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not public.has_role('agent', 'chef') then return public._fail('FORBIDDEN', 'Réservé à l''équipe.'); end if;
  if not public._vision_zones_ok(p_zones) then return public._fail('INVALID', 'Zones invalides.'); end if;
  update public.vision_setup set zones = p_zones, zones_updated_at = now(), zones_by = auth.uid() where id = 1;
  perform public._audit('vision_zones', 'camera', jsonb_build_object('zones', jsonb_array_length(p_zones)));
  return jsonb_build_object('ok', true, 'zones_updated_at', now());
end $$;

-- L'ordinateur demande une photo de réglage ; le téléphone la prend au prochain passage (toutes les 10 s)
create or replace function public.vision_snapshot_request() returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not public.has_role('chef') then return public._fail('FORBIDDEN', 'Réservé à la cuisine et à l''administration.'); end if;
  update public.vision_setup set snapshot_requested_at = now(), snapshot_requested_by = auth.uid() where id = 1;
  return jsonb_build_object('ok', true);
end $$;

-- Le téléphone envoie la photo de réglage (JPEG réduit, 600 Ko au plus)
create or replace function public.vision_snapshot_put(p_image text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not public.has_role('agent', 'chef') then return public._fail('FORBIDDEN', 'Réservé à l''équipe.'); end if;
  if p_image is null or p_image !~ '^data:image/jpeg;base64,[A-Za-z0-9+/=]+$' or length(p_image) > 600000 then
    return public._fail('INVALID', 'Photo invalide.');
  end if;
  update public.vision_setup set snapshot = p_image, snapshot_at = now(), snapshot_requested_at = null where id = 1;
  perform public._audit('vision_snapshot', 'camera', '{}');
  return jsonb_build_object('ok', true);
end $$;

-- Effacer la photo de réglage (elle s'efface aussi toute seule au bout de 24 h : plus jamais renvoyée)
create or replace function public.vision_snapshot_clear() returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not public.has_role('chef') then return public._fail('FORBIDDEN', 'Réservé à la cuisine et à l''administration.'); end if;
  update public.vision_setup set snapshot = null, snapshot_at = null, snapshot_requested_at = null where id = 1;
  return jsonb_build_object('ok', true);
end $$;



revoke all on function public._vision_zones_ok(jsonb), public._vision_snapshot_purge() from public, anon, authenticated;
revoke all on function public.vision_setup_get(), public.vision_zones_save(jsonb), public.vision_snapshot_request(),
  public.vision_snapshot_put(text), public.vision_snapshot_clear() from public, anon;
grant execute on function public.vision_setup_get(), public.vision_zones_save(jsonb), public.vision_snapshot_request(),
  public.vision_snapshot_put(text), public.vision_snapshot_clear() to authenticated;
