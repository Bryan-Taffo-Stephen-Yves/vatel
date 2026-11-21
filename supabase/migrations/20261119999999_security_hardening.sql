-- Durcissement sécurité (retours de l'outil « Advisors » de Supabase)
-- 1. Les fonctions internes ne sont plus appelables depuis l'appli : seules les fonctions du serveur s'en servent.
-- 2. Les réglages techniques (WhatsApp, appels fournisseurs, livraison, notifications) ne sont lisibles que par l'équipe.
-- 3. Les petites fonctions de calcul ont un search_path fixe.

-- 1. Fonctions internes : plus d'accès direct pour les visiteurs ni pour les élèves connectés
revoke execute on function public._delivery_event(uuid, text, text, text) from public, anon, authenticated;
revoke execute on function public._supply_event(uuid, text, text) from public, anon, authenticated;
revoke execute on function public._order_summary(uuid, integer, date) from public, anon, authenticated;
revoke execute on function public._recompute_diet(uuid) from public, anon, authenticated;
revoke execute on function public._delivery_eta(uuid) from public, anon, authenticated;

-- Fonctions de déclencheur : elles tournent toutes seules, personne n'a besoin de les appeler
do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prosecdef and p.prorettype = 'trigger'::regtype
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', f.sig);
  end loop;
end $$;

-- 2. Réglages sensibles : lisibles seulement par l'équipe (l'admin passe partout)
create or replace function public._setting_is_private(p_key text) returns boolean
language sql immutable set search_path = public, pg_temp as $$
  select p_key in ('jean', 'supplier_calls', 'delivery', 'push_function_url')
$$;

drop policy if exists settings_read on public.settings;
create policy settings_read on public.settings for select to anon, authenticated
  using (not public._setting_is_private(key) or public.is_staff());

-- setting() s'exécute avec les droits de l'appelant : les fonctions du serveur (propriétaire) lisent tout,
-- un appel direct depuis l'appli passe par la règle ci-dessus et ne voit pas les réglages privés.
create or replace function public.setting(p_key text) returns jsonb
language sql stable security invoker set search_path = public, pg_temp as $$
  select value from public.settings where key = p_key
$$;

-- 3. search_path fixe sur les fonctions de calcul
alter function public._allergen_list() set search_path = public, pg_temp;
alter function public._complaint_label(text) set search_path = public, pg_temp;
alter function public._delivery_item_text(public.delivery_items) set search_path = public, pg_temp;
alter function public._diet_conflicts(text[], text[], text[], text[]) set search_path = public, pg_temp;
alter function public._fcfa(integer) set search_path = public, pg_temp;
alter function public._fmt_qty(numeric) set search_path = public, pg_temp;
alter function public._hm(timestamptz) set search_path = public, pg_temp;
alter function public._norm_phone(text) set search_path = public, pg_temp;
alter function public._num(numeric) set search_path = public, pg_temp;
alter function public._queue_wait_min(integer, integer) set search_path = public, pg_temp;
alter function public._severe_hits(text[], text[], text[]) set search_path = public, pg_temp;
alter function public._sing(numeric, text) set search_path = public, pg_temp;
alter function public._supply_items_text(jsonb) set search_path = public, pg_temp;
alter function public.fcfa(integer) set search_path = public, pg_temp;
