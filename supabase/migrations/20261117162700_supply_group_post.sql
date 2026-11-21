-- Les étapes des appels fournisseurs partent dans le groupe via la fonction group-post
create or replace function public._supply_dispatch() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_url text := replace(public.setting('jean') ->> 'function_url', '/jean-whatsapp', '/group-post');
begin
  if v_url is null or public.setting('jean') ->> 'group_id' is null or new.kind = 'dialogue' or to_regproc('net.http_post') is null then return null; end if;
  perform net.http_post(url := v_url,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-jean-secret', public._jean_secret()),
    body := jsonb_build_object('supply_event_id', new.id));
  return null;
exception when others then return null;
end $$;
