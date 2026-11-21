-- Commande groupée (panier) : plusieurs plats en quantité + suppléments, une seule heure de retrait, un seul numéro
-- de commande, une seule confirmation (PIN / Face ID). Commandes pour le JOUR MÊME uniquement.
-- Une commande = N tickets (1 par plat) partageant le même order_no ; la cuisine et le comptoir les traitent ensemble.

update public.settings
   set value = value || jsonb_build_object('same_day_only', true, 'max_dishes_per_order', 10)
 where key = 'orders';

alter table public.order_requests add column if not exists items jsonb;          -- [{menu_item_id, qty}]
alter table public.order_requests add column if not exists extras jsonb not null default '[]';  -- [{extra_id, qty}]
alter table public.order_requests add column if not exists ticket_ids uuid[];

-- Créneaux : seulement aujourd'hui quand same_day_only
create or replace function public.order_slots(p_date date, p_service public.service_kind) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_cfg jsonb := public.setting('orders');
  v_step int := coalesce((v_cfg ->> 'slot_minutes')::int, 15);
  v_cap int := coalesce((v_cfg ->> 'slot_capacity')::int, 30);
  v_lead int := coalesce((v_cfg ->> 'min_lead_minutes')::int, 20);
  w record;
begin
  if coalesce((v_cfg ->> 'same_day_only')::boolean, false) and p_date <> public.today_abidjan() then return '[]'; end if;
  select * into w from public._service_window(p_date, p_service);
  if w.starts is null then return '[]'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('at', s, 'left', greatest(v_cap - coalesce(n, 0), 0)) order by s)
      from generate_series(w.starts, w.ends - make_interval(mins => v_step), make_interval(mins => v_step)) s
      left join lateral (select count(*) n from public.tickets t
                          where t.pickup_at = s and t.status in ('valid', 'used')) c on true
     where s >= now() + make_interval(mins => v_lead)), '[]');
end $$;

/** Résumé lisible d'une commande : « 4 × Frites omelette + 1 × Riz poulet » */
create or replace function public._order_summary(p_user uuid, p_order_no int, p_date date) returns text
language sql stable security definer set search_path = public, pg_temp as $$
  select string_agg(case when n > 1 then n || ' × ' else '' end || name, ' + ' order by n desc, name)
    from (select d.name, count(*) n
            from public.tickets t join public.menu_items mi on mi.id = t.menu_item_id join public.dishes d on d.id = mi.dish_id
           where t.user_id = p_user and t.order_no = p_order_no and t.pickup_at is not null
             and (t.pickup_at at time zone 'Africa/Abidjan')::date = p_date and t.status <> 'cancelled'
           group by d.name) x;
$$;

create or replace function public.place_order_cart(p_items jsonb, p_pickup_at timestamptz,
                                                   p_extras jsonb default '[]', p_pin text default null)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := auth.uid();
  v_me public.profiles;
  v_cfg jsonb := public.setting('orders');
  v_step int := coalesce((v_cfg ->> 'slot_minutes')::int, 15);
  v_max int := coalesce((v_cfg ->> 'max_dishes_per_order')::int, 10);
  v_now_t time := (now() at time zone 'Africa/Abidjan')::time;
  v_lines jsonb;          -- [{id, qty, price, name}]
  v_n int;
  v_date date; v_service public.service_kind;
  v_win jsonb; v_svc jsonb; w record;
  v_ext jsonb := '[]';    -- [{id, name, kind, price, qty}]
  v_starters jsonb := '[]'; v_desserts jsonb := '[]';
  v_total int; v_err text; v_balance int; v_no int;
  v_ids uuid[] := '{}'; v_id uuid; v_i int := 0;
  l jsonb; k int; v_tex jsonb; v_tprice int;
  v_summary text; v_extra_txt text; v_when text;
begin
  if v_uid is null then return public._fail('AUTH_REQUIRED', 'Connexion requise.'); end if;
  select * into v_me from public.profiles where id = v_uid;
  if v_me.is_blocked then return public._fail('ACCOUNT_BLOCKED', 'Votre compte est bloqué.'); end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then return public._fail('EMPTY', 'Aucun plat choisi.'); end if;

  -- Plats (regroupés), au menu publié, verrouillés
  select jsonb_agg(jsonb_build_object('id', mi.id, 'qty', q.qty, 'price', mi.price, 'name', d.name,
                                      'date', mi.service_date, 'service', mi.service, 'left',
                                      case when mi.planned_qty is null then null else mi.planned_qty - mi.sold_qty end,
                                      'sold_out', mi.is_sold_out or mi.is_full) order by d.name)
    into v_lines
    from (select (e ->> 'menu_item_id')::uuid id, sum(greatest(coalesce((e ->> 'qty')::int, 1), 0))::int qty
            from jsonb_array_elements(p_items) e group by 1) q
    join public.menu_items mi on mi.id = q.id join public.menus m on m.id = mi.menu_id and m.status = 'published'
    join public.dishes d on d.id = mi.dish_id
   where q.qty > 0;
  if v_lines is null or jsonb_array_length(v_lines) <> (select count(distinct e ->> 'menu_item_id') from jsonb_array_elements(p_items) e where coalesce((e ->> 'qty')::int, 1) > 0) then
    return public._fail('WRONG_ITEM', 'Un des plats n''est pas au menu.');
  end if;
  perform 1 from public.menu_items where id in (select (x ->> 'id')::uuid from jsonb_array_elements(v_lines) x) for no key update;
  select sum((x ->> 'qty')::int) into v_n from jsonb_array_elements(v_lines) x;
  if v_n > v_max then return public._fail('TOO_MANY_DISHES', 'Au plus ' || v_max || ' plats par commande.'); end if;
  if (select count(distinct (x ->> 'date') || (x ->> 'service')) from jsonb_array_elements(v_lines) x) > 1 then
    return public._fail('MIXED_MEALS', 'Une commande = un seul repas (ex. le déjeuner). Fais une commande par repas.');
  end if;
  v_date := (v_lines -> 0 ->> 'date')::date; v_service := (v_lines -> 0 ->> 'service')::public.service_kind;
  select x ->> 'name' into v_err from jsonb_array_elements(v_lines) x
   where (x ->> 'sold_out')::boolean or ((x ->> 'left') is not null and (x ->> 'left')::int < (x ->> 'qty')::int) limit 1;
  if v_err is not null then return public._fail('SOLD_OUT', 'Plus assez de ' || v_err || '.'); end if;

  -- Jour même uniquement
  if coalesce((v_cfg ->> 'same_day_only')::boolean, false) and v_date <> public.today_abidjan() then
    return public._fail('TODAY_ONLY', 'On ne commande que les plats du jour.');
  end if;
  if v_date > public.today_abidjan() + coalesce((v_cfg ->> 'max_days_ahead')::int, 7) then
    return public._fail('TOO_EARLY', 'Trop tôt pour commander ce repas.');
  end if;

  -- Plage de la cuisine et pause
  v_win := v_cfg -> 'windows' -> v_service::text;
  if coalesce((v_win ->> 'paused')::boolean, false) then
    return public._fail('ORDERS_PAUSED', 'La cuisine a mis les commandes du ' || lower(public.service_label(v_service)) || ' en pause. Réessayez plus tard.');
  end if;
  if v_date = public.today_abidjan() and v_win ->> 'open' is not null and v_win ->> 'close' is not null
     and (v_now_t < (v_win ->> 'open')::time or v_now_t >= (v_win ->> 'close')::time) then
    return public._fail('ORDERS_CLOSED', 'Commandes du ' || lower(public.service_label(v_service)) || ' : de '
      || replace(v_win ->> 'open', ':', 'h') || ' à ' || replace(v_win ->> 'close', ':', 'h') || '.'
      || case when v_now_t < (v_win ->> 'open')::time then ' Revenez à ' || replace(v_win ->> 'open', ':', 'h') || '.' else ' C''est fermé pour aujourd''hui.' end);
  end if;
  -- Anti-abus : nombre de commandes (pas de plats) en cours par repas
  if (select count(distinct order_no) from public.tickets
       where user_id = v_uid and pickup_at is not null and status = 'valid' and service = v_service
         and (pickup_at at time zone 'Africa/Abidjan')::date = v_date)
     >= coalesce((v_cfg ->> 'max_active_per_meal')::int, 2) then
    return public._fail('TOO_MANY_ORDERS', 'Vous avez déjà ' || coalesce(v_cfg ->> 'max_active_per_meal', '2') || ' commandes pour ce repas.');
  end if;

  -- Créneau
  select * into w from public._service_window(v_date, v_service);
  if p_pickup_at is null or p_pickup_at < w.starts or p_pickup_at >= w.ends
     or extract(epoch from (p_pickup_at - w.starts))::int % (v_step * 60) <> 0 then
    return public._fail('INVALID_SLOT', 'Créneau invalide.');
  end if;
  if p_pickup_at < now() + make_interval(mins => coalesce((v_cfg ->> 'min_lead_minutes')::int, 20)) then
    return public._fail('SLOT_TOO_SOON', 'Ce créneau est trop proche : la cuisine a besoin d''au moins '
      || coalesce(v_cfg ->> 'min_lead_minutes', '20') || ' minutes.');
  end if;
  perform pg_advisory_xact_lock(hashtext('order-slot:' || p_pickup_at::text));
  if (select count(*) from public.tickets where pickup_at = p_pickup_at and status in ('valid', 'used')) + v_n
     > coalesce((v_cfg ->> 'slot_capacity')::int, 30) then
    return public._fail('SLOT_FULL', 'Ce créneau est complet pour ' || v_n || ' plat(s), choisissez-en un autre.');
  end if;

  -- Suppléments : au plus une entrée et un dessert PAR PLAT, si le repas les autorise
  if jsonb_typeof(p_extras) = 'array' and jsonb_array_length(p_extras) > 0 then
    v_svc := public.setting('services') -> v_service::text;
    if not coalesce((v_svc ->> 'extras')::boolean, false) then
      return public._fail('EXTRAS_NOT_ALLOWED', 'Pas de supplément pour ce repas.');
    end if;
    select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'name', x.name, 'kind', x.kind, 'price', x.price, 'qty', q.qty)), '[]')
      into v_ext
      from (select (e ->> 'extra_id')::uuid id, sum(greatest(coalesce((e ->> 'qty')::int, 1), 0))::int qty
              from jsonb_array_elements(p_extras) e group by 1) q
      join public.extras x on x.id = q.id and x.is_active and x.kind in ('starter', 'dessert')
     where q.qty > 0;
    if jsonb_array_length(v_ext) <> (select count(distinct e ->> 'extra_id') from jsonb_array_elements(p_extras) e where coalesce((e ->> 'qty')::int, 1) > 0) then
      return public._fail('INVALID_EXTRA', 'Supplément inconnu.');
    end if;
    if coalesce((select sum((x ->> 'qty')::int) from jsonb_array_elements(v_ext) x where x ->> 'kind' = 'starter'), 0) > v_n
       or coalesce((select sum((x ->> 'qty')::int) from jsonb_array_elements(v_ext) x where x ->> 'kind' = 'dessert'), 0) > v_n then
      return public._fail('INVALID_EXTRA', 'Au plus une entrée et un dessert par plat (' || v_n || ' plat(s)).');
    end if;
    -- Une ligne par unité, pour les répartir sur les tickets
    select coalesce(jsonb_agg(jsonb_build_object('id', x ->> 'id', 'name', x ->> 'name', 'kind', x ->> 'kind', 'price', (x ->> 'price')::int)), '[]')
      into v_starters from jsonb_array_elements(v_ext) x, generate_series(1, (x ->> 'qty')::int) where x ->> 'kind' = 'starter';
    select coalesce(jsonb_agg(jsonb_build_object('id', x ->> 'id', 'name', x ->> 'name', 'kind', x ->> 'kind', 'price', (x ->> 'price')::int)), '[]')
      into v_desserts from jsonb_array_elements(v_ext) x, generate_series(1, (x ->> 'qty')::int) where x ->> 'kind' = 'dessert';
  end if;
  v_total := coalesce((select sum((x ->> 'qty')::int * (x ->> 'price')::int) from jsonb_array_elements(v_lines) x), 0)
           + coalesce((select sum((x ->> 'qty')::int * (x ->> 'price')::int) from jsonb_array_elements(v_ext) x), 0);

  -- Confirmation par le titulaire
  if coalesce((v_cfg ->> 'pin_always')::boolean, true) or v_total > coalesce((public.setting('pin_threshold'))::int, 5000) then
    v_err := public._check_pin(v_uid, p_pin);
    if v_err is not null then return public._pin_fail(v_err); end if;
  end if;
  select balance into v_balance from public.wallets where user_id = v_uid for update;
  if v_balance < v_total then
    return public._fail('INSUFFICIENT_FUNDS', 'Solde insuffisant : il faut ' || v_total || ' F, tu as ' || v_balance || ' F.',
      jsonb_build_object('balance', v_balance, 'total', v_total));
  end if;

  perform pg_advisory_xact_lock(hashtext('order-no:' || v_date::text));
  select coalesce(max(order_no), 0) + 1 into v_no from public.tickets
   where pickup_at is not null and (pickup_at at time zone 'Africa/Abidjan')::date = v_date;

  -- Un ticket par plat, suppléments répartis (au plus 1 entrée + 1 dessert chacun)
  for l in select * from jsonb_array_elements(v_lines) loop
    for k in 1 .. (l ->> 'qty')::int loop
      v_tex := '[]';
      if v_i < jsonb_array_length(v_starters) then v_tex := v_tex || jsonb_build_array(v_starters -> v_i); end if;
      if v_i < jsonb_array_length(v_desserts) then v_tex := v_tex || jsonb_build_array(v_desserts -> v_i); end if;
      v_tprice := (l ->> 'price')::int + coalesce((select sum((e ->> 'price')::int) from jsonb_array_elements(v_tex) e), 0);
      insert into public.tickets (user_id, buyer_id, service, menu_item_id, extras, total, valid_from, valid_until,
                                  pickup_at, order_no, prep_status)
      values (v_uid, v_uid, v_service, (l ->> 'id')::uuid, v_tex, v_tprice, now(), w.ends, p_pickup_at, v_no, 'received')
      returning id into v_id;
      v_ids := v_ids || v_id; v_i := v_i + 1;
    end loop;
    update public.menu_items set sold_qty = sold_qty + (l ->> 'qty')::int where id = (l ->> 'id')::uuid;
  end loop;

  select string_agg(case when (x ->> 'qty')::int > 1 then (x ->> 'qty') || ' × ' else '' end || (x ->> 'name'), ' + ')
    into v_summary from jsonb_array_elements(v_lines) x;
  select string_agg(case when (x ->> 'qty')::int > 1 then (x ->> 'qty') || ' × ' else '' end || (x ->> 'name'), ' + ')
    into v_extra_txt from jsonb_array_elements(v_ext) x;
  v_when := public._day_label(v_date) || ' à ' || to_char(p_pickup_at at time zone 'Africa/Abidjan', 'HH24"h"MI');

  perform public._wallet_move(v_uid, -v_total, 'purchase', p_ticket => v_ids[1],
    p_note => 'Commande n° ' || v_no || ' · ' || v_summary || coalesce(' + ' || v_extra_txt, ''));
  perform public._notify_roles('{chef,agent}', 'order_new', 'Nouvelle commande n° ' || v_no || ' 🛎️',
    v_summary || coalesce(' + ' || v_extra_txt, '') || ' · ' || v_me.full_name || ' · retrait ' || v_when,
    jsonb_build_object('ticket_id', v_ids[1], 'href', '/admin/commandes'));
  perform public._audit('place_order', v_ids[1]::text, jsonb_build_object('order_no', v_no, 'dishes', v_n, 'pickup_at', p_pickup_at));
  perform public._notify(v_uid, 'order_placed', 'Commande n° ' || v_no || ' bien reçue ✅',
    v_summary || coalesce(' + ' || v_extra_txt, '') || ' · retrait ' || v_when || '. On te prévient quand la cuisine la prépare, puis quand elle est prête.',
    jsonb_build_object('ticket_id', v_ids[1], 'href', '/app/tickets/' || v_ids[1]));

  return jsonb_build_object('ok', true, 'ticket_id', v_ids[1], 'ticket_ids', to_jsonb(v_ids), 'order_no', v_no,
    'total', v_total, 'dish', v_summary, 'extras', v_extra_txt, 'dishes', v_n,
    'pickup_at', p_pickup_at, 'pickup_until', w.ends, 'cancel_until', public._order_cancel_deadline(p_pickup_at, v_service),
    'balance', (select balance from public.wallets where user_id = v_uid));
end $$;
revoke all on function public.place_order_cart(jsonb, timestamptz, jsonb, text) from public, anon;
grant execute on function public.place_order_cart(jsonb, timestamptz, jsonb, text) to authenticated;

-- Ancienne signature (appli) : un plat = un panier d'un plat
create or replace function public.place_order(p_menu_item_id uuid, p_pickup_at timestamptz,
                                              p_extra_ids uuid[] default '{}', p_pin text default null)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_ex jsonb;
begin
  if cardinality(coalesce(p_extra_ids, '{}')) > 0
     and (select count(*) from public.extras x where x.id = any (p_extra_ids) group by x.kind order by 1 desc limit 1) > 1 then
    return public._fail('INVALID_EXTRA', 'Au plus une entrée et un dessert.');
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('extra_id', e, 'qty', 1)), '[]') into v_ex from unnest(coalesce(p_extra_ids, '{}')) e;
  return public.place_order_cart(jsonb_build_array(jsonb_build_object('menu_item_id', p_menu_item_id, 'qty', 1)), p_pickup_at, v_ex, p_pin);
end $$;
revoke all on function public.place_order(uuid, timestamptz, uuid[], text) from public, anon;
grant execute on function public.place_order(uuid, timestamptz, uuid[], text) to authenticated;

-- Demande de Jean : panier si items, sinon un seul plat (ancien format)
create or replace function public.confirm_order_request(p_token text, p_pin text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_r public.order_requests; v_res jsonb; v_ex jsonb;
begin
  if auth.uid() is null then return public._fail('AUTH_REQUIRED', 'Connexion requise.'); end if;
  select * into v_r from public.order_requests where token = p_token for update;
  if not found or v_r.user_id <> auth.uid() then return public._fail('NOT_FOUND', 'Demande introuvable sur ce compte.'); end if;
  if v_r.status = 'done' then return jsonb_build_object('ok', true, 'ticket_id', v_r.ticket_id, 'already', true); end if;
  if v_r.status <> 'pending' or v_r.expires_at < now() then
    return public._fail('EXPIRED', 'Cette demande a expiré. Redemande à Jean.');
  end if;
  if v_r.items is not null then
    v_res := public.place_order_cart(v_r.items, v_r.pickup_at, v_r.extras, p_pin);
  else
    select coalesce(jsonb_agg(jsonb_build_object('extra_id', e, 'qty', 1)), '[]') into v_ex from unnest(v_r.extra_ids) e;
    v_res := public.place_order_cart(jsonb_build_array(jsonb_build_object('menu_item_id', v_r.menu_item_id, 'qty', 1)), v_r.pickup_at, v_ex, p_pin);
  end if;
  if coalesce((v_res ->> 'ok')::boolean, false) then
    update public.order_requests set status = 'done', ticket_id = (v_res ->> 'ticket_id')::uuid,
           ticket_ids = array(select jsonb_array_elements_text(v_res -> 'ticket_ids')::uuid) where id = v_r.id;
  end if;
  return v_res;
end $$;
revoke all on function public.confirm_order_request(text, text) from public, anon;
grant execute on function public.confirm_order_request(text, text) to authenticated;

-- Cuisine : une carte par commande (plats regroupés)
create or replace function public.kitchen_orders(p_date date default null) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_date date := coalesce(p_date, public.today_abidjan());
begin
  if not (public.has_role('chef') or public.has_role('agent')) then return public._fail('FORBIDDEN', 'Réservé à la cuisine.'); end if;
  return jsonb_build_object('ok', true, 'date', v_date, 'orders', coalesce((
    select jsonb_agg(o order by o ->> 'pickup_at', (o ->> 'no')::int) from (
      select jsonb_build_object(
               'id', (array_agg(t.id order by t.created_at))[1], 'no', t.order_no, 'client', p.full_name,
               'short_code', p.short_code, 'avatar', p.avatar, 'user_id', p.id,
               'dish', public._order_summary(t.user_id, t.order_no, v_date), 'qty', count(distinct t.id),
               'photo_url', (array_agg(d.photo_url order by t.created_at))[1],
               'extras', coalesce(jsonb_agg(e) filter (where e is not null), '[]'), 'service', min(t.service::text),
               'pickup_at', min(t.pickup_at), 'prep_status', min(t.prep_status),
               'status', case when bool_or(t.status = 'valid') then 'valid' else min(t.status::text) end,
               'ready_at', max(t.ready_at), 'used_at', max(t.used_at), 'created_at', min(t.created_at)) o
        from public.tickets t
        join public.profiles p on p.id = t.user_id
        join public.menu_items mi on mi.id = t.menu_item_id
        join public.dishes d on d.id = mi.dish_id
        left join lateral jsonb_array_elements(t.extras) e on true
       where t.pickup_at is not null and t.status <> 'cancelled'
         and (t.pickup_at at time zone 'Africa/Abidjan')::date = v_date
       group by t.order_no, t.user_id, p.id) g), '[]'::jsonb));
end $$;

-- Statut en cuisine : appliqué à toute la commande
create or replace function public.set_order_status(p_ticket_id uuid, p_status text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_t public.tickets; v_dish text; v_date date;
begin
  if not (public.has_role('chef') or public.has_role('agent')) then return public._fail('FORBIDDEN', 'Réservé à la cuisine.'); end if;
  if p_status not in ('received', 'preparing', 'ready') then return public._fail('INVALID_STATUS', 'Statut inconnu.'); end if;
  select * into v_t from public.tickets where id = p_ticket_id and pickup_at is not null;
  if not found then return public._fail('NOT_FOUND', 'Commande introuvable.'); end if;
  v_date := (v_t.pickup_at at time zone 'Africa/Abidjan')::date;
  perform 1 from public.tickets where user_id = v_t.user_id and order_no = v_t.order_no and pickup_at is not null
     and (pickup_at at time zone 'Africa/Abidjan')::date = v_date for no key update;
  if not exists (select 1 from public.tickets where user_id = v_t.user_id and order_no = v_t.order_no and status = 'valid'
                   and pickup_at is not null and (pickup_at at time zone 'Africa/Abidjan')::date = v_date) then
    return public._fail('INVALID_STATUS', 'Commande déjà récupérée ou terminée.');
  end if;
  if v_t.prep_status = p_status then return jsonb_build_object('ok', true); end if;

  update public.tickets set prep_status = p_status, ready_at = case when p_status = 'ready' then now() end
   where user_id = v_t.user_id and order_no = v_t.order_no and status = 'valid' and pickup_at is not null
     and (pickup_at at time zone 'Africa/Abidjan')::date = v_date;
  v_dish := public._order_summary(v_t.user_id, v_t.order_no, v_date);
  if p_status = 'preparing' then
    perform public._notify(v_t.user_id, 'order_preparing', 'La cuisine prépare ta commande n° ' || v_t.order_no || ' 👨‍🍳',
      v_dish || ' en préparation. Retrait à ' || to_char(v_t.pickup_at at time zone 'Africa/Abidjan', 'HH24"h"MI') || '.',
      jsonb_build_object('ticket_id', v_t.id, 'href', '/app/tickets/' || v_t.id));
  end if;
  if p_status = 'ready' then
    perform public._notify(v_t.user_id, 'order_ready', 'Ta commande n° ' || v_t.order_no || ' est prête 🍽️',
      v_dish || ' t''attend au comptoir. À récupérer avant ' || to_char(v_t.valid_until at time zone 'Africa/Abidjan', 'HH24"h"MI') || '.',
      jsonb_build_object('ticket_id', v_t.id, 'href', '/app/tickets/' || v_t.id));
  end if;
  perform public._audit('order_status', v_t.id::text, jsonb_build_object('status', p_status, 'order_no', v_t.order_no));
  return jsonb_build_object('ok', true);
end $$;

-- Rappel : un seul message par commande
create or replace function public.remind_order_pickups() returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_n int;
begin
  with due as (
    update public.tickets t set pickup_reminded_at = now()
     where t.status = 'valid' and t.pickup_at is not null and t.pickup_reminded_at is null
       and t.valid_until > now() and t.valid_until <= now() + interval '35 minutes'
       and t.pickup_at <= now()
    returning t.id, t.user_id, t.order_no, t.valid_until, t.pickup_at
  ), one as (
    select distinct on (user_id, order_no) * from due order by user_id, order_no, id
  )
  insert into public.notifications (user_id, type, title, body, data)
  select one.user_id, 'order_pickup_reminder', 'Ta commande n° ' || one.order_no || ' t''attend 🍽️',
         coalesce(public._order_summary(one.user_id, one.order_no, (one.pickup_at at time zone 'Africa/Abidjan')::date), 'Ta commande')
           || ' à récupérer avant ' || to_char(one.valid_until at time zone 'Africa/Abidjan', 'HH24"h"MI')
           || '. Après, elle sera perdue.',
         jsonb_build_object('ticket_id', one.id, 'href', '/app/tickets/' || one.id)
    from one;
  get diagnostics v_n = row_count;
  return v_n;
end $$;

-- Comptoir : scanner un ticket d'une commande remet toute la commande
create or replace function public.redeem_ticket(p_ticket_id uuid, p_nonce text, p_agent_id uuid,
                                                p_service_date date, p_service public.service_kind)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_t public.tickets;
  v_agent public.profiles;
  v_client text;
  v_by text;
  v_buyer text;
  v_batch int;
  v_remaining int;
  v_dish text;
  v_ids uuid[];
begin
  select * into v_agent from public.profiles where id = p_agent_id;
  if not found or v_agent.is_blocked or v_agent.role not in ('agent', 'admin') then
    return public._fail('FORBIDDEN', 'Compte agent requis.');
  end if;

  -- Commande : bon jour et créneau atteint (vérifié avant l'UPDATE)
  select * into v_t from public.tickets where id = p_ticket_id and qr_nonce = p_nonce and status = 'valid';
  if found and v_t.pickup_at is not null then
    if (v_t.pickup_at at time zone 'Africa/Abidjan')::date <> p_service_date then
      return public._fail('WRONG_DAY', 'Commande n° ' || v_t.order_no || ' prévue ' || public._day_label((v_t.pickup_at at time zone 'Africa/Abidjan')::date)
        || ' à ' || to_char(v_t.pickup_at at time zone 'Africa/Abidjan', 'HH24"h"MI') || '.');
    end if;
    if now() < v_t.pickup_at - interval '10 minutes' and coalesce(v_t.prep_status, '') <> 'ready' then
      return public._fail('TOO_EARLY', 'Commande n° ' || v_t.order_no || ' prévue à '
        || to_char(v_t.pickup_at at time zone 'Africa/Abidjan', 'HH24"h"MI') || ' : pas encore prête.');
    end if;
  end if;

  -- Une seule transaction peut faire passer valid → used, même avec plusieurs scanners
  update public.tickets
     set status = 'used', used_at = now(), scanned_by = p_agent_id, service_date = p_service_date
   where id = p_ticket_id and qr_nonce = p_nonce and status = 'valid' and service = p_service
     and now() < valid_until
  returning * into v_t;

  if not found then
    select * into v_t from public.tickets where id = p_ticket_id;
    if not found or v_t.qr_nonce <> p_nonce then
      return public._fail('INVALID_QR', 'QR invalide.');
    elsif v_t.status = 'used' then
      select full_name into v_by from public.profiles where id = v_t.scanned_by;
      return public._fail('ALREADY_USED',
        'Déjà utilisé le ' || to_char(v_t.used_at at time zone 'Africa/Abidjan', 'DD/MM "à" HH24"h"MI') || ' par ' || coalesce(v_by, '?') || '.',
        jsonb_build_object('used_at', v_t.used_at, 'scanned_by', v_by));
    elsif v_t.status = 'cancelled' then
      return public._fail('CANCELLED', 'Ticket annulé (remboursé).');
    elsif v_t.status = 'expired' or now() >= v_t.valid_until then
      return public._fail('EXPIRED', case when v_t.pickup_at is not null then 'Commande non récupérée à temps (fin du service).'
        else 'Ticket expiré le ' || to_char(v_t.valid_until at time zone 'Africa/Abidjan', 'DD/MM "à" HH24"h"MI') || '.' end);
    else
      return public._fail('WRONG_SERVICE', 'Ticket ' || public.service_label(v_t.service) || ' : pas valable pour le '
        || lower(public.service_label(p_service)) || '.', jsonb_build_object('service', v_t.service));
    end if;
  end if;

  update public.profiles set points = points + coalesce((public.setting('loyalty') ->> 'points_per_ticket')::int, 1)
   where id = v_t.user_id returning full_name into v_client;
  perform public._audit('redeem_ticket', v_t.id::text, jsonb_build_object('service', v_t.service), p_agent_id);

  -- Commande : le plat commandé est servi (portion déjà réservée, sortie de stock maintenant)
  if v_t.pickup_at is not null then
    -- Toute la commande est remise d'un coup (autres plats du même numéro, même client, même jour)
    with sib as (
      update public.tickets s set status = 'used', used_at = now(), scanned_by = p_agent_id, service_date = p_service_date
       where s.user_id = v_t.user_id and s.order_no = v_t.order_no and s.id <> v_t.id and s.status = 'valid'
         and s.pickup_at is not null and (s.pickup_at at time zone 'Africa/Abidjan')::date = (v_t.pickup_at at time zone 'Africa/Abidjan')::date
         and now() < s.valid_until
      returning s.id)
    select coalesce(array_agg(id), '{}') into v_ids from sib;
    v_ids := v_ids || v_t.id;
    if cardinality(v_ids) > 1 then
      update public.profiles set points = points + (cardinality(v_ids) - 1) * coalesce((public.setting('loyalty') ->> 'points_per_ticket')::int, 1)
       where id = v_t.user_id;
    end if;
    update public.tickets set dish_id = mi.dish_id from public.menu_items mi where mi.id = tickets.menu_item_id and tickets.id = any (v_ids);
    update public.menu_items mi set served_qty = served_qty + c.n
      from (select menu_item_id, count(*) n from public.tickets where id = any (v_ids) group by 1) c where mi.id = c.menu_item_id;
    insert into public.stock_movements (ingredient_id, type, qty, reason, menu_item_id, created_by)
    select rl.ingredient_id, 'out', rl.qty_per_portion, 'Commande servie', mi.id, p_agent_id
      from public.tickets t join public.menu_items mi on mi.id = t.menu_item_id join public.recipe_lines rl on rl.dish_id = mi.dish_id
     where t.id = any (v_ids);
    v_dish := public._order_summary(v_t.user_id, v_t.order_no, (v_t.pickup_at at time zone 'Africa/Abidjan')::date);
    return jsonb_build_object('ok', true, 'ticket_id', v_t.id, 'client', v_client,
      'ticket', public.service_label(v_t.service), 'service', v_t.service,
      'extras', (select coalesce(jsonb_agg(e), '[]') from public.tickets t, jsonb_array_elements(t.extras) e where t.id = any (v_ids)),
      'used_at', v_t.used_at,
      'order', jsonb_build_object('no', v_t.order_no, 'dish', v_dish, 'qty', cardinality(v_ids), 'pickup_at', v_t.pickup_at, 'ready', v_t.prep_status = 'ready'),
      'dishes', '[]'::jsonb, 'counters', public.service_counters(p_service_date, p_service));
  end if;

  select count(*) into v_batch from public.tickets
   where buyer_id = v_t.buyer_id and service = v_t.service and created_at = v_t.created_at;
  select count(*) into v_remaining from public.tickets
   where user_id = v_t.user_id and service = v_t.service and status = 'valid' and valid_until > now() and pickup_at is null;
  if v_t.buyer_id <> v_t.user_id then select full_name into v_buyer from public.profiles where id = v_t.buyer_id; end if;

  return jsonb_build_object('ok', true, 'ticket_id', v_t.id, 'client', v_client,
    'ticket', public.service_label(v_t.service), 'service', v_t.service, 'extras', v_t.extras, 'used_at', v_t.used_at,
    'batch_size', v_batch, 'remaining', v_remaining, 'gift_from', v_buyer, 'is_reward', v_t.is_reward,
    'dishes', public._service_dishes(p_service_date, p_service),
    'counters', public.service_counters(p_service_date, p_service));
end $$;
