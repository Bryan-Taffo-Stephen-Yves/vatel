-- Affluence par le RYTHME DES SCANS au comptoir (idée de Bryan, 21/11) : quand l'agent scanne un QR toutes les
-- 10 à 30 secondes, il y a beaucoup de monde ; quand l'écart entre deux scans s'allonge, la file diminue.
-- Marche sans caméra ni plateaux : il suffit que le comptoir scanne.
--  · intervalle = médiane des 5 derniers écarts entre scans (tous les agents ensemble), ou le temps écoulé
--    depuis le dernier scan s'il est plus long (le comptoir s'est vidé) ;
--  · niveau : ≤ 30 s forte affluence · ≤ 90 s moyenne · au-delà calme ;
--  · tendance : on compare aux 5 écarts d'avant (écarts 1,5 fois plus longs = la file diminue,
--    1,5 fois plus courts = la file grossit).
-- Affiché sur Pilote du service et Affluence (équipe). Le Pilote propose un renfort quand le comptoir est sous
-- pression et que la caméra ne voit pas la file. Aucune donnée personnelle : seules les heures de scan comptent.

create or replace function public._scan_rhythm(p_at timestamptz default now()) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_ts timestamptz[]; v_gaps numeric[]; v_n int;
  v_recent numeric; v_prev numeric; v_since numeric; v_eff numeric;
  v_level text; v_trend text; v_fmt text; v_text text;
begin
  select coalesce(array_agg(used_at order by used_at desc), '{}') into v_ts from (
    select used_at from tickets
     where status = 'used' and used_at > p_at - interval '20 minutes' and used_at <= p_at
     order by used_at desc limit 11) s;
  v_n := coalesce(array_length(v_ts, 1), 0);
  v_since := case when v_n > 0 then round(extract(epoch from (p_at - v_ts[1]))) end;

  if v_n < 3 then
    return jsonb_build_object('level', case when v_n = 0 then 'none' else 'low' end, 'scans', v_n,
      'since_last_s', v_since, 'interval_s', null, 'per_min', null, 'trend', null, 'gaps', '[]'::jsonb,
      'text', case when v_n = 0 then 'Aucun scan depuis 20 min au comptoir.'
                   else 'Peu de passages au comptoir (' || v_n || ' scan' || case when v_n > 1 then 's' else '' end || ' en 20 min) : c''est calme.' end);
  end if;

  -- Écarts en secondes, du plus récent au plus ancien
  select array_agg(extract(epoch from (v_ts[i] - v_ts[i + 1])) order by i) into v_gaps from generate_series(1, v_n - 1) i;
  select percentile_cont(0.5) within group (order by g) into v_recent from unnest(v_gaps[1:5]) g;
  if array_length(v_gaps, 1) >= 8 then
    select percentile_cont(0.5) within group (order by g) into v_prev from unnest(v_gaps[6:10]) g;
  end if;
  v_eff := greatest(v_recent, v_since, 1);

  v_level := case when v_eff <= 30 then 'high' when v_eff <= 90 then 'mid' else 'low' end;
  v_trend := case when v_since >= 60 and v_since > 3 * greatest(v_recent, 1) then 'falling'
                  when v_prev is null then null
                  when v_eff >= 1.5 * greatest(v_prev, 1) then 'falling'
                  when v_eff * 1.5 <= v_prev then 'rising'
                  else 'stable' end;
  v_fmt := case when v_eff < 90 then round(v_eff)::int || ' s' else round(v_eff / 60)::int || ' min' end;
  v_text := 'Un passage toutes les ' || v_fmt || ' au comptoir : '
    || case v_level when 'high' then 'forte affluence.' when 'mid' then 'affluence moyenne.' else 'c''est calme.' end
    || case v_trend when 'rising' then ' Les passages s''accélèrent : la file grossit.'
                    when 'falling' then ' Les écarts s''allongent : la file diminue.'
                    when 'stable' then ' Rythme stable.' else '' end;

  return jsonb_build_object('level', v_level, 'scans', v_n, 'since_last_s', v_since,
    'interval_s', round(v_eff)::int, 'per_min', round(60 / v_eff, 1), 'trend', v_trend,
    'gaps', (select coalesce(jsonb_agg(round(g)::int order by o desc), '[]') from unnest(v_gaps) with ordinality u(g, o)),
    'text', v_text);
end $$;

-- Pour l'équipe (agent, caisse, cuisine, admin)
create or replace function public.scan_rhythm() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not public.has_role('agent', 'caissier', 'chef') then return public._fail('FORBIDDEN', 'Réservé à l''équipe.'); end if;
  return jsonb_build_object('ok', true) || public._scan_rhythm(now());
end $$;

-- Pilote du service : ajoute le rythme, et propose un renfort quand le comptoir est sous pression sans que la
-- caméra voie la file (aucune suggestion « file » déjà présente, rien de fait ou écarté depuis 20 min)
create or replace function public._pilot_rhythm(p_state jsonb, p_date date, p_service public.service_kind, p_at timestamptz default now())
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare r jsonb := public._scan_rhythm(p_at); v_sugg jsonb := coalesce(p_state -> 'suggestions', '[]');
begin
  if r ->> 'level' = 'high' and coalesce(r ->> 'trend', '') <> 'falling'
     and p_state ->> 'queue_count' is null
     and not exists (select 1 from jsonb_array_elements(v_sugg) s where s ->> 'kind' = 'queue')
     and not exists (select 1 from pilot_actions a where a.service_date = p_date and a.service = p_service
                       and a.created_at > p_at - interval '20 minutes' and a.ref = 'queue' and a.kind in ('queue', 'dismiss')) then
    v_sugg := v_sugg || jsonb_build_object('kind', 'queue', 'ref', 'queue', 'priority', 2, 'qty', null,
      'title', 'Comptoir sous pression',
      'text', 'Un passage toutes les ' || (r ->> 'interval_s') || ' s'
              || case when r ->> 'trend' = 'rising' then ', et ça s''accélère' else '' end || '. Appeler un renfort ?');
    select coalesce(jsonb_agg(s order by (s ->> 'priority')::int), '[]') into v_sugg from jsonb_array_elements(v_sugg) s;
  end if;
  return p_state || jsonb_build_object('suggestions', v_sugg, 'rhythm', r);
end $$;

create or replace function public.pilot_state() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare s record;
begin
  if not public.has_role('chef', 'caissier') then return public._fail('FORBIDDEN', 'Réservé à la cuisine et à l''administration.'); end if;
  select * into s from public._pilot_service(now());
  if s.service is null then
    return jsonb_build_object('ok', true, 'status', 'closed', 'next', public.occupancy_now() -> 'next', 'rhythm', public._scan_rhythm(now()));
  end if;
  return public._pilot_rhythm(public._pilot_state(public.today_abidjan(), s.service, s.starts_at, s.ends_at, now()),
                              public.today_abidjan(), s.service, now());
end $$;

revoke all on function public._scan_rhythm(timestamptz), public._pilot_rhythm(jsonb, date, public.service_kind, timestamptz) from public, anon, authenticated;
grant execute on function public._scan_rhythm(timestamptz), public._pilot_rhythm(jsonb, date, public.service_kind, timestamptz) to service_role;
revoke all on function public.scan_rhythm(), public.pilot_state() from public, anon;
grant execute on function public.scan_rhythm(), public.pilot_state() to authenticated;
