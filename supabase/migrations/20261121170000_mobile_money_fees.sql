-- Frais Mobile Money payés par l'élève (décision de Bryan, 21/11) : Jèko retient une commission sur chaque paiement
-- (≈ 1,6 % constaté : 500 F payés → 492 F reçus). Pour que la cantine reçoive bien le montant crédité, l'élève paie
-- recharge + frais : total = arrondi au franc supérieur de montant / (1 − taux). Ex. 1,6 % : 500 F crédités → 509 F payés.
--  · taux réglable par l'admin : settings.mobile_money.fee_percent (0 à 10 %) ; 0 = la cantine absorbe les frais ;
--  · payments.fee garde les frais de CHAQUE paiement (figés au départ) ; le webhook vérifie montant + frais au franc près.
-- Ordre de mise en ligne sans risque : le taux part à 0 (rien ne change) ; on le règle dans Paramètres une fois
-- la nouvelle jeko-pay déployée (elle envoie le total à Jèko).

alter table public.payments add column if not exists fee int not null default 0 check (fee between 0 and 200000);

update public.settings set value = value || '{"fee_percent": 0}'::jsonb
 where key = 'mobile_money' and not (value ? 'fee_percent');

-- Frais pour un montant crédité (même calcul côté appli : src/lib/fees.ts)
create or replace function public._mobile_money_fee(p_amount int) returns int
language sql stable security definer set search_path = public, pg_temp as $$
  select case when r <= 0 or p_amount is null or p_amount <= 0 then 0
              else (ceil(p_amount::numeric / (1 - r / 100)) - p_amount)::int end
    from (select least(greatest(coalesce((public.setting('mobile_money') ->> 'fee_percent')::numeric, 0), 0), 10) as r) t
$$;
revoke all on function public._mobile_money_fee(int) from public, anon, authenticated;
grant execute on function public._mobile_money_fee(int) to service_role;

create or replace function public.payment_start(p_amount int, p_method text, p_phone text, p_child uuid default null)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := auth.uid();
  v_for uuid := coalesce(p_child, auth.uid());
  v_lim jsonb := public.setting('recharge_limits');
  v_me public.profiles;
  v_ref text;
  v_id uuid;
  v_fee int;
begin
  if v_uid is null then return public._fail('AUTH_REQUIRED', 'Connexion requise.'); end if;
  select * into v_me from public.profiles where id = v_uid;
  if v_me.is_blocked then return public._fail('ACCOUNT_BLOCKED', 'Votre compte est bloqué. Adressez-vous à la caisse.'); end if;
  if p_child is not null and p_child <> v_uid and not exists (
       select 1 from public.family_links where parent_id = v_uid and child_id = p_child and status = 'active') then
    return public._fail('FORBIDDEN', 'Ce compte n''est pas lié au vôtre.');
  end if;
  if p_amount is null or p_amount < (v_lim ->> 'min')::int or p_amount > (v_lim ->> 'max')::int then
    return public._fail('INVALID_AMOUNT', 'Montant entre ' || public.format_fcfa((v_lim ->> 'min')::int)
                        || ' et ' || public.format_fcfa((v_lim ->> 'max')::int) || '.');
  end if;
  if p_method not in ('wave', 'orange', 'mtn', 'moov', 'djamo') then
    return public._fail('INVALID_METHOD', 'Moyen de paiement non pris en charge.');
  end if;
  if coalesce(p_phone, '') !~ '^\+225(01|05|07)[0-9]{8}$' then
    return public._fail('INVALID_PHONE', 'Numéro invalide : un numéro mobile ivoirien à 10 chiffres (01, 05 ou 07…).');
  end if;
  -- Face ID activé : confirmation au départ du paiement (le crédit arrivera plus tard, par le webhook)
  if v_me.biometric_enabled and not public._biometric_ok(v_uid) then
    return public._pin_fail('BIOMETRIC_REQUIRED');
  end if;
  -- Garde-fous : 15 s entre deux tentatives, 6 tentatives en attente au plus sur 30 min
  if exists (select 1 from public.payments where payer_id = v_uid and created_at > now() - interval '15 seconds') then
    return public._fail('TOO_FAST', 'Un paiement vient d''être lancé. Patientez quelques secondes.');
  end if;
  if (select count(*) from public.payments where payer_id = v_uid and status = 'pending'
        and created_at > now() - interval '30 minutes') >= 6 then
    return public._fail('TOO_MANY', 'Trop de paiements en attente. Réessayez dans quelques minutes.');
  end if;

  v_fee := public._mobile_money_fee(p_amount);
  v_ref := 'VAT-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 12));
  insert into public.payments (reference, payer_id, beneficiary_id, amount, fee, method, payer_phone)
  values (v_ref, v_uid, v_for, p_amount, v_fee, p_method, p_phone) returning id into v_id;
  -- amount = crédité sur le compte ; total = débité sur le téléphone (frais Mobile Money compris)
  return jsonb_build_object('ok', true, 'id', v_id, 'reference', v_ref, 'amount', p_amount, 'fee', v_fee, 'total', p_amount + v_fee);
end $$;

create or replace function public._payment_success(p_reference text, p_payment_request_id text, p_amount_cents bigint,
                                                    p_tx_id text, p_method text)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  p public.payments;
  v_tx public.transactions;
  v_payer text;
  v_label text;
begin
  select * into p from public.payments where reference = p_reference for update;
  if not found then return jsonb_build_object('ok', false, 'code', 'unknown_reference'); end if;
  if p.status = 'success' then return jsonb_build_object('ok', true, 'code', 'already_paid'); end if;
  -- Montant attendu chez Jèko = recharge + frais payés par l'élève
  if p_amount_cents is null or p_amount_cents <> (p.amount + p.fee)::bigint * 100 then
    update public.payments set status = 'error', error_reason = 'amount_mismatch', completed_at = now(),
                               payment_request_id = coalesce(payment_request_id, p_payment_request_id)
     where id = p.id;
    perform public._audit('payment_amount_mismatch', p.reference, jsonb_build_object('expected_cents', (p.amount + p.fee) * 100, 'got', p_amount_cents));
    return jsonb_build_object('ok', false, 'code', 'amount_mismatch');
  end if;

  v_label := case coalesce(p_method, p.method) when 'wave' then 'Wave' when 'orange' then 'Orange Money' when 'mtn' then 'MTN MoMo'
                  when 'moov' then 'Moov Money' when 'djamo' then 'Djamo' else 'Mobile Money' end;
  select full_name into v_payer from public.profiles where id = p.payer_id;
  perform set_config('dabali.payment_credit', 'on', true);
  perform 1 from public.wallets where user_id = p.beneficiary_id for update;
  v_tx := public._wallet_move(p.beneficiary_id, p.amount, 'recharge', p_performed_by => p.payer_id,
            p_note => case when p.payer_id = p.beneficiary_id then 'Recharge ' || v_label
                           else 'Recharge par ' || v_payer || ' (' || v_label || ')' end
                      || case when p.fee > 0 then ' · frais ' || public.format_fcfa(p.fee) || ' payés en plus' else '' end);
  perform set_config('dabali.payment_credit', 'off', true);

  update public.payments set status = 'success', completed_at = now(), transaction_id = v_tx.id, error_reason = null,
                             payment_request_id = coalesce(payment_request_id, p_payment_request_id), provider_tx_id = p_tx_id
   where id = p.id;

  if p.payer_id = p.beneficiary_id then
    perform public._notify(p.payer_id, 'wallet_credited', 'Recharge reçue',
      public.format_fcfa(p.amount) || ' ajoutés par ' || v_label || '. Nouveau solde : ' || public.format_fcfa(v_tx.balance_after) || '.',
      jsonb_build_object('href', '/app/historique'));
  else
    perform public._notify(p.beneficiary_id, 'parent_recharge', v_payer || ' a rechargé ton compte 💚',
      '+' || public.format_fcfa(p.amount) || ' · nouveau solde ' || public.format_fcfa(v_tx.balance_after) || '.',
      jsonb_build_object('href', '/app/historique'));
    perform public._notify(p.payer_id, 'wallet_credited', 'Recharge envoyée',
      public.format_fcfa(p.amount) || ' ajoutés au compte cantine par ' || v_label || '.', jsonb_build_object('href', '/app/famille'));
  end if;
  return jsonb_build_object('ok', true, 'code', 'paid', 'balance', v_tx.balance_after);
end $$;

revoke all on function public.payment_start(int, text, text, uuid) from public, anon;
grant execute on function public.payment_start(int, text, text, uuid) to authenticated;
revoke all on function public._payment_success(text, text, bigint, text, text) from public, anon, authenticated;
grant execute on function public._payment_success(text, text, bigint, text, text) to service_role;
