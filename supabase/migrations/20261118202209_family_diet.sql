-- Exigences du guide « Cantine de Vatel » :
--  1. Régimes et allergies : chaque élève / employé déclare ses allergies et son régime ; les plats incompatibles
--     sont signalés (et peuvent être masqués) dans le menu, à la commande et par Jean.
--  2. Parent : il lie le compte de son enfant (l'enfant accepte), le recharge en ligne, suit ce qu'il mange,
--     et reçoit les alertes de solde bas de l'enfant.

-- ───────── 1. Régimes et allergies ─────────
alter table public.profiles add column if not exists allergies text[] not null default '{}';
alter table public.profiles add column if not exists diets text[] not null default '{}';   -- vegetarien, sans_porc
alter table public.dishes add column if not exists diet_tags text[] not null default '{}';  -- vegetarien, sans_porc

-- Étiquettes des plats existants (sans viande ni poisson = végétarien ; tout sauf le croque-monsieur est sans porc)
update public.dishes set diet_tags = array['sans_porc'] where name <> 'Croque-monsieur';
update public.dishes set diet_tags = array['vegetarien', 'sans_porc']
 where name in ('Bouillie de mil', 'Brownie', 'Crêpes sucrées', 'Omelette pain', 'Pain beurre & café au lait', 'Pain perdu', 'Salade composée', 'Spaghetti sautés');

create or replace function public.set_my_diet(p_allergies text[], p_diets text[]) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_ok_all text[] := array['arachide', 'gluten', 'lait', 'œuf', 'poisson', 'crustacés', 'moutarde', 'soja', 'fruits à coque', 'sésame'];
  v_ok_diet text[] := array['vegetarien', 'sans_porc'];
begin
  if auth.uid() is null then return public._fail('AUTH_REQUIRED', 'Connexion requise.'); end if;
  if not (coalesce(p_allergies, '{}') <@ v_ok_all) or not (coalesce(p_diets, '{}') <@ v_ok_diet) then
    return public._fail('INVALID', 'Allergie ou régime inconnu.');
  end if;
  update profiles set allergies = coalesce(p_allergies, '{}'), diets = coalesce(p_diets, '{}') where id = auth.uid();
  return jsonb_build_object('ok', true);
end $$;
revoke all on function public.set_my_diet(text[], text[]) from public, anon;
grant execute on function public.set_my_diet(text[], text[]) to authenticated;

/** Raisons pour lesquelles un plat ne convient pas à quelqu'un (vide = compatible) */
create or replace function public._diet_conflicts(p_allergies text[], p_diets text[], p_dish_allergens text[], p_dish_tags text[]) returns text[]
language sql immutable as $$
  select coalesce(array(select 'contient ' || a from unnest(p_allergies) a where a = any (coalesce(p_dish_allergens, '{}'))), '{}')
      || case when 'vegetarien' = any (p_diets) and not ('vegetarien' = any (coalesce(p_dish_tags, '{}'))) then array['pas végétarien'] else '{}' end
      || case when 'sans_porc' = any (p_diets) and not ('sans_porc' = any (coalesce(p_dish_tags, '{}'))) then array['contient du porc'] else '{}' end
$$;

-- ───────── 2. Parents ─────────
create table if not exists public.family_links (
  id         uuid primary key default gen_random_uuid(),
  parent_id  uuid not null references public.profiles (id) on delete cascade,
  child_id   uuid not null references public.profiles (id) on delete cascade,
  status     text not null default 'pending' check (status in ('pending', 'active')),
  created_at timestamptz not null default now(),
  accepted_at timestamptz,
  unique (parent_id, child_id),
  check (parent_id <> child_id)
);
alter table public.family_links enable row level security;
create policy "liens familiaux : les deux comptes" on public.family_links for select to authenticated
  using (parent_id = auth.uid() or child_id = auth.uid());
grant select on public.family_links to authenticated;
grant all on public.family_links to service_role;

-- Le parent demande à suivre un compte (code DB-xxxx) ; l'enfant doit accepter dans son appli
create or replace function public.family_request(p_child_code text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_me public.profiles; v_child public.profiles; v_id uuid;
begin
  if auth.uid() is null then return public._fail('AUTH_REQUIRED', 'Connexion requise.'); end if;
  select * into v_me from profiles where id = auth.uid();
  select * into v_child from profiles where short_code = upper(regexp_replace(coalesce(p_child_code, ''), '\s', '', 'g'));
  if not found or v_child.is_blocked or v_child.role <> 'client' then return public._fail('NOT_FOUND', 'Aucun élève avec ce code.'); end if;
  if v_child.id = v_me.id then return public._fail('SELF', 'C''est votre propre code.'); end if;
  if (select count(*) from family_links where parent_id = v_me.id) >= 6 then return public._fail('TOO_MANY', 'Six enfants au plus.'); end if;
  insert into family_links (parent_id, child_id) values (v_me.id, v_child.id)
  on conflict (parent_id, child_id) do update set created_at = family_links.created_at returning id into v_id;
  if (select status from family_links where id = v_id) = 'pending' then
    perform public._notify(v_child.id, 'family_request', v_me.full_name || ' veut suivre ton compte 👨‍👩‍👧',
      'Ton parent pourra recharger ton compte et voir tes repas. Accepte ou refuse dans ton profil.',
      jsonb_build_object('href', '/app/famille', 'link_id', v_id));
  end if;
  return jsonb_build_object('ok', true, 'link_id', v_id, 'child', v_child.full_name, 'status', (select status from family_links where id = v_id));
end $$;

create or replace function public.family_respond(p_link uuid, p_accept boolean) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare l public.family_links;
begin
  select * into l from family_links where id = p_link and child_id = auth.uid() for update;
  if not found then return public._fail('NOT_FOUND', 'Demande introuvable.'); end if;
  if p_accept then
    update family_links set status = 'active', accepted_at = now() where id = p_link;
    perform public._notify(l.parent_id, 'family_accepted', (select full_name from profiles where id = l.child_id) || ' a accepté ✅',
      'Vous pouvez maintenant recharger son compte et suivre ses repas.', jsonb_build_object('href', '/app/famille'));
  else
    delete from family_links where id = p_link;
  end if;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.family_unlink(p_link uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  delete from family_links where id = p_link and (parent_id = auth.uid() or child_id = auth.uid());
  if not found then return public._fail('NOT_FOUND', 'Lien introuvable.'); end if;
  return jsonb_build_object('ok', true);
end $$;

/** Vue d'ensemble pour l'enfant et le parent : demandes, enfants suivis (solde, repas récents), parents */
create or replace function public.family_overview() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_uid uuid := auth.uid(); v_low int := coalesce((public.setting('low_balance_threshold'))::int, 2000);
begin
  if v_uid is null then return public._fail('AUTH_REQUIRED', 'Connexion requise.'); end if;
  return jsonb_build_object('ok', true, 'low_threshold', v_low,
    'children', (select coalesce(jsonb_agg(jsonb_build_object('link_id', l.id, 'status', l.status, 'id', p.id, 'name', p.full_name, 'short_code', p.short_code,
        'balance', case when l.status = 'active' then w.balance end,
        'allergies', case when l.status = 'active' then p.allergies end, 'diets', case when l.status = 'active' then p.diets end,
        'meals', case when l.status = 'active' then (select coalesce(jsonb_agg(m order by m.at desc), '[]') from (
            select t.used_at at, t.service, coalesce(d.name, 'Repas ' || lower(public.service_label(t.service))) dish, t.total,
                   (select r.stars from ratings r where r.ticket_id = t.id) stars
              from tickets t left join dishes d on d.id = t.dish_id
             where t.user_id = p.id and t.status = 'used' and t.used_at > now() - interval '14 days'
             order by t.used_at desc limit 15) m) end,
        'spent_week', case when l.status = 'active' then (select coalesce(-sum(x.amount), 0) from transactions x where x.user_id = p.id and x.type = 'purchase' and x.created_at > now() - interval '7 days') end)
        order by p.full_name), '[]')
      from family_links l join profiles p on p.id = l.child_id left join wallets w on w.user_id = p.id where l.parent_id = v_uid),
    'parents', (select coalesce(jsonb_agg(jsonb_build_object('link_id', l.id, 'status', l.status, 'name', p.full_name) order by l.created_at), '[]')
      from family_links l join profiles p on p.id = l.parent_id where l.child_id = v_uid));
end $$;

-- Le parent recharge son enfant (Mobile Money simulé, comme la recharge personnelle)
create or replace function public.parent_recharge_child(p_child uuid, p_amount int) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_lim jsonb := public.setting('recharge_limits'); v_tx public.transactions; v_me text;
begin
  if not exists (select 1 from family_links where parent_id = auth.uid() and child_id = p_child and status = 'active') then
    return public._fail('FORBIDDEN', 'Ce compte n''est pas lié au vôtre.');
  end if;
  if p_amount is null or p_amount < (v_lim ->> 'min')::int or p_amount > (v_lim ->> 'max')::int then
    return public._fail('INVALID_AMOUNT', 'Montant entre ' || public.format_fcfa((v_lim ->> 'min')::int) || ' et ' || public.format_fcfa((v_lim ->> 'max')::int) || '.');
  end if;
  select full_name into v_me from profiles where id = auth.uid();
  perform 1 from wallets where user_id = p_child for update;
  v_tx := public._wallet_move(p_child, p_amount, 'recharge', p_note => 'Recharge par ' || v_me || ' (Mobile Money, simulation)', p_performed_by => auth.uid());
  perform public._notify(p_child, 'parent_recharge', v_me || ' a rechargé ton compte 💚',
    '+' || public.format_fcfa(p_amount) || ' · nouveau solde ' || public.format_fcfa(v_tx.balance_after) || '.', jsonb_build_object('href', '/app/historique'));
  perform public._audit('parent_recharge', p_child::text, jsonb_build_object('amount', p_amount));
  return jsonb_build_object('ok', true, 'balance', v_tx.balance_after);
end $$;

revoke all on function public.family_request(text), public.family_respond(uuid, boolean), public.family_unlink(uuid),
  public.family_overview(), public.parent_recharge_child(uuid, int) from public, anon;
grant execute on function public.family_request(text), public.family_respond(uuid, boolean), public.family_unlink(uuid),
  public.family_overview(), public.parent_recharge_child(uuid, int) to authenticated;

-- Alerte de solde bas de l'enfant → aussi chez ses parents
create or replace function public._family_low_balance() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.type = 'low_balance' then
    insert into notifications (user_id, type, title, body, data)
    select l.parent_id, 'child_low_balance', 'Solde bas : ' || p.full_name,
           p.full_name || ' n''a plus que ' || public.format_fcfa(coalesce((select balance from wallets where user_id = new.user_id), 0))
             || ' sur son compte cantine. Rechargez-le en un clic.',
           jsonb_build_object('href', '/app/famille', 'child_id', new.user_id)
      from family_links l join profiles p on p.id = l.child_id
     where l.child_id = new.user_id and l.status = 'active';
  end if;
  return null;
end $$;
create or replace trigger notifications_family_low_balance after insert on public.notifications
  for each row execute function public._family_low_balance();

