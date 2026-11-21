-- Paiement réel des recharges par Mobile Money (Jèko Checkout, API direct)
-- Parcours : payment_start (élève ou parent, Face ID / PIN si activé) → Edge Function jeko-pay → Jèko
--            → webhook jeko-webhook ou vérification au retour → _payment_success crédite le compte UNE seule fois.
-- Un paiement échoué n'envoie pas de webhook : jeko-pay interroge Jèko au retour (au plus toutes les 10 s).

create table if not exists public.payments (
  id                 uuid primary key default gen_random_uuid(),
  reference          text not null unique,                       -- unique par tentative (exigence Jèko)
  payer_id           uuid not null references public.profiles (id),
  beneficiary_id     uuid not null references public.profiles (id),
  amount             int  not null check (amount between 100 and 2000000),
  method             text not null check (method in ('wave', 'orange', 'mtn', 'moov', 'djamo')),
  payer_phone        text,
  provider           text not null default 'jeko',
  payment_request_id text unique,
  provider_tx_id     text,
  status             text not null default 'pending' check (status in ('pending', 'success', 'error')),
  error_reason       text,
  transaction_id     uuid references public.transactions (id),
  last_checked_at    timestamptz,
  created_at         timestamptz not null default now(),
  completed_at       timestamptz
);
create index if not exists payments_payer_idx on public.payments (payer_id, created_at desc);
create index if not exists payments_beneficiary_idx on public.payments (beneficiary_id, created_at desc);

alter table public.payments enable row level security;
drop policy if exists payments_read on public.payments;
create policy payments_read on public.payments for select to authenticated
  using (payer_id = auth.uid() or beneficiary_id = auth.uid() or public.has_role('caissier'));
grant select on public.payments to authenticated;
grant select, insert, update on public.payments to service_role;   -- Edge Functions jeko-pay / jeko-webhook

-- Le crédit d'une recharge payée arrive plus tard (webhook) : le contrôle Face ID a lieu au départ du paiement,
-- et le garde-fou laisse passer ce crédit-là, et lui seulement (drapeau posé par _payment_success, local à la transaction).
create or replace function public._biometric_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.type = 'recharge'
     and coalesce(current_setting('dabali.payment_credit', true), '') <> 'on'
     and (select biometric_enabled from public.profiles where id = new.user_id)
     and not public._biometric_ok(new.user_id) then
    raise exception 'BIOMETRIC_REQUIRED' using hint = 'Confirmez avec Face ID ou votre empreinte.';
  end if;
  return new;
end $$;

-- Démarrer une recharge payante (pour soi, ou pour son enfant lié)
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

  v_ref := 'VAT-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 12));
  insert into public.payments (reference, payer_id, beneficiary_id, amount, method, payer_phone)
  values (v_ref, v_uid, v_for, p_amount, p_method, p_phone) returning id into v_id;
  return jsonb_build_object('ok', true, 'id', v_id, 'reference', v_ref, 'amount', p_amount);
end $$;
revoke all on function public.payment_start(int, text, text, uuid) from public, anon;
grant execute on function public.payment_start(int, text, text, uuid) to authenticated;

-- Paiement confirmé (webhook signé, ou statut relu chez Jèko) : crédit UNE seule fois, montant contrôlé
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
  if p_amount_cents is null or p_amount_cents <> p.amount::bigint * 100 then
    update public.payments set status = 'error', error_reason = 'amount_mismatch', completed_at = now(),
                               payment_request_id = coalesce(payment_request_id, p_payment_request_id)
     where id = p.id;
    perform public._audit('payment_amount_mismatch', p.reference, jsonb_build_object('expected_cents', p.amount * 100, 'got', p_amount_cents));
    return jsonb_build_object('ok', false, 'code', 'amount_mismatch');
  end if;

  v_label := case coalesce(p_method, p.method) when 'wave' then 'Wave' when 'orange' then 'Orange Money' when 'mtn' then 'MTN MoMo'
                  when 'moov' then 'Moov Money' when 'djamo' then 'Djamo' else 'Mobile Money' end;
  select full_name into v_payer from public.profiles where id = p.payer_id;
  perform set_config('dabali.payment_credit', 'on', true);
  perform 1 from public.wallets where user_id = p.beneficiary_id for update;
  v_tx := public._wallet_move(p.beneficiary_id, p.amount, 'recharge', p_performed_by => p.payer_id,
            p_note => case when p.payer_id = p.beneficiary_id then 'Recharge ' || v_label
                           else 'Recharge par ' || v_payer || ' (' || v_label || ')' end);
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

-- Paiement échoué (relu chez Jèko) : seulement s'il était encore en attente
create or replace function public._payment_error(p_reference text, p_reason text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update public.payments set status = 'error', error_reason = left(coalesce(p_reason, 'error'), 200), completed_at = now()
   where reference = p_reference and status = 'pending';
  return jsonb_build_object('ok', true, 'updated', found);
end $$;

revoke all on function public._payment_success(text, text, bigint, text, text), public._payment_error(text, text)
  from public, anon, authenticated;
grant execute on function public._payment_success(text, text, bigint, text, text), public._payment_error(text, text)
  to service_role;
