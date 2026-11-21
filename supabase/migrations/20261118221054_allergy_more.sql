-- Allergies, suite : 14 allergènes officiels, allergies posées par le parent (verrouillées), alerte au parent,
-- étiquettes en cuisine et trous dans le menu (aucun plat compatible pour un groupe d'élèves).

alter table public.profiles add column if not exists parent_allergies text[] not null default '{}';
alter table public.profiles add column if not exists parent_severe text[] not null default '{}';
grant select (parent_allergies, parent_severe) on public.profiles to authenticated;

create or replace function public._allergen_list() returns text[] language sql immutable as $$
  select array['arachide', 'gluten', 'lait', 'œuf', 'poisson', 'crustacés', 'mollusques', 'fruits à coque', 'soja',
               'sésame', 'moutarde', 'céleri', 'sulfites', 'lupin']
$$;

-- L'élève ne peut pas retirer une allergie posée par son parent
create or replace function public.set_my_diet(p_allergies text[], p_diets text[]) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_ok_diet text[] := array['vegetarien', 'sans_porc', 'sans_piment'];
begin
  if auth.uid() is null then return public._fail('AUTH_REQUIRED', 'Connexion requise.'); end if;
  if not (coalesce(p_allergies, '{}') <@ public._allergen_list()) or not (coalesce(p_diets, '{}') <@ v_ok_diet) then
    return public._fail('INVALID', 'Allergie ou régime inconnu.');
  end if;
  update profiles set allergies = array(select distinct a from unnest(coalesce(p_allergies, '{}') || parent_allergies) a),
                      diets = coalesce(p_diets, '{}')
   where id = auth.uid();
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.set_my_severe_allergies(p_severe text[]) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null then return public._fail('AUTH_REQUIRED', 'Connexion requise.'); end if;
  update public.profiles set severe_allergies = array(select distinct a from unnest(coalesce(p_severe, '{}') || parent_severe) a where a = any (allergies))
   where id = auth.uid();
  return jsonb_build_object('ok', true);
end $$;

-- Parent (lien actif) : allergies de l'enfant, dont les graves ; l'enfant ne peut plus les retirer
create or replace function public.parent_set_child_diet(p_child uuid, p_allergies text[], p_severe text[]) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_p public.profiles; v_a text[] := coalesce(p_allergies, '{}'); v_s text[];
begin
  if auth.uid() is null then return public._fail('AUTH_REQUIRED', 'Connexion requise.'); end if;
  if not exists (select 1 from family_links where parent_id = auth.uid() and child_id = p_child and status = 'active') then
    return public._fail('FORBIDDEN', 'Votre enfant doit d''abord accepter le lien.');
  end if;
  if not (v_a <@ public._allergen_list()) then return public._fail('INVALID', 'Allergie inconnue.'); end if;
  v_s := array(select distinct a from unnest(coalesce(p_severe, '{}')) a where a = any (v_a));
  select * into v_p from profiles where id = p_child for update;
  update profiles set
      allergies = array(select distinct a from unnest(array(select x from unnest(allergies) x where not x = any (v_p.parent_allergies)) || v_a) a),
      severe_allergies = array(select distinct a from unnest(array(select x from unnest(severe_allergies) x where not x = any (v_p.parent_severe)) || v_s) a),
      parent_allergies = v_a, parent_severe = v_s
   where id = p_child;
  insert into notifications (user_id, type, title, body, data)
  values (p_child, 'family_diet', 'Allergies mises à jour par ton parent',
          case when cardinality(v_a) = 0 then 'Ton parent a retiré les allergies qu''il avait indiquées.'
               else 'Allergies : ' || array_to_string(v_a, ', ') || coalesce(' (graves : ' || nullif(array_to_string(v_s, ', '), '') || ')', '') || '. Les plats concernés sont signalés ou bloqués.' end,
          jsonb_build_object('href', '/app/profil#regime'));
  return (select jsonb_build_object('ok', true, 'allergies', allergies, 'severe', severe_allergies, 'parent_allergies', parent_allergies, 'parent_severe', parent_severe)
            from profiles where id = p_child);
end $$;

create or replace function public.family_child_diet(p_child uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not exists (select 1 from family_links where parent_id = auth.uid() and child_id = p_child and status = 'active') then
    return public._fail('FORBIDDEN', 'Lien non actif.');
  end if;
  return (select jsonb_build_object('ok', true, 'allergies', allergies, 'severe', severe_allergies, 'diets', diets,
                                    'parent_allergies', parent_allergies, 'parent_severe', parent_severe)
            from profiles where id = p_child);
end $$;

-- Commande d'un plat signalé (allergie non grave, régime) : le parent est prévenu (une fois par commande)
create or replace function public._child_diet_alert() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_p profiles; v_d dishes; v_r text[];
begin
  if new.pickup_at is null or new.menu_item_id is null then return null; end if;
  select * into v_p from profiles where id = new.user_id;
  if cardinality(v_p.allergies) = 0 and cardinality(v_p.diets) = 0 then return null; end if;
  if not exists (select 1 from family_links where child_id = new.user_id and status = 'active') then return null; end if;
  select d.* into v_d from menu_items mi join dishes d on d.id = mi.dish_id where mi.id = new.menu_item_id;
  v_r := public._diet_conflicts(v_p.allergies, v_p.diets, v_d.allergens, v_d.diet_tags)
         || coalesce(array(select 'traces de ' || a from unnest(v_d.traces) a where a = any (v_p.allergies) and not a = any (v_d.allergens)), '{}');
  if cardinality(v_r) = 0 then return null; end if;
  if exists (select 1 from notifications n where n.type = 'child_diet_alert' and n.data ->> 'child_id' = new.user_id::text
               and n.data ->> 'order_no' = new.order_no::text and n.created_at > now() - interval '1 day') then return null; end if;
  insert into notifications (user_id, type, title, body, data)
  select l.parent_id, 'child_diet_alert', '⚠️ ' || split_part(v_p.full_name, ' ', 1) || ' a commandé un plat signalé',
         v_d.name || ' : ' || array_to_string(v_r, ', ') || '. Retrait à ' || to_char(new.pickup_at at time zone 'Africa/Abidjan', 'HH24"h"MI') || '.',
         jsonb_build_object('href', '/app/famille', 'child_id', new.user_id, 'order_no', new.order_no)
    from family_links l where l.child_id = new.user_id and l.status = 'active';
  return null;
end $$;
create or replace trigger tickets_child_diet_alert after insert on public.tickets
  for each row execute function public._child_diet_alert();

-- Cuisine : allergies et régime des clients qui ont commandé ce jour (user_id → étiquettes)
create or replace function public.kitchen_diet_flags(p_date date) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not public.has_role('chef') then return public._fail('FORBIDDEN', 'Réservé à la cuisine.'); end if;
  return jsonb_build_object('ok', true, 'clients', coalesce((
    select jsonb_object_agg(p.id, jsonb_build_object('allergies', p.allergies, 'severe', p.severe_allergies, 'diets', p.diets))
      from profiles p
     where (cardinality(p.allergies) > 0 or cardinality(p.diets) > 0)
       and exists (select 1 from tickets t where t.user_id = p.id and t.pickup_at is not null
                     and (t.pickup_at at time zone 'Africa/Abidjan')::date = p_date)), '{}'::jsonb));
end $$;

-- Production : pour chaque repas du jour, groupes d'élèves sans AUCUN plat compatible
create or replace function public.production_diet_gaps(p_date date) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not public.has_role('chef') then return public._fail('FORBIDDEN', 'Réservé à la cuisine.'); end if;
  return jsonb_build_object('ok', true, 'gaps', coalesce((
    with items as (
      select mi.service, d.allergens, d.traces, d.diet_tags
        from menu_items mi join menus m on m.id = mi.menu_id and m.status = 'published' join dishes d on d.id = mi.dish_id
       where mi.service_date = p_date),
    svc as (select distinct service from items),
    need as (
      select 'allergie ' || a as label, a as allergen, null::text as diet, count(*) as n
        from profiles p, unnest(p.allergies) a where p.role = 'client' and not p.is_blocked group by a
      union all
      select case d when 'vegetarien' then 'végétariens' when 'sans_porc' then 'sans porc' else 'pas pimenté' end, null, d, count(*)
        from profiles p, unnest(p.diets) d where p.role = 'client' and not p.is_blocked group by d)
    select jsonb_agg(jsonb_build_object('service', s.service, 'label', public.service_label(s.service), 'who', n.label, 'students', n.n)
                     order by s.service, n.n desc)
      from svc s cross join need n
     where not exists (
       select 1 from items i where i.service = s.service
          and (n.allergen is null or not (n.allergen = any (coalesce(i.allergens, '{}') || coalesce(i.traces, '{}'))))
          and (n.diet is null
               or (n.diet = 'vegetarien' and 'vegetarien' = any (i.diet_tags))
               or (n.diet = 'sans_porc' and 'sans_porc' = any (i.diet_tags))
               or (n.diet = 'sans_piment' and not ('pimente' = any (i.diet_tags)))))), '[]'::jsonb));
end $$;

revoke all on function public.parent_set_child_diet(uuid, text[], text[]), public.family_child_diet(uuid),
  public.kitchen_diet_flags(date), public.production_diet_gaps(date) from public, anon;
grant execute on function public.parent_set_child_diet(uuid, text[], text[]), public.family_child_diet(uuid),
  public.kitchen_diet_flags(date), public.production_diet_gaps(date) to authenticated;
grant execute on function public._allergen_list() to authenticated, service_role;
