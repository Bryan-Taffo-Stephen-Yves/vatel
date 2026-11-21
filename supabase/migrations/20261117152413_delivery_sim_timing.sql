-- Simulation plus lente (≈ 5 min pour la tournée de démo, le temps d'intervenir dans le groupe)
-- et heure d'arrivée cohérente avec le rythme simulé (sinon « dans 14 min » alors que le coursier arrive en 2 min).
update public.settings set value = value || '{"speed": 12}' where key = 'delivery';

create or replace function public._delivery_eta(p_run uuid) returns timestamptz
language sql stable security definer set search_path = public, pg_temp as $$
  select now()
    + case when r.mode = 'simulation' then
        -- trajet restant au rythme simulé + 10 s par article restant et 20 s par arrêt restant
        make_interval(secs => greatest(coalesce(((r.route -> 'cum' ->> (jsonb_array_length(r.route -> 'cum') - 1))::numeric
                                 - (r.route -> 'cum' ->> r.route_idx)::numeric), 0), 0)
                              / greatest(coalesce((public.setting('delivery') ->> 'speed')::numeric, 12), 1)
                              + 10 * (select count(*) from delivery_items i where i.run_id = r.id and i.status = 'a_acheter')
                              + 20 * (select count(*) from delivery_stops s where s.run_id = r.id and s.status in ('a_faire', 'en_cours')))
      else
        make_interval(secs => greatest(coalesce(((r.route -> 'cum' ->> (jsonb_array_length(r.route -> 'cum') - 1))::numeric
                                 - (r.route -> 'cum' ->> r.route_idx)::numeric), 0), 0))
        + make_interval(mins => (select count(*)::int from delivery_stops s where s.run_id = r.id and s.status in ('a_faire', 'en_cours'))
                                * coalesce((public.setting('delivery') ->> 'stop_minutes')::int, 5))
      end
    from delivery_runs r where r.id = p_run and r.route is not null
$$;
