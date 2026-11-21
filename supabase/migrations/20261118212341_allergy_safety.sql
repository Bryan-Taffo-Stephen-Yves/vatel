-- Allergies : allergie « grave » (commande bloquée partout), traces possibles sur les plats, alerte au comptoir.
alter table public.profiles add column if not exists severe_allergies text[] not null default '{}';
alter table public.dishes add column if not exists traces text[] not null default '{}';

-- Allergènes graves présents dans un plat (contient ou traces)
create or replace function public._severe_hits(p_severe text[], p_allergens text[], p_traces text[]) returns text[]
language sql immutable as $$
  select coalesce(array(select distinct a from unnest(coalesce(p_severe, '{}')) a
                         where a = any (coalesce(p_allergens, '{}') || coalesce(p_traces, '{}')) order by 1), '{}')
$$;

-- Le client choisit lesquelles de ses allergies sont graves (sous-ensemble de ses allergies)
create or replace function public.set_my_severe_allergies(p_severe text[]) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null then return public._fail('AUTH_REQUIRED', 'Connexion requise.'); end if;
  update public.profiles set severe_allergies = array(select distinct a from unnest(coalesce(p_severe, '{}')) a where a = any (allergies))
   where id = auth.uid();
  return jsonb_build_object('ok', true);
end $$;

-- Retirer une allergie retire aussi son caractère grave
create or replace function public._severe_subset() returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  new.severe_allergies := array(select a from unnest(new.severe_allergies) a where a = any (new.allergies));
  return new;
end $$;
create or replace trigger profiles_severe_subset before update of allergies, severe_allergies on public.profiles
  for each row execute function public._severe_subset();

-- Comptoir : après un scan, ce que l'agent doit savoir (allergies du client, plats à risque)
create or replace function public.counter_allergy_alert(p_ticket_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_t public.tickets; v_p public.profiles;
begin
  if not public.has_role('agent') then return public._fail('FORBIDDEN', 'Compte agent requis.'); end if;
  select * into v_t from public.tickets where id = p_ticket_id;
  if not found then return public._fail('TICKET_NOT_FOUND', 'Ticket introuvable.'); end if;
  select * into v_p from public.profiles where id = v_t.user_id;
  return jsonb_build_object('ok', true, 'client', v_p.full_name,
    'allergies', v_p.allergies, 'severe', v_p.severe_allergies, 'diets', v_p.diets,
    -- Commande : plats commandés qui posent problème
    'order_risks', coalesce((
      select jsonb_agg(jsonb_build_object('dish', d.name,
               'severe', public._severe_hits(v_p.severe_allergies, d.allergens, d.traces),
               'reasons', public._diet_conflicts(v_p.allergies, v_p.diets, d.allergens, d.diet_tags)
                          || coalesce(array(select 'traces de ' || a from unnest(d.traces) a where a = any (v_p.allergies) and not a = any (d.allergens)), '{}')))
        from public.tickets t join public.menu_items mi on mi.id = t.menu_item_id join public.dishes d on d.id = mi.dish_id
       where t.user_id = v_t.user_id and t.order_no = v_t.order_no and t.pickup_at is not null and v_t.pickup_at is not null
         and (t.pickup_at at time zone 'Africa/Abidjan')::date = (v_t.pickup_at at time zone 'Africa/Abidjan')::date
         and (cardinality(public._severe_hits(v_p.severe_allergies, d.allergens, d.traces)) > 0
              or cardinality(public._diet_conflicts(v_p.allergies, v_p.diets, d.allergens, d.diet_tags)) > 0
              or exists (select 1 from unnest(d.traces) a where a = any (v_p.allergies)))), '[]'),
    -- Ticket repas : plats du service à éviter pour ce client (menu_item_id → raisons)
    'dish_risks', coalesce((
      select jsonb_object_agg(mi.id, jsonb_build_object('severe', public._severe_hits(v_p.severe_allergies, d.allergens, d.traces),
               'reasons', public._diet_conflicts(v_p.allergies, v_p.diets, d.allergens, d.diet_tags)
                          || coalesce(array(select 'traces de ' || a from unnest(d.traces) a where a = any (v_p.allergies) and not a = any (d.allergens)), '{}')))
        from public.menu_items mi join public.menus m on m.id = mi.menu_id and m.status = 'published' join public.dishes d on d.id = mi.dish_id
       where mi.service_date = coalesce(v_t.service_date, public.today_abidjan()) and mi.service = v_t.service
         and (cardinality(public._diet_conflicts(v_p.allergies, v_p.diets, d.allergens, d.diet_tags)) > 0
              or exists (select 1 from unnest(d.traces) a where a = any (v_p.allergies)))), '{}'::jsonb));
end $$;

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

  -- Allergie GRAVE déclarée par le client : commande refusée (allergènes et traces du plat)
  select d.name || ' contient ' || string_agg(distinct a, ', ') into v_err
    from jsonb_array_elements(v_lines) x join public.menu_items mi on mi.id = (x ->> 'id')::uuid
    join public.dishes d on d.id = mi.dish_id,
    unnest(public._severe_hits(v_me.severe_allergies, d.allergens, d.traces)) a
   group by d.name limit 1;
  if v_err is not null then
    return public._fail('ALLERGY_SEVERE', 'Allergie grave : ' || v_err || '. Choisis un autre plat.');
  end if;

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

create or replace function public.serve_dish(p_ticket_id uuid, p_menu_item_id uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := auth.uid();
  v_t public.tickets;
  v_mi record;
  v_hits text[];
begin
  if not public.has_role('agent') then return public._fail('FORBIDDEN', 'Compte agent requis.'); end if;
  select * into v_t from public.tickets where id = p_ticket_id for no key update;
  if not found or v_t.status <> 'used' then return public._fail('TICKET_NOT_FOUND', 'Scannez d''abord le ticket.'); end if;
  if v_t.dish_id is not null then return public._fail('ALREADY_SERVED', 'Plat déjà enregistré pour ce ticket.'); end if;
  if v_t.used_at < now() - interval '30 minutes' then return public._fail('TOO_LATE', 'Ticket scanné il y a plus de 30 minutes.'); end if;

  select mi.*, d.name as dish_name into v_mi
    from public.menu_items mi join public.menus m on m.id = mi.menu_id join public.dishes d on d.id = mi.dish_id
   where mi.id = p_menu_item_id and m.status = 'published'
     and mi.service_date = v_t.service_date and mi.service = v_t.service
     for no key update of mi;
  if not found then return public._fail('WRONG_ITEM', 'Ce plat n''est pas au menu de ce service.'); end if;
  if v_mi.is_sold_out or v_mi.is_full then return public._fail('SOLD_OUT', v_mi.dish_name || ' est épuisé.'); end if;
  -- Allergie grave du client : ce plat ne peut pas lui être servi
  select public._severe_hits(p.severe_allergies, d.allergens, d.traces) into v_hits
    from public.profiles p, public.dishes d where p.id = v_t.user_id and d.id = v_mi.dish_id;
  if cardinality(v_hits) > 0 then
    return public._fail('ALLERGY_SEVERE', 'Allergie grave : ' || v_mi.dish_name || ' contient ' || array_to_string(v_hits, ', ') || '. Servez un autre plat.');
  end if;

  update public.tickets set menu_item_id = v_mi.id, dish_id = v_mi.dish_id where id = v_t.id;
  update public.menu_items set sold_qty = sold_qty + 1, served_qty = served_qty + 1 where id = v_mi.id;
  insert into public.stock_movements (ingredient_id, type, qty, reason, menu_item_id, created_by)
  select rl.ingredient_id, 'out', rl.qty_per_portion, 'Portion servie', v_mi.id, v_uid
    from public.recipe_lines rl where rl.dish_id = v_mi.dish_id;
  -- La demande d'avis part 30 min après le repas (request_reviews, cron), plus au moment du service.
  perform public._audit('serve_dish', v_t.id::text, jsonb_build_object('dish', v_mi.dish_name));
  return jsonb_build_object('ok', true, 'dish', v_mi.dish_name,
                            'counters', public.service_counters(v_t.service_date, v_t.service));
end $$;

revoke all on function public.counter_allergy_alert(uuid) from public, anon;
grant execute on function public.counter_allergy_alert(uuid) to authenticated;
revoke all on function public.set_my_severe_allergies(text[]) from public, anon;
grant execute on function public.set_my_severe_allergies(text[]) to authenticated;
grant execute on function public._severe_hits(text[], text[], text[]) to service_role, authenticated;
