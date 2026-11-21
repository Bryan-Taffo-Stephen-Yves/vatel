-- « Je ne mange pas fort » : préférence « pas pimenté » et étiquette « pimenté » sur les plats.
update public.dishes set diet_tags = array(select distinct unnest(diet_tags || array['pimente']))
 where name in ('Garba', 'Alloco poulet braisé', 'Attiéké poisson braisé', 'Placali sauce kplala', 'Foutou banane sauce graine', 'Riz sauce graine', 'Poulet frites');

create or replace function public._diet_conflicts(p_allergies text[], p_diets text[], p_dish_allergens text[], p_dish_tags text[]) returns text[]
language sql immutable as $$
  select coalesce(array(select 'contient ' || a from unnest(p_allergies) a where a = any (coalesce(p_dish_allergens, '{}'))), '{}')
      || case when 'vegetarien' = any (p_diets) and not ('vegetarien' = any (coalesce(p_dish_tags, '{}'))) then array['pas végétarien'] else '{}' end
      || case when 'sans_porc' = any (p_diets) and not ('sans_porc' = any (coalesce(p_dish_tags, '{}'))) then array['contient du porc'] else '{}' end
      || case when 'sans_piment' = any (p_diets) and 'pimente' = any (coalesce(p_dish_tags, '{}')) then array['pimenté (demande-le sans piment)'] else '{}' end
$$;

create or replace function public.set_my_diet(p_allergies text[], p_diets text[]) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_ok_all text[] := array['arachide', 'gluten', 'lait', 'œuf', 'poisson', 'crustacés', 'moutarde', 'soja', 'fruits à coque', 'sésame'];
  v_ok_diet text[] := array['vegetarien', 'sans_porc', 'sans_piment'];
begin
  if auth.uid() is null then return public._fail('AUTH_REQUIRED', 'Connexion requise.'); end if;
  if not (coalesce(p_allergies, '{}') <@ v_ok_all) or not (coalesce(p_diets, '{}') <@ v_ok_diet) then
    return public._fail('INVALID', 'Allergie ou régime inconnu.');
  end if;
  update profiles set allergies = coalesce(p_allergies, '{}'), diets = coalesce(p_diets, '{}') where id = auth.uid();
  return jsonb_build_object('ok', true);
end $$;
