-- Comptes parents sécurisés (demande de Bryan, 21/11) : un élève ne peut pas se faire « parrainer » par un ami.
--  1. Deux sortes de comptes : élève ou parent (choisi à l'inscription) ; seul un compte parent peut suivre un élève.
--  2. L'école enregistre le(s) numéro(s) officiel(s) des parents de chaque élève (dossier d'inscription) : table guardian_phones.
--  3. Le parent prouve que le numéro est le sien en reliant son WhatsApp à Jean (il envoie un code depuis son téléphone).
--  Le lien n'est accepté que si le numéro WhatsApp vérifié du parent figure parmi les numéros enregistrés par l'école ;
--  il est alors actif tout de suite (l'école a vérifié), l'élève est prévenu.

alter table public.profiles add column if not exists is_parent boolean not null default false;
grant select (is_parent) on public.profiles to authenticated;

-- Numéros de parents enregistrés par l'école, par élève
create table if not exists public.guardian_phones (
  child_id   uuid not null references public.profiles (id) on delete cascade,
  phone      text not null check (phone ~ '^\+[0-9]{8,15}$'),
  label      text,                                  -- ex. « Mère », « Père », « Tuteur »
  created_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  primary key (child_id, phone)
);
alter table public.guardian_phones enable row level security;
drop policy if exists guardian_phones_read on public.guardian_phones;
create policy guardian_phones_read on public.guardian_phones for select to authenticated using (public.has_role('caissier'));
grant select on public.guardian_phones to authenticated;
grant select, insert, update, delete on public.guardian_phones to service_role;

-- Inscription : « Je suis parent » (métadonnée account = 'parent')
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_meta jsonb := coalesce(new.raw_user_meta_data, '{}');
  v_phone text := nullif(regexp_replace(coalesce(v_meta ->> 'phone', ''), '[^0-9+]', '', 'g'), '');
begin
  insert into public.profiles (id, full_name, phone, short_code, is_parent)
  values (new.id,
          coalesce(nullif(btrim(v_meta ->> 'full_name'), ''), split_part(new.email, '@', 1)),
          v_phone,
          public._gen_short_code(),
          coalesce(v_meta ->> 'account', '') = 'parent');
  insert into public.wallets (user_id) values (new.id);
  return new;
end $$;

-- Admin / caisse : numéros des parents d'un élève (par son code DB-…)
create or replace function public.guardian_list(p_child_code text) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_child public.profiles;
begin
  if not public.has_role('caissier') then return public._fail('FORBIDDEN', 'Réservé à l''administration.'); end if;
  select * into v_child from profiles where short_code = upper(regexp_replace(coalesce(p_child_code, ''), '\s', '', 'g'));
  if not found or v_child.is_parent or v_child.role <> 'client' then return public._fail('NOT_FOUND', 'Aucun élève avec ce code.'); end if;
  return jsonb_build_object('ok', true, 'child', jsonb_build_object('id', v_child.id, 'name', v_child.full_name, 'short_code', v_child.short_code),
    'phones', coalesce((select jsonb_agg(jsonb_build_object('phone', g.phone, 'label', g.label,
        'linked', exists (select 1 from whatsapp_links w join family_links l on l.parent_id = w.user_id
                           where w.phone = g.phone and l.child_id = v_child.id and l.status = 'active')) order by g.created_at)
      from guardian_phones g where g.child_id = v_child.id), '[]'::jsonb));
end $$;

create or replace function public.guardian_set(p_child_code text, p_phone text, p_label text default null, p_remove boolean default false)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_child public.profiles; v_phone text := regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g');
begin
  if not public.has_role('admin') then return public._fail('FORBIDDEN', 'Réservé à l''administration.'); end if;
  select * into v_child from profiles where short_code = upper(regexp_replace(coalesce(p_child_code, ''), '\s', '', 'g'));
  if not found or v_child.is_parent or v_child.role <> 'client' then return public._fail('NOT_FOUND', 'Aucun élève avec ce code.'); end if;
  if length(v_phone) = 10 then v_phone := '225' || v_phone; end if;   -- numéro ivoirien saisi sur 10 chiffres
  if v_phone !~ '^[0-9]{8,15}$' then return public._fail('INVALID_PHONE', 'Numéro invalide.'); end if;
  v_phone := '+' || v_phone;
  if p_remove then
    delete from guardian_phones where child_id = v_child.id and phone = v_phone;
    -- le parent dont le numéro est retiré ne suit plus l'élève
    delete from family_links l using whatsapp_links w
     where l.child_id = v_child.id and l.parent_id = w.user_id and w.phone = v_phone;
  else
    insert into guardian_phones (child_id, phone, label, created_by) values (v_child.id, v_phone, nullif(btrim(p_label), ''), auth.uid())
    on conflict (child_id, phone) do update set label = excluded.label;
  end if;
  perform public._audit(case when p_remove then 'guardian_remove' else 'guardian_add' end, v_child.id::text, jsonb_build_object('phone', v_phone));
  return public.guardian_list(v_child.short_code);
end $$;

-- Demande de suivi : compte parent + WhatsApp vérifié + numéro enregistré par l'école
create or replace function public.family_request(p_child_code text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_me public.profiles; v_child public.profiles; v_id uuid; v_phone text;
begin
  if auth.uid() is null then return public._fail('AUTH_REQUIRED', 'Connexion requise.'); end if;
  select * into v_me from profiles where id = auth.uid();
  if not v_me.is_parent then
    return public._fail('PARENT_ONLY', 'Seul un compte parent peut suivre un élève. Créez un compte « parent » à l''inscription.');
  end if;
  select * into v_child from profiles where short_code = upper(regexp_replace(coalesce(p_child_code, ''), '\s', '', 'g'));
  if not found or v_child.is_blocked or v_child.role <> 'client' or v_child.is_parent then return public._fail('NOT_FOUND', 'Aucun élève avec ce code.'); end if;
  if v_child.id = v_me.id then return public._fail('SELF', 'C''est votre propre code.'); end if;
  select phone into v_phone from whatsapp_links where user_id = v_me.id;
  if v_phone is null then
    return public._fail('WHATSAPP_REQUIRED', 'Reliez d''abord votre WhatsApp à Jean (Profil → Lier mon WhatsApp) : cela prouve que ce numéro est le vôtre.');
  end if;
  if not exists (select 1 from guardian_phones where child_id = v_child.id and phone = v_phone) then
    perform public._audit('family_request_refused', v_child.id::text, jsonb_build_object('phone', v_phone), v_me.id);
    return public._fail('NOT_GUARDIAN', 'Votre numéro n''est pas enregistré comme parent de cet élève. Demandez à l''administration de Vatel de l''ajouter à son dossier.');
  end if;
  if (select count(*) from family_links where parent_id = v_me.id) >= 6 then return public._fail('TOO_MANY', 'Six enfants au plus.'); end if;
  insert into family_links (parent_id, child_id, status, accepted_at) values (v_me.id, v_child.id, 'active', now())
  on conflict (parent_id, child_id) do update set status = 'active', accepted_at = coalesce(family_links.accepted_at, now())
  returning id into v_id;
  perform public._notify(v_child.id, 'family_request', v_me.full_name || ' suit maintenant ton compte 👨‍👩‍👧',
    'Ton parent (numéro enregistré par l''école) peut recharger ton compte et voir tes repas.',
    jsonb_build_object('href', '/app/famille', 'link_id', v_id));
  return jsonb_build_object('ok', true, 'link_id', v_id, 'child', v_child.full_name, 'status', 'active');
end $$;

revoke all on function public.guardian_list(text), public.guardian_set(text, text, text, boolean) from public, anon;
grant execute on function public.guardian_list(text), public.guardian_set(text, text, text, boolean) to authenticated;

-- Liens existants faits par un compte élève (ancienne règle) : retirés
delete from public.family_links l using public.profiles p where p.id = l.parent_id and not p.is_parent;
