-- Règle d'annulation (décision du 20/11) :
--  · avant l'heure limite (1 h 30 avant le début du service, réglable) : annulation remboursée sur le compte ;
--  · après l'heure limite : annulation encore possible, mais SANS remboursement (l'élève confirme) ;
--    si la cuisine n'a pas commencé, le plat est remis en vente ;
--  · rappel 30 min avant l'heure limite (« tu manges toujours ? »), dans l'appli et sur WhatsApp ;
--  · commande non récupérée : rappel avant la fin du service (existant), puis perdue (existant).

alter table public.tickets add column if not exists cancel_reminded_at timestamptz;

drop function if exists public.cancel_ticket(uuid);
create or replace function public.cancel_ticket(p_ticket_id uuid, p_no_refund boolean default false) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := auth.uid();
  v_t public.tickets;
  v_deadline timestamptz;
  v_late boolean := false;
begin
  if v_uid is null then return public._fail('AUTH_REQUIRED', 'Connexion requise.'); end if;
  select * into v_t from public.tickets where id = p_ticket_id and v_uid in (user_id, buyer_id) for no key update;
  if not found then return public._fail('TICKET_NOT_FOUND', 'Ticket introuvable.'); end if;
  if v_t.status <> 'valid' or v_t.valid_until <= now() then
    return public._fail('NOT_CANCELLABLE', 'Ce ticket ne peut plus être annulé.');
  end if;

  if v_t.pickup_at is not null then
    v_deadline := public._order_cancel_deadline(v_t.pickup_at, v_t.service);
    v_late := now() > v_deadline;
    if v_late and not coalesce(p_no_refund, false) then
      return public._fail('NO_REFUND_CONFIRM',
        'L''heure limite (' || to_char(v_deadline at time zone 'Africa/Abidjan', 'HH24"h"MI')
        || ') est passée : tu peux encore annuler, mais tu ne seras pas remboursé. Annuler quand même ?',
        jsonb_build_object('deadline', v_deadline));
    end if;
    if not v_late and v_t.prep_status <> 'received' then
      return public._fail('NOT_CANCELLABLE', 'La cuisine prépare déjà votre commande : elle ne peut plus être annulée.');
    end if;
    -- Plat pas encore préparé : remis en vente
    if v_t.prep_status = 'received' then
      update public.menu_items set sold_qty = greatest(sold_qty - 1, 0) where id = v_t.menu_item_id;
    end if;
  end if;

  update public.tickets set status = 'cancelled', cancelled_at = now() where id = v_t.id;
  if v_late then
    perform public._audit('cancel_no_refund', v_t.id::text, jsonb_build_object('total', v_t.total, 'deadline', v_deadline));
    return jsonb_build_object('ok', true, 'refunded', 0, 'no_refund', true,
                              'balance', (select balance from public.wallets where user_id = v_uid));
  end if;
  if v_t.total > 0 then
    perform 1 from public.wallets where user_id = v_t.buyer_id for update;
    perform public._wallet_move(v_t.buyer_id, v_t.total, 'refund', p_ticket => v_t.id,
      p_note => case when v_t.pickup_at is not null then 'Annulation commande n° ' || v_t.order_no
                     else 'Annulation ticket ' || public.service_label(v_t.service) end);
  end if;
  if v_t.is_reward then
    update public.profiles set points = points + coalesce((public.setting('loyalty') ->> 'reward_points')::int, 10)
     where id = v_t.buyer_id;
  end if;
  return jsonb_build_object('ok', true, 'refunded', v_t.total,
                            'balance', (select balance from public.wallets where user_id = v_uid));
end $$;
revoke all on function public.cancel_ticket(uuid, boolean) from public, anon;
grant execute on function public.cancel_ticket(uuid, boolean) to authenticated;

-- Heure limite d'une commande (affichée sur le ticket)
create or replace function public.ticket_cancel_deadline(p_ticket_id uuid) returns timestamptz
language sql stable security definer set search_path = public, pg_temp as $$
  select public._order_cancel_deadline(t.pickup_at, t.service)
    from public.tickets t
   where t.id = p_ticket_id and auth.uid() in (t.user_id, t.buyer_id) and t.pickup_at is not null
$$;
revoke all on function public.ticket_cancel_deadline(uuid) from public, anon;
grant execute on function public.ticket_cancel_deadline(uuid) to authenticated;

-- Rappel 30 min avant l'heure limite : une notification par commande
create or replace function public.remind_cancel_deadlines() returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_n int;
begin
  with due as (
    update public.tickets t set cancel_reminded_at = now()
     where t.status = 'valid' and t.pickup_at is not null and t.cancel_reminded_at is null
       and t.prep_status = 'received'
       and public._order_cancel_deadline(t.pickup_at, t.service) > now()
       and public._order_cancel_deadline(t.pickup_at, t.service) <= now() + interval '30 minutes'
    returning t.id, t.user_id, t.order_no, t.pickup_at, t.service
  ), one as (
    select distinct on (user_id, order_no) * from due order by user_id, order_no, id
  )
  insert into public.notifications (user_id, type, title, body, data)
  select one.user_id, 'order_cancel_reminder', 'Tu manges toujours à la cantine ?',
         coalesce(public._order_summary(one.user_id, one.order_no, (one.pickup_at at time zone 'Africa/Abidjan')::date), 'Ta commande')
           || ' à ' || to_char(one.pickup_at at time zone 'Africa/Abidjan', 'HH24"h"MI')
           || '. Si tu ne viens pas, annule avant '
           || to_char(public._order_cancel_deadline(one.pickup_at, one.service) at time zone 'Africa/Abidjan', 'HH24"h"MI')
           || ' : tu seras remboursé. Après, plus de remboursement.',
         jsonb_build_object('ticket_id', one.id, 'href', '/app/tickets/' || one.id)
    from one;
  get diagnostics v_n = row_count;
  return v_n;
end $$;
revoke all on function public.remind_cancel_deadlines() from public, anon, authenticated;
grant execute on function public.remind_cancel_deadlines() to service_role;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('vatel-cancel-reminders', '* * * * *', 'select public.remind_cancel_deadlines()');
  end if;
end $$;

-- Le rappel part aussi sur WhatsApp (élèves dont le WhatsApp est lié à Jean)
create or replace function public._whatsapp_dispatch() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_url text := public.setting('jean') ->> 'function_url';
begin
  if v_url is null or to_regproc('net.http_post') is null then return null; end if;
  if new.type not in ('order_placed', 'order_preparing', 'order_ready', 'order_pickup_reminder', 'order_missed', 'menu_changed',
                      'voice_code', 'order_link', 'order_cancel_reminder',
                      'low_balance', 'child_low_balance', 'child_diet_alert', 'family_request', 'family_diet') then return null; end if;
  if not exists (select 1 from public.whatsapp_links where user_id = new.user_id) then return null; end if;
  perform net.http_post(
    url := v_url,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-jean-secret', public._jean_secret()),
    body := jsonb_build_object('notification_id', new.id));
  return null;
exception when others then
  return null;
end $$;
