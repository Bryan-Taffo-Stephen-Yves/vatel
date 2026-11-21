-- Recharge : interrupteur « simulation / argent réel » (Paramètres → Argent et sécurité)
--  · simulation (par défaut, démo) : la recharge crédite sans paiement ;
--  · jeko (argent réel) : la recharge passe uniquement par Jèko ; la simulation est REFUSÉE par la base,
--    sinon n'importe qui pourrait se créditer gratuitement en appelant simulate_recharge.

insert into public.settings (key, value) values ('mobile_money', '{"mode": "simulation"}')
on conflict (key) do nothing;

create or replace function public._simulation_allowed() returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(public.setting('mobile_money') ->> 'mode', 'simulation') <> 'jeko'
$$;
revoke all on function public._simulation_allowed() from public, anon, authenticated;

create or replace function public.simulate_recharge(p_amount int) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := auth.uid();
  v_lim jsonb := public.setting('recharge_limits');
  v_tx public.transactions;
begin
  if v_uid is null then return public._fail('AUTH_REQUIRED', 'Connexion requise.'); end if;
  if not public._simulation_allowed() then
    return public._fail('SIMULATION_OFF', 'La recharge se fait maintenant par Mobile Money (paiement réel).');
  end if;
  if (select is_blocked from public.profiles where id = v_uid) then
    return public._fail('ACCOUNT_BLOCKED', 'Votre compte est bloqué. Adressez-vous à la caisse.');
  end if;
  if p_amount is null or p_amount < (v_lim ->> 'min')::int or p_amount > (v_lim ->> 'max')::int then
    return public._fail('INVALID_AMOUNT', 'Montant entre ' || public.format_fcfa((v_lim ->> 'min')::int)
                        || ' et ' || public.format_fcfa((v_lim ->> 'max')::int) || '.');
  end if;
  perform 1 from public.wallets where user_id = v_uid for update;
  v_tx := public._wallet_move(v_uid, p_amount, 'recharge', p_note => 'Mobile Money (simulation)');
  return jsonb_build_object('ok', true, 'balance', v_tx.balance_after, 'transaction_id', v_tx.id);
end $$;

create or replace function public.parent_recharge_child(p_child uuid, p_amount int) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_lim jsonb := public.setting('recharge_limits'); v_tx public.transactions; v_me text;
begin
  if not public._simulation_allowed() then
    return public._fail('SIMULATION_OFF', 'La recharge se fait maintenant par Mobile Money (paiement réel).');
  end if;
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
