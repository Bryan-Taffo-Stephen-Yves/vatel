-- Lien de confirmation : détail lisible d'une demande de commande (plats en quantité, suppléments, total)
create or replace function public.order_request_view(p_token text) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_r public.order_requests; v_items jsonb; v_extras jsonb;
begin
  if auth.uid() is null then return public._fail('AUTH_REQUIRED', 'Connexion requise.'); end if;
  select * into v_r from public.order_requests where token = p_token;
  if not found or v_r.user_id <> auth.uid() then return public._fail('NOT_FOUND', 'Demande introuvable sur ce compte.'); end if;
  v_items := coalesce(v_r.items, jsonb_build_array(jsonb_build_object('menu_item_id', v_r.menu_item_id, 'qty', 1)));
  v_extras := case when v_r.items is not null then v_r.extras
                   else (select coalesce(jsonb_agg(jsonb_build_object('extra_id', e, 'qty', 1)), '[]') from unnest(v_r.extra_ids) e) end;
  return jsonb_build_object('ok', true, 'status', v_r.status, 'pickup_at', v_r.pickup_at, 'expires_at', v_r.expires_at,
    'ticket_id', v_r.ticket_id, 'source', v_r.source,
    'lines', (select coalesce(jsonb_agg(jsonb_build_object('name', d.name, 'photo_url', d.photo_url, 'qty', (e ->> 'qty')::int, 'price', mi.price)), '[]')
                from jsonb_array_elements(v_items) e join public.menu_items mi on mi.id = (e ->> 'menu_item_id')::uuid
                join public.dishes d on d.id = mi.dish_id),
    'extras', (select coalesce(jsonb_agg(jsonb_build_object('name', x.name, 'qty', (e ->> 'qty')::int, 'price', x.price)), '[]')
                 from jsonb_array_elements(v_extras) e join public.extras x on x.id = (e ->> 'extra_id')::uuid));
end $$;
revoke all on function public.order_request_view(text) from public, anon;
grant execute on function public.order_request_view(text) to authenticated;
