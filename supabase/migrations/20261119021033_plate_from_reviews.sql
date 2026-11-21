-- Photo facultative dans l'avis de l'élève → analyse de l'assiette (une par ticket). Les photos prises AVANT le repas
-- (plat servi, pas entamé) sont gardées pour l'avis mais ne comptent pas dans le gaspillage.
alter table public.plate_scans add column if not exists ticket_id uuid references public.tickets (id) on delete set null;
alter table public.plate_scans add column if not exists source text not null default 'agent' check (source in ('agent', 'avis'));
alter table public.plate_scans add column if not exists before_meal boolean not null default false;
create unique index if not exists plate_scans_ticket on public.plate_scans (ticket_id); -- plusieurs NULL autorisés (photos de l'équipe)

create or replace function public.plate_waste_stats(p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not public.has_role('chef') then return public._fail('FORBIDDEN', 'Réservé à la cuisine.'); end if;
  return jsonb_build_object('ok', true,
    'scans', (select count(*) from plate_scans where service_date between p_from and p_to and not before_meal),
    'from_reviews', (select count(*) from plate_scans where service_date between p_from and p_to and not before_meal and source = 'avis'),
    'avg_left', (select coalesce(round(avg(left_pct)), 0) from plate_scans where service_date between p_from and p_to and not before_meal),
    'empty_rate', (select coalesce(round(100.0 * count(*) filter (where left_pct <= 10) / nullif(count(*), 0)), 0)
                     from plate_scans where service_date between p_from and p_to and not before_meal),
    'dishes', coalesce((
      select jsonb_agg(x order by (x ->> 'avg_left')::int desc, (x ->> 'scans')::int desc) from (
        select jsonb_build_object('dish', d.name, 'scans', count(*), 'avg_left', round(avg(s.left_pct)),
          'worst', coalesce((
            select jsonb_agg(w order by (w ->> 'avg_left')::int desc) from (
              select jsonb_build_object('name', lower(e ->> 'name'), 'avg_left', round(avg((e ->> 'left_pct')::int))) w
                from plate_scans s2, jsonb_array_elements(s2.items) e
               where s2.dish_id = d.id and s2.service_date between p_from and p_to and not s2.before_meal
               group by lower(e ->> 'name') having round(avg((e ->> 'left_pct')::int)) >= 20
               order by round(avg((e ->> 'left_pct')::int)) desc limit 2) z), '[]')) x
          from plate_scans s join dishes d on d.id = s.dish_id
         where s.service_date between p_from and p_to and not s.before_meal
         group by d.id, d.name) q), '[]'::jsonb),
    'recent', coalesce((
      select jsonb_agg(jsonb_build_object('at', s.created_at, 'dish', d.name, 'left_pct', s.left_pct, 'note', s.note) order by s.created_at desc)
        from (select * from plate_scans where service_date between p_from and p_to and not before_meal order by created_at desc limit 8) s
        left join dishes d on d.id = s.dish_id), '[]'::jsonb));
end $$;
