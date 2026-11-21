-- Point des achats envoyé au chef et à l'admin (décision de Bryan, 21/11) : plus d'appels aux fournisseurs par l'IA ;
-- l'appli calcule la liste (prévisions des 3 prochains jours, stock, frais acheté seulement pour ses jours de
-- conservation) et l'envoie ; le chef ou l'admin fait les courses lui-même (page Courses → /courses sur le téléphone).
--  · chaque jour à l'heure réglée (15h00 par défaut), une seule fois, s'il y a quelque chose à acheter ;
--  · bouton « Envoyer le point maintenant » sur la page Courses (shopping_brief_send) ;
--  · notification dans l'appli + push (déclencheur existant) au chef et à l'admin, lien vers la page Courses.

insert into public.settings (key, value) values ('shopping_brief', '{"enabled": true, "time": "15:00", "last_sent_on": null}')
on conflict (key) do nothing;

create or replace function public._shopping_brief(p_force boolean default false) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_cfg jsonb := coalesce(public.setting('shopping_brief'), '{}');
  v_today text := public.today_abidjan()::text;
  v_now text := to_char(now() at time zone 'Africa/Abidjan', 'HH24:MI');
  v_list uuid; v_code text; v_n int; v_total int; v_top text; v_fresh int;
begin
  if not p_force then
    if not coalesce((v_cfg ->> 'enabled')::boolean, true) then return jsonb_build_object('ok', true, 'sent', false, 'why', 'disabled'); end if;
    if v_cfg ->> 'last_sent_on' = v_today then return jsonb_build_object('ok', true, 'sent', false, 'why', 'already_sent'); end if;
    if v_now < coalesce(v_cfg ->> 'time', '15:00') then return jsonb_build_object('ok', true, 'sent', false, 'why', 'too_early'); end if;
  end if;

  perform public._shopping_refresh();
  v_list := public._shopping_open();
  select 'C-' || lpad(num::text, 4, '0') into v_code from shopping_lists where id = v_list;
  select count(*), coalesce(sum(est_cost), 0)::int,
         count(*) filter (where i.shelf_life_days is not null)
    into v_n, v_total, v_fresh
    from shopping_items si left join ingredients i on i.id = si.ingredient_id
   where si.list_id = v_list and si.status = 'todo';

  if v_n = 0 then
    if not p_force then
      update settings set value = value || jsonb_build_object('last_sent_on', v_today) where key = 'shopping_brief';
    end if;
    return jsonb_build_object('ok', true, 'sent', false, 'why', 'nothing', 'items', 0);
  end if;

  select string_agg(public._num(si.qty) || ' ' || si.unit || ' ' || si.label, ', ' order by si.est_cost desc)
    into v_top
    from (select * from shopping_items where list_id = v_list and status = 'todo' order by est_cost desc limit 5) si;

  perform public._notify_roles('{chef,admin}', 'shopping_brief',
    '🛒 Courses à faire : ' || v_n || ' article' || case when v_n > 1 then 's' else '' end || ' · ~' || public.fcfa(v_total),
    'Calculé d''après les prévisions des 3 prochains jours'
      || case when v_fresh > 0 then ' (' || v_fresh || ' produit' || case when v_fresh > 1 then 's frais achetés' else ' frais acheté' end || ' juste pour leurs jours)' else '' end
      || '. ' || v_top || case when v_n > 5 then '…' else '.' end,
    jsonb_build_object('href', '/admin/courses', 'list', v_code));

  if not p_force then
    update settings set value = value || jsonb_build_object('last_sent_on', v_today) where key = 'shopping_brief';
  end if;
  return jsonb_build_object('ok', true, 'sent', true, 'items', v_n, 'total', v_total, 'list', v_code);
end $$;

-- « Envoyer le point maintenant » (page Courses)
create or replace function public.shopping_brief_send() returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare r jsonb;
begin
  if not public.has_role('chef') then return public._fail('FORBIDDEN', 'Réservé à la cuisine et à l''administration.'); end if;
  r := public._shopping_brief(true);
  if not (r ->> 'sent')::boolean then return public._fail('NOTHING', 'Rien à acheter pour l''instant : pas de point à envoyer.'); end if;
  perform public._audit('shopping_brief', r ->> 'list', r);
  return r;
end $$;

revoke all on function public._shopping_brief(boolean) from public, anon, authenticated;
grant execute on function public._shopping_brief(boolean) to service_role;
revoke all on function public.shopping_brief_send() from public, anon;
grant execute on function public.shopping_brief_send() to authenticated;

-- Tâche planifiée : vérifie toutes les 15 min si l'heure du point est passée (envoi une fois par jour)
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('vatel-shopping-brief', '*/15 * * * *', 'select public._shopping_brief()');
  end if;
end $$;
