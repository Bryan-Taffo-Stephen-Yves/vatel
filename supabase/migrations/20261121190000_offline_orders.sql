-- Commande hors ligne : l'élève prépare et confirme (PIN) sans réseau ; la commande attend sur le téléphone et part
-- toute seule au retour du réseau. Elle n'est VALIDÉE qu'à ce moment-là, par place_order_cart (menu, stock, allergies,
-- plage de la cuisine, solde, PIN) : jamais de plat vendu qui n'existe plus.
--
-- 1. place_order_offline : enveloppe de place_order_cart avec une CLÉ D'IDEMPOTENCE (une par commande en file) :
--    un envoi rejoué (réseau qui coupe pendant la réponse) renvoie la même commande, sans second débit.
--    L'heure choisie hors ligne est une préférence : le premier créneau libre à partir de cette heure est pris
--    (sinon le plus proche avant), car les places ont pu partir entre-temps.
-- 2. jean_contact : numéros publics de Jean (appel, WhatsApp), gardés sur le téléphone pour le bouton
--    « Appeler Jean » du bandeau « Pas de connexion » (un appel passe sans Internet).

create table if not exists public.offline_order_keys (
  key        uuid primary key,
  user_id    uuid not null references public.profiles (id) on delete cascade,
  result     jsonb,                      -- réponse de place_order_cart (commande réussie)
  created_at timestamptz not null default now()
);
alter table public.offline_order_keys enable row level security;   -- aucune règle : lisible seulement par les fonctions
revoke all on public.offline_order_keys from anon, authenticated;

create or replace function public.place_order_offline(p_key uuid, p_items jsonb, p_pickup_at timestamptz,
                                                      p_extras jsonb default '[]', p_pin text default null)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := auth.uid();
  v_row public.offline_order_keys;
  v_date date; v_service public.service_kind; v_n int;
  v_res jsonb;
  s record;
  v_tries int := 0;
begin
  if v_uid is null then return public._fail('AUTH_REQUIRED', 'Connexion requise.'); end if;
  if p_key is null then return public._fail('BAD_REQUEST', 'Commande invalide.'); end if;

  -- Clé déjà vue : même commande, rien de plus (l'insertion attend un envoi parallèle de la même clé)
  insert into public.offline_order_keys (key, user_id) values (p_key, v_uid) on conflict (key) do nothing;
  if not found then
    select * into v_row from public.offline_order_keys where key = p_key;
    if v_row.user_id <> v_uid then return public._fail('BAD_REQUEST', 'Commande invalide.'); end if;
    if v_row.result is not null then return v_row.result || jsonb_build_object('replayed', true); end if;
    return public._fail('IN_PROGRESS', 'Commande déjà en cours d''envoi.');
  end if;

  -- Repas de la commande et nombre de plats (pour choisir un créneau qui a la place)
  select mi.service_date, mi.service into v_date, v_service
    from public.menu_items mi where mi.id = (p_items -> 0 ->> 'menu_item_id')::uuid;
  select coalesce(sum(greatest(coalesce((e ->> 'qty')::int, 1), 0)), 0) into v_n from jsonb_array_elements(p_items) e;

  if v_date is null then
    v_res := public.place_order_cart(p_items, p_pickup_at, p_extras, p_pin);   -- message d'erreur habituel
  else
    -- Créneaux libres : d'abord à partir de l'heure souhaitée, puis les plus proches avant
    for s in select t.at from (
               select (x ->> 'at')::timestamptz as at from jsonb_array_elements(public.order_slots(v_date, v_service)) x
                where (x ->> 'left')::int >= greatest(v_n, 1)) t
              order by (t.at < coalesce(p_pickup_at, '-infinity')),
                       case when t.at >= coalesce(p_pickup_at, '-infinity') then t.at end asc nulls last,
                       t.at desc
    loop
      v_tries := v_tries + 1;
      v_res := public.place_order_cart(p_items, s.at, p_extras, p_pin);
      exit when coalesce((v_res ->> 'ok')::boolean, false)
             or coalesce(v_res ->> 'code', '') not in ('SLOT_FULL', 'SLOT_TOO_SOON', 'INVALID_SLOT')
             or v_tries >= 8;
    end loop;
    if v_res is null then
      v_res := public.place_order_cart(p_items, p_pickup_at, p_extras, p_pin);   -- pas de créneau : la raison exacte (fermé, épuisé…)
      if coalesce((v_res ->> 'ok')::boolean, false) is false and v_res ->> 'code' in ('INVALID_SLOT', 'SLOT_TOO_SOON', 'SLOT_FULL') then
        v_res := public._fail('NO_SLOT', 'Plus de créneau libre pour ce repas.');
      end if;
    end if;
  end if;

  if coalesce((v_res ->> 'ok')::boolean, false) then
    update public.offline_order_keys set result = v_res where key = p_key;
  else
    delete from public.offline_order_keys where key = p_key;   -- échec : la même commande pourra être renvoyée (ex. bon PIN)
  end if;
  delete from public.offline_order_keys where user_id = v_uid and created_at < now() - interval '7 days';
  return v_res;
end $$;
revoke all on function public.place_order_offline(uuid, jsonb, timestamptz, jsonb, text) from public, anon;
grant execute on function public.place_order_offline(uuid, jsonb, timestamptz, jsonb, text) to authenticated;

-- Numéros de Jean (publics par nature : ce sont les numéros que les élèves appellent)
update public.settings set value = value || '{"call_phone": null}'::jsonb
 where key = 'jean' and not (value ? 'call_phone');

create or replace function public.jean_contact() returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object('call', nullif(public.setting('jean') ->> 'call_phone', ''),
                            'whatsapp', nullif(public.setting('jean') ->> 'whatsapp_phone', ''))
$$;
revoke all on function public.jean_contact() from public, anon;
grant execute on function public.jean_contact() to authenticated;
