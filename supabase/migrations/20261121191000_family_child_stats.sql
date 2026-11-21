-- Statistiques du parent (page Famille) : ce que l'enfant a mangé et dépensé sur une période.
-- family_child_stats(p_child, p_period) — p_period : 'week' (cette semaine), 'month' (ce mois), 'since_recharge'
-- (depuis la dernière recharge). Seul un parent dont le lien est ACTIF (accepté par l'enfant) peut la lire.
-- Renvoie : la ligne lundi → vendredi de la semaine en cours (a mangé / pas venu), repas pris, montant dépensé
-- (achats moins remboursements), la dernière recharge et ce qu'il en reste, et à part les repas offerts et l'argent
-- envoyé à des camarades.

create or replace function public.family_child_stats(p_child uuid, p_period text default 'week') returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_today date := public.today_abidjan();
  v_monday date := v_today - (extract(isodow from v_today)::int - 1);
  v_from timestamptz;
  v_last public.transactions;
  v_balance int;
  v_out_since int;
begin
  if auth.uid() is null then return public._fail('AUTH_REQUIRED', 'Connexion requise.'); end if;
  if not exists (select 1 from public.family_links where parent_id = auth.uid() and child_id = p_child and status = 'active') then
    return public._fail('FORBIDDEN', 'Ce compte n''est pas lié au vôtre.');
  end if;

  -- Dernière recharge (Mobile Money, caisse ou parent)
  select * into v_last from public.transactions
   where user_id = p_child and type in ('recharge', 'recharge_cash') order by created_at desc limit 1;
  select balance into v_balance from public.wallets where user_id = p_child;

  v_from := case coalesce(p_period, 'week')
    when 'month' then (date_trunc('month', v_today::timestamp) at time zone 'Africa/Abidjan')
    when 'since_recharge' then coalesce(v_last.created_at, v_monday::timestamp at time zone 'Africa/Abidjan')
    else (v_monday::timestamp at time zone 'Africa/Abidjan') end;

  -- Argent sorti depuis la dernière recharge (repas, envois) moins les remboursements
  if v_last.id is not null then
    select coalesce(-sum(amount) filter (where type in ('purchase', 'transfer_out')), 0)
         - coalesce(sum(amount) filter (where type = 'refund'), 0)
      into v_out_since
      from public.transactions where user_id = p_child and created_at > v_last.created_at;
  end if;

  return jsonb_build_object('ok', true,
    'period', coalesce(p_period, 'week'), 'from', v_from,
    -- Semaine en cours, lundi → vendredi : point plein = a mangé
    'days', (select jsonb_agg(jsonb_build_object('date', d::date,
               'ate', exists (select 1 from public.tickets t where t.user_id = p_child and t.status = 'used'
                               and (t.used_at at time zone 'Africa/Abidjan')::date = d::date),
               'future', d::date > v_today) order by d)
               from generate_series(v_monday, v_monday + 4, interval '1 day') d),
    'meals', (select count(*) from public.tickets where user_id = p_child and status = 'used' and used_at >= v_from),
    'spent', (select coalesce(-sum(amount) filter (where type = 'purchase'), 0) - coalesce(sum(amount) filter (where type = 'refund'), 0)
                from public.transactions where user_id = p_child and created_at >= v_from),
    'last_recharge', case when v_last.id is null then null else jsonb_build_object(
        'amount', v_last.amount, 'at', v_last.created_at,
        'left', least(greatest(v_last.amount - coalesce(v_out_since, 0), 0), coalesce(v_balance, 0))) end,
    -- À part : repas offerts à un camarade, argent envoyé
    'gifts', (select coalesce(jsonb_agg(g order by g.at desc), '[]') from (
        select min(t.created_at) at, p.full_name as "to", count(*)::int as tickets, sum(t.total)::int as amount,
               public.service_label(min(t.service::text)::public.service_kind) as meal
          from public.tickets t join public.profiles p on p.id = t.user_id
         where t.buyer_id = p_child and t.user_id <> p_child and t.created_at >= v_from
         group by p.full_name, date_trunc('minute', t.created_at)
         order by 1 desc limit 20) g),
    'transfers', (select coalesce(jsonb_agg(x order by x.at desc), '[]') from (
        select tr.created_at at, p.full_name as "to", -tr.amount as amount, tr.note
          from public.transactions tr left join public.profiles p on p.id = tr.counterpart_id
         where tr.user_id = p_child and tr.type = 'transfer_out' and tr.created_at >= v_from
         order by tr.created_at desc limit 20) x));
end $$;
revoke all on function public.family_child_stats(uuid, text) from public, anon;
grant execute on function public.family_child_stats(uuid, text) to authenticated;
