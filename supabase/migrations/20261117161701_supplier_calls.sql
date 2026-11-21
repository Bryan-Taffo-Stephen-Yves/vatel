-- Agent vocal « l'appeleur » (§20.4) : il appelle un fournisseur, demande le prix et la livraison, et l'appli décide.
-- Règles de décision dans le code (pas dans l'IA) : prix ≤ habituel + 10 % et total ≤ budget → commandé ;
-- trop cher → à valider par le chef ; ne livre pas → coursier ; pas de réponse → injoignable (3 essais).
-- Chaque étape devient un événement (fil dans l'appli, groupe WhatsApp s'il existe, notification au chef).

insert into public.settings (key, value) values ('supplier_calls', jsonb_build_object(
  'agent_id', null, 'llm_id', null, 'from_number', null, 'price_tolerance', 0.10, 'max_calls_per_day', 30, 'max_attempts', 3))
on conflict (key) do nothing;

-- Carnet de prix : ce que la cantine achète chez chaque fournisseur, comment c'est vendu, et à quel prix d'habitude.
-- L'agent vocal s'en sert pour annoncer la commande et juger le prix ; les prix se mettent à jour après chaque achat.
create table if not exists public.supplier_products (
  id             uuid primary key default gen_random_uuid(),
  supplier_id    uuid not null references public.suppliers (id) on delete cascade,
  ingredient_id  uuid references public.ingredients (id),
  label          text not null,                  -- « sac de riz de 25 kg », « poulet entier »
  unit           text not null,                  -- sac, poulet, kg, bidon, carton…
  stock_per_unit numeric(10,3) not null default 1 check (stock_per_unit > 0),  -- unités de stock par unité achetée (sac de 25 kg → 25)
  usual_price    int not null check (usual_price > 0),                         -- FCFA par unité achetée
  default_qty    numeric(10,2) not null default 1,
  is_preferred   boolean not null default true,
  last_price     int, last_price_at timestamptz,
  unique (supplier_id, label)
);
alter table public.supplier_products enable row level security;
create policy "carnet de prix : cuisine" on public.supplier_products for select to authenticated using (public.has_role('chef'));
grant select on public.supplier_products to authenticated;
grant all on public.supplier_products to service_role;

-- Prix de démo (marchés d'Abidjan, novembre 2026, ordres de grandeur)
insert into public.supplier_products (supplier_id, ingredient_id, label, unit, stock_per_unit, usual_price, default_qty)
select s.id, i.id, v.label, v.unit, v.per, v.price, v.qty
  from (values
    ('Boucherie Bamba', 'Poulet', 'poulets entiers (≈ 1,5 kg)', 'poulet', 1.5, 2800, 20),
    ('Grossiste Koné', 'Riz', 'sacs de riz de 25 kg', 'sac', 25, 18500, 2),
    ('Grossiste Koné', 'Huile', 'bidons d''huile de 20 L', 'bidon', 20, 21500, 1),
    ('Grossiste Koné', 'Sucre', 'sacs de sucre de 50 kg', 'sac', 50, 32000, 1),
    ('Grossiste Koné', 'Farine', 'sacs de farine de 50 kg', 'sac', 50, 24000, 1),
    ('Grossiste Koné', 'Spaghetti', 'cartons de spaghetti (10 kg)', 'carton', 10, 9500, 1),
    ('Grossiste Koné', 'Pâte d''arachide', 'seaux de pâte d''arachide (5 kg)', 'seau', 5, 7500, 1),
    ('Grossiste Koné', 'Lait', 'cartons de lait (12 L)', 'carton', 12, 10800, 1),
    ('Marché de Cocody', 'Tomate', 'sacs de tomates (≈ 25 kg)', 'sac', 25, 9000, 2),
    ('Marché de Cocody', 'Banane plantain', 'kg de banane plantain', 'kg', 1, 500, 15),
    ('Marché de Cocody', 'Oignon', 'kg d''oignons', 'kg', 1, 800, 5),
    ('Marché de Cocody', 'Crudités', 'kg de crudités', 'kg', 1, 700, 5),
    ('Marché de Cocody', 'Attiéké', 'kg d''attiéké', 'kg', 1, 400, 20),
    ('Marché de Cocody', 'Manioc (placali)', 'kg de pâte de manioc (placali)', 'kg', 1, 450, 10),
    ('Marché de Cocody', 'Graine de palme', 'kg de graine de palme', 'kg', 1, 600, 10),
    ('Marché de Cocody', 'Feuilles kplala', 'kg de feuilles de kplala', 'kg', 1, 1000, 3),
    ('Marché de Cocody', 'Pomme de terre', 'kg de pommes de terre', 'kg', 1, 700, 20),
    ('Marché de Cocody', 'Œufs', 'plateaux de 30 œufs', 'plateau', 30, 2700, 3),
    ('Poissonnerie Port-Bouët', 'Poisson (carpe)', 'kg de carpe', 'kg', 1, 2500, 15),
    ('Poissonnerie Port-Bouët', 'Thon', 'kg de thon', 'kg', 1, 3000, 5)
  ) v(supplier, ingredient, label, unit, per, price, qty)
  join public.suppliers s on s.name = v.supplier
  left join public.ingredients i on i.name = v.ingredient
on conflict (supplier_id, label) do nothing;

-- Le chef corrige un prix habituel
create or replace function public.supplier_product_set_price(p_id uuid, p_price int) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not public.has_role('chef') then return public._fail('FORBIDDEN', 'Réservé à la cuisine.'); end if;
  if p_price is null or p_price <= 0 or p_price > 10000000 then return public._fail('INVALID', 'Prix invalide.'); end if;
  update supplier_products set usual_price = p_price where id = p_id;
  if not found then return public._fail('NOT_FOUND', 'Produit introuvable.'); end if;
  perform public._audit('supplier_price', p_id::text, jsonb_build_object('price', p_price));
  return jsonb_build_object('ok', true);
end $$;
revoke all on function public.supplier_product_set_price(uuid, int) from public, anon;
grant execute on function public.supplier_product_set_price(uuid, int) to authenticated;

create table if not exists public.supplier_orders (
  id            uuid primary key default gen_random_uuid(),
  supplier_id   uuid references public.suppliers (id),
  supplier_name text not null,
  call_phone    text not null,                 -- numéro appelé (en démo : le téléphone du présentateur)
  items         jsonb not null,                -- [{label, qty, unit, usual_price (par unité), ingredient_id?, stock_qty?}]
  budget        int not null,
  status        text not null default 'a_appeler' check (status in ('a_appeler', 'appel_en_cours', 'commande', 'a_valider',
                  'valide', 'injoignable', 'rappeler', 'coursier', 'refuse', 'annule')),
  quoted_total  int,
  quote_details text,
  delivery_at   text,
  delivery_mode text check (delivery_mode in ('fournisseur', 'coursier', 'retrait')),
  payment       text,
  unavailable   text[] not null default '{}',
  call_back_at  text,
  attempts      int not null default 0,
  call_id       text,
  call_mode     text check (call_mode in ('reel', 'simulation')),
  call_summary  text,
  recording_url text,
  run_id        uuid references public.delivery_runs (id),
  created_by    uuid references public.profiles (id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create table if not exists public.supply_events (
  id       bigint generated always as identity primary key,
  order_id uuid not null references public.supplier_orders (id) on delete cascade,
  at       timestamptz not null default now(),
  kind     text not null,
  message  text not null
);
create index if not exists supply_events_order on public.supply_events (order_id, id);
alter table public.supplier_orders enable row level security;
alter table public.supply_events enable row level security;
create policy "commandes fournisseurs : cuisine" on public.supplier_orders for select to authenticated using (public.has_role('chef'));
create policy "journal fournisseurs : cuisine" on public.supply_events for select to authenticated using (public.has_role('chef'));
grant select on public.supplier_orders, public.supply_events to authenticated;
grant all on public.supplier_orders, public.supply_events to service_role;

create or replace function public._supply_event(p_order uuid, p_kind text, p_msg text) returns void
language sql security definer set search_path = public, pg_temp as $$
  insert into supply_events (order_id, kind, message) values (p_order, p_kind, p_msg);
  update supplier_orders set updated_at = now() where id = p_order;
$$;

create or replace function public._fcfa(p int) returns text language sql immutable as $$
  select replace(to_char(p, 'FM999G999G999'), ',', ' ') || ' F'
$$;

create or replace function public._supply_items_text(p_items jsonb) returns text language sql immutable as $$
  select string_agg(public._fmt_qty((i ->> 'qty')::numeric) || ' ' || (i ->> 'label'), ', ') from jsonb_array_elements(p_items) i
$$;

-- Lignes d'une commande à partir du carnet : [{product_id, qty}] → items complets (prix habituel, stock)
create or replace function public._supply_lines(p_supplier uuid, p_lines jsonb) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object('product_id', p.id, 'label', p.label, 'qty', l.qty, 'unit', p.unit,
           'usual_price', p.usual_price, 'last_price', p.last_price, 'ingredient_id', p.ingredient_id,
           'stock_qty', round(l.qty * p.stock_per_unit, 2)) order by p.label), '[]')
    from (select (e ->> 'product_id')::uuid id, (e ->> 'qty')::numeric qty from jsonb_array_elements(p_lines) e where (e ->> 'qty')::numeric > 0) l
    join supplier_products p on p.id = l.id and p.supplier_id = p_supplier
$$;

create or replace function public._supply_new_order(p_supplier uuid, p_items jsonb, p_phone text, p_origin text) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare s public.suppliers; v_id uuid; v_budget int;
begin
  select * into s from suppliers where id = p_supplier;
  v_budget := (select sum((i ->> 'qty')::numeric * (i ->> 'usual_price')::numeric)::int from jsonb_array_elements(p_items) i);
  insert into supplier_orders (supplier_id, supplier_name, call_phone, items, budget, created_by)
  values (s.id, s.name, p_phone, p_items, v_budget, auth.uid()) returning id into v_id;
  perform public._supply_event(v_id, 'creation', '📝 ' || p_origin || ' chez ' || s.name || ' : ' || public._supply_items_text(p_items)
    || ' · budget ' || public._fcfa(v_budget) || ' (prix habituels).');
  return v_id;
end $$;
revoke all on function public._supply_lines(uuid, jsonb), public._supply_new_order(uuid, jsonb, text, text) from public, anon, authenticated;

create or replace function public._norm_phone(p text) returns text language sql immutable as $$
  select case when x ~ '^\+' then x when x <> '' then '+225' || x else '' end from (select regexp_replace(coalesce(p, ''), '[^0-9+]', '', 'g') x) z
$$;

-- Commande libre (chef) : un fournisseur, des produits du carnet, le numéro à appeler (sinon celui du fournisseur)
create or replace function public.supplier_order_create(p_supplier uuid, p_lines jsonb, p_phone text default null) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_items jsonb; v_phone text;
begin
  if not public.has_role('chef') then return public._fail('FORBIDDEN', 'Réservé à la cuisine.'); end if;
  v_items := public._supply_lines(p_supplier, p_lines);
  if jsonb_array_length(v_items) = 0 then return public._fail('EMPTY', 'Aucun produit choisi.'); end if;
  v_phone := public._norm_phone(coalesce(nullif(p_phone, ''), (select phone from suppliers where id = p_supplier)));
  if v_phone !~ '^\+[0-9]{8,15}$' then return public._fail('INVALID_PHONE', 'Numéro invalide (ex. +2250700000000).'); end if;
  return jsonb_build_object('ok', true, 'order_id', public._supply_new_order(p_supplier, v_items, v_phone, 'Commande à passer'));
end $$;
revoke all on function public.supplier_order_create(uuid, jsonb, text) from public, anon;
grant execute on function public.supplier_order_create(uuid, jsonb, text) to authenticated;

-- Commande de démo (chef) : quantités habituelles du carnet ; en démo on appelle le téléphone du présentateur
create or replace function public.supplier_order_create_demo(p_phone text, p_supplier text default 'Boucherie Bamba') returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare s public.suppliers; v_items jsonb; v_phone text := public._norm_phone(p_phone);
begin
  if not public.has_role('chef') then return public._fail('FORBIDDEN', 'Réservé à la cuisine.'); end if;
  if v_phone !~ '^\+[0-9]{8,15}$' then return public._fail('INVALID_PHONE', 'Numéro invalide (ex. +2250700000000).'); end if;
  select * into s from suppliers where name = p_supplier;
  if not found then return public._fail('NOT_FOUND', 'Fournisseur inconnu.'); end if;
  v_items := public._supply_lines(s.id, (select jsonb_agg(jsonb_build_object('product_id', id, 'qty', default_qty))
                                           from (select id, default_qty from supplier_products where supplier_id = s.id and is_preferred order by usual_price * default_qty desc limit 3) x));
  if jsonb_array_length(v_items) = 0 then return public._fail('EMPTY', 'Aucun produit dans le carnet pour ce fournisseur.'); end if;
  return jsonb_build_object('ok', true, 'order_id', public._supply_new_order(s.id, v_items, v_phone, 'Commande à passer'));
end $$;
revoke all on function public.supplier_order_create_demo(text, text) from public, anon;
grant execute on function public.supplier_order_create_demo(text, text) to authenticated;

-- Depuis le stock (chef) : ingrédients sous le seuil → une commande par fournisseur préféré, quantités arrondies au conditionnement
create or replace function public.supplier_orders_from_stock(p_phone text default null) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare r record; v_ids uuid[] := '{}'; v_phone text := public._norm_phone(p_phone);
begin
  if not public.has_role('chef') then return public._fail('FORBIDDEN', 'Réservé à la cuisine.'); end if;
  if v_phone <> '' and v_phone !~ '^\+[0-9]{8,15}$' then return public._fail('INVALID_PHONE', 'Numéro invalide.'); end if;
  for r in
    select p.supplier_id, jsonb_agg(jsonb_build_object('product_id', p.id,
             'qty', greatest(1, ceil((i.alert_threshold * 2 - i.stock_qty) / p.stock_per_unit)))) lines
      from ingredients i
      join lateral (select * from supplier_products sp where sp.ingredient_id = i.id and sp.is_preferred order by sp.usual_price / sp.stock_per_unit limit 1) p on true
     where i.stock_qty < i.alert_threshold
     group by p.supplier_id
  loop
    v_ids := v_ids || public._supply_new_order(r.supplier_id, public._supply_lines(r.supplier_id, r.lines),
                        coalesce(nullif(v_phone, ''), public._norm_phone((select phone from suppliers where id = r.supplier_id))), 'Stock bas : commande à passer');
  end loop;
  return jsonb_build_object('ok', true, 'orders', to_jsonb(v_ids), 'count', cardinality(v_ids));
end $$;
revoke all on function public.supplier_orders_from_stock(text) from public, anon;
grant execute on function public.supplier_orders_from_stock(text) to authenticated;

-- Début d'un appel (Edge Function)
create or replace function public._supplier_call_started(p_order uuid, p_call_id text, p_mode text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare o public.supplier_orders; v_cfg jsonb := public.setting('supplier_calls');
begin
  select * into o from supplier_orders where id = p_order for update;
  if not found then return public._fail('NOT_FOUND', 'Commande introuvable.'); end if;
  if o.status not in ('a_appeler', 'injoignable', 'rappeler', 'a_valider', 'valide') then return public._fail('ALREADY', 'Appel déjà terminé ou en cours.'); end if;
  if o.attempts >= coalesce((v_cfg ->> 'max_attempts')::int, 3) and o.status = 'injoignable' then return public._fail('MAX_ATTEMPTS', 'Trois essais sans réponse : passez au fournisseur de secours.'); end if;
  if (select count(*) from supplier_orders where call_mode = 'reel' and updated_at > now() - interval '1 day' and attempts > 0)
     >= coalesce((v_cfg ->> 'max_calls_per_day')::int, 30) and p_mode = 'reel' then
    return public._fail('DAILY_LIMIT', 'Plafond d''appels du jour atteint.');
  end if;
  update supplier_orders set status = 'appel_en_cours', attempts = attempts + 1, call_id = p_call_id, call_mode = p_mode where id = p_order;
  perform public._supply_event(p_order, 'appel', '📞 Appel en cours vers ' || o.supplier_name || case when p_mode = 'simulation' then ' (simulation)' else '' end
    || ' · essai ' || (o.attempts + 1) || '.');
  return jsonb_build_object('ok', true);
end $$;

/** Ce que dit le fournisseur pendant l'appel → décision de l'appli (renvoyée à l'agent vocal) */
create or replace function public._supplier_call_action(p_order uuid, p_action text, p_args jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare o public.supplier_orders; v_tol numeric := coalesce((public.setting('supplier_calls') ->> 'price_tolerance')::numeric, 0.10);
  v_total int; v_max int;
begin
  select * into o from supplier_orders where id = p_order for update;
  if not found then return jsonb_build_object('erreur', 'Commande introuvable.'); end if;
  v_max := floor(o.budget * (1 + v_tol));

  if p_action = 'record_quote' then
    v_total := round(coalesce((p_args ->> 'total')::numeric, 0));
    if v_total <= 0 then return jsonb_build_object('erreur', 'Total manquant : redemande le prix total.'); end if;
    update supplier_orders set quoted_total = v_total, quote_details = left(p_args ->> 'details', 500) where id = p_order;
    if v_total <= v_max then
      perform public._supply_event(p_order, 'prix', '💬 ' || o.supplier_name || ' propose ' || public._fcfa(v_total) || ' (budget ' || public._fcfa(o.budget) || ') : prix accepté.');
      return jsonb_build_object('decision', 'accepter', 'consigne', 'Le prix est accepté. Confirme la commande et demande quand il peut livrer.');
    end if;
    update supplier_orders set status = 'a_valider' where id = p_order;
    perform public._supply_event(p_order, 'a_valider', '⚠️ ' || o.supplier_name || ' propose ' || public._fcfa(v_total) || ' au lieu de ' || public._fcfa(o.budget)
      || ' (+' || round(100.0 * (v_total - o.budget) / o.budget) || ' %) → à valider par le chef.');
    perform public._notify_roles('{chef}', 'supply_validate', 'Prix à valider : ' || o.supplier_name,
      public._fcfa(v_total) || ' au lieu de ' || public._fcfa(o.budget), jsonb_build_object('href', '/admin/appels'));
    return jsonb_build_object('decision', 'verifier', 'consigne', 'Le prix dépasse le budget. Dis poliment que tu vérifies avec l''équipe et que tu rappelles très vite. Ne confirme rien.');

  elsif p_action = 'confirm_order' then
    if o.status = 'a_valider' then return jsonb_build_object('erreur', 'Prix pas encore validé par le chef : ne confirme pas.'); end if;
    if o.quoted_total is null then return jsonb_build_object('erreur', 'Demande d''abord le prix total (record_quote).'); end if;
    update supplier_orders set status = 'commande', delivery_at = left(p_args ->> 'delivery_at', 80),
           delivery_mode = case when p_args ->> 'delivery_mode' in ('fournisseur', 'coursier', 'retrait') then p_args ->> 'delivery_mode' else 'fournisseur' end,
           payment = left(coalesce(p_args ->> 'payment', 'Wave à la livraison'), 60) where id = p_order returning * into o;
    perform public._supply_event(p_order, 'commande', '✅ ' || o.supplier_name || ' : ' || public._supply_items_text(o.items) || ' = ' || public._fcfa(o.quoted_total)
      || coalesce(', livré ' || o.delivery_at, '') || ', paiement ' || o.payment || '.');
    -- Dernier prix payé au carnet (réparti au prorata des prix habituels) ; alerte si l'ensemble monte de plus de 15 %
    update supplier_products p set last_price = round((i ->> 'usual_price')::numeric * o.quoted_total / nullif(o.budget, 0)), last_price_at = now()
      from jsonb_array_elements(o.items) i where p.id = (i ->> 'product_id')::uuid;
    if o.quoted_total > o.budget * 1.15 then
      perform public._supply_event(p_order, 'alerte_prix', '📈 Les prix de ' || o.supplier_name || ' ont monté de ' || round(100.0 * (o.quoted_total - o.budget) / o.budget) || ' % : pensez à comparer avec un autre fournisseur.');
    end if;
    perform public._notify_roles('{chef}', 'supply_ordered', 'Commande passée : ' || o.supplier_name,
      public._fcfa(o.quoted_total) || coalesce(' · livré ' || o.delivery_at, ''), jsonb_build_object('href', '/admin/appels'));
    return jsonb_build_object('ok', true, 'consigne', 'Commande confirmée. Remercie le fournisseur, rappelle que le paiement se fait par ' || o.payment || ', puis raccroche.');

  elsif p_action = 'cannot_deliver' then
    update supplier_orders set status = 'coursier', delivery_mode = 'coursier' where id = p_order;
    perform public._supply_event(p_order, 'coursier', '🛵 ' || o.supplier_name || ' ne peut pas livrer' || coalesce(' (' || left(p_args ->> 'raison', 120) || ')', '')
      || ' → on envoie un coursier récupérer la commande.');
    return jsonb_build_object('ok', true, 'consigne', 'Dis que la cantine envoie un coursier récupérer la commande, demande que tout soit prêt, puis confirme le prix et raccroche.');

  elsif p_action = 'item_unavailable' then
    update supplier_orders set unavailable = array_append(unavailable, left(p_args ->> 'article', 80)) where id = p_order;
    perform public._supply_event(p_order, 'partiel', '❌ ' || o.supplier_name || ' n''a pas : ' || coalesce(p_args ->> 'article', '?') || ' → à commander ailleurs.');
    return jsonb_build_object('ok', true, 'consigne', 'Note-le et continue avec les autres articles.');

  elsif p_action = 'call_back_at' then
    update supplier_orders set status = 'rappeler', call_back_at = left(p_args ->> 'heure', 40) where id = p_order;
    perform public._supply_event(p_order, 'rappeler', '⏰ ' || o.supplier_name || ' demande de rappeler ' || coalesce(p_args ->> 'heure', 'plus tard') || '.');
    return jsonb_build_object('ok', true, 'consigne', 'Dis que tu rappelleras à cette heure-là, remercie et raccroche.');

  elsif p_action = 'refuse' then
    update supplier_orders set status = 'refuse' where id = p_order;
    perform public._supply_event(p_order, 'refuse', '🚫 ' || o.supplier_name || ' refuse la commande' || coalesce(' (' || left(p_args ->> 'raison', 120) || ')', '') || ' → fournisseur de secours.');
    return jsonb_build_object('ok', true, 'consigne', 'Remercie poliment et raccroche.');
  end if;
  return jsonb_build_object('erreur', 'Action inconnue.');
end $$;

-- Fin d'appel (webhook Retell ou simulation) : résumé, enregistrement ; sans résultat → injoignable
create or replace function public._supplier_call_ended(p_order uuid, p_summary text, p_recording text, p_reason text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare o public.supplier_orders;
begin
  select * into o from supplier_orders where id = p_order for update;
  if not found then return; end if;
  update supplier_orders set call_summary = coalesce(left(p_summary, 2000), call_summary), recording_url = coalesce(p_recording, recording_url) where id = p_order;
  if o.status = 'appel_en_cours' then
    update supplier_orders set status = 'injoignable' where id = p_order;
    perform public._supply_event(p_order, 'injoignable', '📵 ' || o.supplier_name || ' : appel sans résultat' || coalesce(' (' || p_reason || ')', '')
      || ' · essai ' || o.attempts || '/' || coalesce((public.setting('supplier_calls') ->> 'max_attempts')::int, 3) || '.');
  end if;
  if p_summary is not null then perform public._supply_event(p_order, 'resume', '📝 Résumé de l''appel : ' || left(p_summary, 600)); end if;
end $$;

revoke all on function public._supplier_call_started(uuid, text, text), public._supplier_call_action(uuid, text, jsonb),
  public._supplier_call_ended(uuid, text, text, text) from public, anon, authenticated;
grant execute on function public._supplier_call_started(uuid, text, text), public._supplier_call_action(uuid, text, jsonb),
  public._supplier_call_ended(uuid, text, text, text) to service_role;

-- Décision du chef sur un prix trop haut
create or replace function public.supplier_order_decide(p_order uuid, p_accept boolean) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare o public.supplier_orders;
begin
  if not public.has_role('chef') then return public._fail('FORBIDDEN', 'Réservé à la cuisine.'); end if;
  select * into o from supplier_orders where id = p_order for update;
  if not found or o.status <> 'a_valider' then return public._fail('INVALID_STATUS', 'Rien à valider.'); end if;
  update supplier_orders set status = case when p_accept then 'valide' else 'annule' end where id = p_order;
  perform public._supply_event(p_order, case when p_accept then 'valide' else 'annule' end,
    case when p_accept then '👍 ' || (select full_name from profiles where id = auth.uid()) || ' accepte ' || public._fcfa(o.quoted_total)
                           || ' chez ' || o.supplier_name || ' → rappeler le fournisseur pour confirmer.'
         else '👎 ' || (select full_name from profiles where id = auth.uid()) || ' refuse le prix de ' || o.supplier_name || ' → fournisseur de secours.' end);
  return jsonb_build_object('ok', true);
end $$;
revoke all on function public.supplier_order_decide(uuid, boolean) from public, anon;
grant execute on function public.supplier_order_decide(uuid, boolean) to authenticated;

-- Le fournisseur ne livre pas → tournée du coursier vers ce fournisseur (§20.6 a)
create or replace function public.supplier_order_send_courier(p_order uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare o public.supplier_orders; s public.suppliers; v_cfg jsonb := public.setting('delivery'); v_run uuid; v_stop uuid; i jsonb;
begin
  if not public.has_role('chef') then return public._fail('FORBIDDEN', 'Réservé à la cuisine.'); end if;
  select * into o from supplier_orders where id = p_order for update;
  if not found or o.status <> 'coursier' then return public._fail('INVALID_STATUS', 'Ce fournisseur livre lui-même ou la commande n''est pas passée.'); end if;
  if o.run_id is not null then return jsonb_build_object('ok', true, 'run_id', o.run_id); end if;
  select * into s from suppliers where id = o.supplier_id;
  insert into delivery_runs (title, courier_name, courier_phone, vehicle, created_by)
  values ('Récupération chez ' || o.supplier_name, v_cfg -> 'courier' ->> 'name', v_cfg -> 'courier' ->> 'phone', v_cfg -> 'courier' ->> 'vehicle', auth.uid())
  returning id into v_run;
  insert into delivery_stops (run_id, seq, supplier_id, name, district, phone, lat, lng)
  values (v_run, 1, s.id, s.name, s.district, s.phone, s.lat, s.lng) returning id into v_stop;
  for i in select * from jsonb_array_elements(o.items) loop
    insert into delivery_items (run_id, stop_id, ingredient_id, label, qty, stock_qty, emoji, price_expected)
    values (v_run, v_stop, nullif(i ->> 'ingredient_id', '')::uuid, i ->> 'label', (i ->> 'qty')::numeric, nullif(i ->> 'stock_qty', '')::numeric, '📦',
            round((i ->> 'qty')::numeric * (i ->> 'usual_price')::numeric * coalesce(o.quoted_total::numeric / nullif(o.budget, 0), 1)));
  end loop;
  update supplier_orders set run_id = v_run where id = p_order;
  perform public._delivery_event(v_run, 'creation', '📝 Récupération chez ' || o.supplier_name || ' (commande passée par téléphone) : ' || public._supply_items_text(o.items) || '.');
  perform public._supply_event(p_order, 'coursier', '🛵 Coursier commandé pour récupérer la marchandise chez ' || o.supplier_name || ' (page Livraisons).');
  return jsonb_build_object('ok', true, 'run_id', v_run);
end $$;
revoke all on function public.supplier_order_send_courier(uuid) from public, anon;
grant execute on function public.supplier_order_send_courier(uuid) to authenticated;

-- Réglage du numéro Retell qui passe les appels (admin) : ce n'est pas un secret
create or replace function public.supplier_calls_set_number(p_number text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v text := regexp_replace(coalesce(p_number, ''), '[^0-9+]', '', 'g');
begin
  if not public.has_role('admin') then return public._fail('FORBIDDEN', 'Réservé à l''administrateur.'); end if;
  if v <> '' and v !~ '^\+[0-9]{8,15}$' then return public._fail('INVALID_PHONE', 'Format international attendu, ex. +14155550123.'); end if;
  update settings set value = value || jsonb_build_object('from_number', nullif(v, '')) where key = 'supplier_calls';
  return jsonb_build_object('ok', true, 'from_number', nullif(v, ''));
end $$;
revoke all on function public.supplier_calls_set_number(text) from public, anon;
grant execute on function public.supplier_calls_set_number(text) to authenticated;

-- Étapes → groupe WhatsApp (si configuré)
create or replace function public._supply_dispatch() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_url text := public.setting('jean') ->> 'function_url';
begin
  if v_url is null or public.setting('jean') ->> 'group_id' is null or to_regproc('net.http_post') is null then return null; end if;
  perform net.http_post(url := v_url,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-jean-secret', public._jean_secret()),
    body := jsonb_build_object('supply_event_id', new.id));
  return null;
exception when others then return null;
end $$;
create or replace trigger supply_events_dispatch after insert on public.supply_events
  for each row execute function public._supply_dispatch();
