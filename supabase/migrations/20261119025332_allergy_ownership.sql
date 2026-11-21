-- Allergies : qui a déclaré quoi. L'élève garde SES allergies (self_*), chaque parent les siennes (sur son lien).
-- Le profil affiche l'union. Un parent ne peut plus effacer l'allergie déclarée par l'élève ni celle posée par l'autre parent.
alter table public.profiles add column if not exists self_allergies text[] not null default '{}';
alter table public.profiles add column if not exists self_severe text[] not null default '{}';
update public.profiles set self_allergies = array(select a from unnest(allergies) a where not a = any (parent_allergies)),
                           self_severe = array(select a from unnest(severe_allergies) a where not a = any (parent_severe));
alter table public.family_links add column if not exists allergies text[] not null default '{}';
alter table public.family_links add column if not exists severe text[] not null default '{}';

-- Recalcule les allergies affichées d'un élève : les siennes + celles de ses parents liés (actifs)
create or replace function public._recompute_diet(p_user uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_pa text[]; v_ps text[]; v_self text[]; v_ss text[];
begin
  select coalesce(array_agg(distinct a order by a), '{}') into v_pa from family_links l, unnest(l.allergies) a where l.child_id = p_user and l.status = 'active';
  select coalesce(array_agg(distinct a order by a), '{}') into v_ps from family_links l, unnest(l.severe) a where l.child_id = p_user and l.status = 'active';
  select self_allergies, self_severe into v_self, v_ss from profiles where id = p_user;
  update profiles set parent_allergies = v_pa, parent_severe = v_ps,
         allergies = array(select distinct a from unnest(coalesce(v_self, '{}') || v_pa) a order by 1),
         severe_allergies = array(select distinct a from unnest(coalesce(v_ss, '{}') || v_ps) a order by 1)
   where id = p_user;
end $$;

create or replace function public._family_links_diet() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform public._recompute_diet(coalesce(new.child_id, old.child_id));
  return null;
end $$;
create or replace trigger family_links_diet after insert or update of status, allergies, severe or delete on public.family_links
  for each row execute function public._family_links_diet();

create or replace function public.set_my_diet(p_allergies text[], p_diets text[]) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_ok_diet text[] := array['vegetarien', 'sans_porc', 'sans_piment'];
begin
  if auth.uid() is null then return public._fail('AUTH_REQUIRED', 'Connexion requise.'); end if;
  if not (coalesce(p_allergies, '{}') <@ public._allergen_list()) or not (coalesce(p_diets, '{}') <@ v_ok_diet) then
    return public._fail('INVALID', 'Allergie ou régime inconnu.');
  end if;
  update profiles set self_allergies = array(select distinct a from unnest(coalesce(p_allergies, '{}')) a order by 1),
                      self_severe = array(select a from unnest(self_severe) a where a = any (coalesce(p_allergies, '{}'))),
                      diets = coalesce(p_diets, '{}')
   where id = auth.uid();
  perform public._recompute_diet(auth.uid());
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.set_my_severe_allergies(p_severe text[]) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null then return public._fail('AUTH_REQUIRED', 'Connexion requise.'); end if;
  update public.profiles set self_severe = array(select distinct a from unnest(coalesce(p_severe, '{}')) a where a = any (allergies))
   where id = auth.uid();
  perform public._recompute_diet(auth.uid());
  return jsonb_build_object('ok', true);
end $$;

-- Le parent ne gère QUE ses propres allergies (sur son lien)
create or replace function public.parent_set_child_diet(p_child uuid, p_allergies text[], p_severe text[]) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_a text[] := array(select distinct a from unnest(coalesce(p_allergies, '{}')) a order by 1); v_s text[];
begin
  if auth.uid() is null then return public._fail('AUTH_REQUIRED', 'Connexion requise.'); end if;
  if not exists (select 1 from family_links where parent_id = auth.uid() and child_id = p_child and status = 'active') then
    return public._fail('FORBIDDEN', 'Votre enfant doit d''abord accepter le lien.');
  end if;
  if not (v_a <@ public._allergen_list()) then return public._fail('INVALID', 'Allergie inconnue.'); end if;
  v_s := array(select distinct a from unnest(coalesce(p_severe, '{}')) a where a = any (v_a) order by 1);
  update family_links set allergies = v_a, severe = v_s where parent_id = auth.uid() and child_id = p_child; -- le trigger recalcule le profil
  insert into notifications (user_id, type, title, body, data)
  values (p_child, 'family_diet', 'Allergies mises à jour par ton parent',
          case when cardinality(v_a) = 0 then 'Ton parent a retiré les allergies qu''il avait indiquées (les tiennes restent).'
               else 'Allergies : ' || array_to_string(v_a, ', ') || coalesce(' (graves : ' || nullif(array_to_string(v_s, ', '), '') || ')', '') || '. Les plats concernés sont signalés ou bloqués.' end,
          jsonb_build_object('href', '/app/profil#regime'));
  return (select jsonb_build_object('ok', true, 'allergies', allergies, 'severe', severe_allergies, 'parent_allergies', v_a, 'parent_severe', v_s)
            from profiles where id = p_child);
end $$;

-- Ce que voit le parent : les allergies de l'enfant (toutes) et celles qu'il a posées LUI
create or replace function public.family_child_diet(p_child uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare l family_links;
begin
  select * into l from family_links where parent_id = auth.uid() and child_id = p_child and status = 'active';
  if not found then return public._fail('FORBIDDEN', 'Lien non actif.'); end if;
  return (select jsonb_build_object('ok', true, 'allergies', allergies, 'severe', severe_allergies, 'diets', diets,
                                    'parent_allergies', l.allergies, 'parent_severe', l.severe)
            from profiles where id = p_child);
end $$;

-- Alerte au parent : UNE notification par commande, qui liste tous les plats signalés du panier
create or replace function public._child_diet_alert() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_p profiles; v_d dishes; v_r text[]; v_n notifications; v_items jsonb; v_line text;
begin
  if new.pickup_at is null or new.menu_item_id is null then return null; end if;
  select * into v_p from profiles where id = new.user_id;
  if cardinality(v_p.allergies) = 0 and cardinality(v_p.diets) = 0 then return null; end if;
  if not exists (select 1 from family_links where child_id = new.user_id and status = 'active') then return null; end if;
  select d.* into v_d from menu_items mi join dishes d on d.id = mi.dish_id where mi.id = new.menu_item_id;
  v_r := public._diet_conflicts(v_p.allergies, v_p.diets, v_d.allergens, v_d.diet_tags)
         || coalesce(array(select 'traces de ' || a from unnest(v_d.traces) a where a = any (v_p.allergies) and not a = any (v_d.allergens)), '{}');
  if cardinality(v_r) = 0 then return null; end if;
  v_line := v_d.name || ' : ' || array_to_string(v_r, ', ');
  for v_n in select * from notifications n where n.type = 'child_diet_alert' and n.data ->> 'child_id' = new.user_id::text
               and n.data ->> 'order_no' = new.order_no::text and n.created_at > now() - interval '1 day' loop
    -- Même commande : on ajoute le plat au message existant (lu au moment de l'envoi, après la commande)
    v_items := coalesce(v_n.data -> 'items', '[]'::jsonb);
    if not v_items ? v_line then
      v_items := v_items || to_jsonb(v_line);
      update notifications set data = data || jsonb_build_object('items', v_items),
             body = (select string_agg(x, ' · ') from jsonb_array_elements_text(v_items) x)
                    || '. Retrait à ' || to_char(new.pickup_at at time zone 'Africa/Abidjan', 'HH24"h"MI') || '.'
       where id = v_n.id;
    end if;
  end loop;
  if found then return null; end if;
  insert into notifications (user_id, type, title, body, data)
  select l.parent_id, 'child_diet_alert', '⚠️ ' || split_part(v_p.full_name, ' ', 1) || ' a commandé un plat signalé',
         v_line || '. Retrait à ' || to_char(new.pickup_at at time zone 'Africa/Abidjan', 'HH24"h"MI') || '.',
         jsonb_build_object('href', '/app/famille', 'child_id', new.user_id, 'order_no', new.order_no, 'items', jsonb_build_array(v_line))
    from family_links l where l.child_id = new.user_id and l.status = 'active';
  return null;
end $$;

-- Comptoir : la raison « contient X » d'une allergie grave n'est pas répétée (déjà dans « severe »)
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
    'order_risks', coalesce((
      select jsonb_agg(jsonb_build_object('dish', d.name,
               'severe', public._severe_hits(v_p.severe_allergies, d.allergens, d.traces),
               'reasons', array(select r from unnest(public._diet_conflicts(v_p.allergies, v_p.diets, d.allergens, d.diet_tags)) r
                                 where not r = any (array(select 'contient ' || s from unnest(v_p.severe_allergies) s)))
                          || coalesce(array(select 'traces de ' || a from unnest(d.traces) a where a = any (v_p.allergies) and not a = any (d.allergens) and not a = any (v_p.severe_allergies)), '{}')))
        from public.tickets t join public.menu_items mi on mi.id = t.menu_item_id join public.dishes d on d.id = mi.dish_id
       where t.user_id = v_t.user_id and t.order_no = v_t.order_no and t.pickup_at is not null and v_t.pickup_at is not null
         and (t.pickup_at at time zone 'Africa/Abidjan')::date = (v_t.pickup_at at time zone 'Africa/Abidjan')::date
         and (cardinality(public._severe_hits(v_p.severe_allergies, d.allergens, d.traces)) > 0
              or cardinality(public._diet_conflicts(v_p.allergies, v_p.diets, d.allergens, d.diet_tags)) > 0
              or exists (select 1 from unnest(d.traces) a where a = any (v_p.allergies)))), '[]'),
    'dish_risks', coalesce((
      select jsonb_object_agg(mi.id, jsonb_build_object('severe', public._severe_hits(v_p.severe_allergies, d.allergens, d.traces),
               'reasons', public._diet_conflicts(v_p.allergies, v_p.diets, d.allergens, d.diet_tags)
                          || coalesce(array(select 'traces de ' || a from unnest(d.traces) a where a = any (v_p.allergies) and not a = any (d.allergens)), '{}')))
        from public.menu_items mi join public.menus m on m.id = mi.menu_id and m.status = 'published' join public.dishes d on d.id = mi.dish_id
       where mi.service_date = coalesce(v_t.service_date, public.today_abidjan()) and mi.service = v_t.service
         and (cardinality(public._diet_conflicts(v_p.allergies, v_p.diets, d.allergens, d.diet_tags)) > 0
              or exists (select 1 from unnest(d.traces) a where a = any (v_p.allergies)))), '{}'::jsonb));
end $$;
