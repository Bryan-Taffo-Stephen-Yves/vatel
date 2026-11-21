-- 1) « 1 sac de riz » et pas « 1 sacs de riz » ; 2) prix accepté par le chef → le rappel peut confirmer à ce prix.
alter table public.supplier_orders add column if not exists validated_total int;

create or replace function public._sing(p_qty numeric, p_label text) returns text language sql immutable as $$
  select case when p_qty <= 1 then regexp_replace(regexp_replace(p_label, '^(\S+?)(eaux)(\s|$)', '\1eau\3'), '^(\S+?[^s])s(\s|$)', '\1\2') else p_label end
$$;

create or replace function public._supply_items_text(p_items jsonb) returns text language sql immutable as $$
  select string_agg(public._fmt_qty((i ->> 'qty')::numeric) || ' ' || public._sing((i ->> 'qty')::numeric, i ->> 'label'), ', ') from jsonb_array_elements(p_items) i
$$;

create or replace function public.supplier_order_decide(p_order uuid, p_accept boolean) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare o public.supplier_orders;
begin
  if not public.has_role('chef') then return public._fail('FORBIDDEN', 'Réservé à la cuisine.'); end if;
  select * into o from supplier_orders where id = p_order for update;
  if not found or o.status <> 'a_valider' then return public._fail('INVALID_STATUS', 'Rien à valider.'); end if;
  update supplier_orders set status = case when p_accept then 'valide' else 'annule' end,
         validated_total = case when p_accept then o.quoted_total end where id = p_order;
  perform public._supply_event(p_order, case when p_accept then 'valide' else 'annule' end,
    case when p_accept then '👍 ' || (select full_name from profiles where id = auth.uid()) || ' accepte ' || public._fcfa(o.quoted_total)
                           || ' chez ' || o.supplier_name || ' → rappeler le fournisseur pour confirmer.'
         else '👎 ' || (select full_name from profiles where id = auth.uid()) || ' refuse le prix de ' || o.supplier_name || ' → fournisseur de secours.' end);
  return jsonb_build_object('ok', true);
end $$;

-- record_quote accepte aussi un prix ≤ celui validé par le chef
create or replace function public._supplier_call_action(p_order uuid, p_action text, p_args jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare o public.supplier_orders; v_tol numeric := coalesce((public.setting('supplier_calls') ->> 'price_tolerance')::numeric, 0.10);
  v_total int; v_max int;
begin
  select * into o from supplier_orders where id = p_order for update;
  if not found then return jsonb_build_object('erreur', 'Commande introuvable.'); end if;
  v_max := greatest(floor(o.budget * (1 + v_tol))::int, coalesce(o.validated_total, 0));

  if p_action = 'record_quote' then
    v_total := round(coalesce((p_args ->> 'total')::numeric, 0));
    if v_total <= 0 then return jsonb_build_object('erreur', 'Total manquant : redemande le prix total.'); end if;
    update supplier_orders set quoted_total = v_total, quote_details = left(p_args ->> 'details', 500) where id = p_order;
    if v_total <= v_max then
      perform public._supply_event(p_order, 'prix', '💬 ' || o.supplier_name || ' propose ' || public._fcfa(v_total) || ' (budget ' || public._fcfa(o.budget) || ') : prix accepté'
        || case when o.validated_total is not null and v_total > floor(o.budget * (1 + v_tol)) then ' (validé par le chef)' else '' end || '.');
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
