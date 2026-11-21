-- Les alertes famille partent aussi sur WhatsApp (en plus de l'appli et de la notification téléphone) :
-- solde bas (élève et parent), plat signalé commandé par l'enfant, demande de lien, allergies posées par le parent.
create or replace function public._whatsapp_dispatch() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_url text := public.setting('jean') ->> 'function_url';
begin
  if v_url is null or to_regproc('net.http_post') is null then return null; end if;
  if new.type not in ('order_placed', 'order_preparing', 'order_ready', 'order_pickup_reminder', 'order_missed', 'menu_changed',
                      'voice_code', 'order_link',
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
