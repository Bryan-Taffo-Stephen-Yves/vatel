-- Gaspillage dans l'assiette : au retour des plateaux, une photo → l'IA estime ce qui n'a pas été mangé (par élément).
-- On ne garde PAS la photo, seulement les chiffres. Le chef voit, par plat, ce qui revient le plus.
create table if not exists public.plate_scans (
  id           uuid primary key default gen_random_uuid(),
  service_date date not null default public.today_abidjan(),
  service      public.service_kind,
  menu_item_id uuid references public.menu_items (id) on delete set null,
  dish_id      uuid references public.dishes (id) on delete set null,
  left_pct     int not null check (left_pct between 0 and 100),
  items        jsonb not null default '[]',   -- [{ "name": "riz", "left_pct": 40 }]
  note         text,
  created_by   uuid references public.profiles (id) on delete set null,
  created_at   timestamptz not null default now()
);
create index if not exists plate_scans_day on public.plate_scans (service_date, dish_id);
alter table public.plate_scans enable row level security;
create policy "assiettes : équipe" on public.plate_scans for select to authenticated using (public.has_role('agent') or public.has_role('chef'));
grant select on public.plate_scans to authenticated;
grant all on public.plate_scans to service_role;

-- Statistiques pour le chef : par plat, part moyenne laissée et éléments qui reviennent le plus
create or replace function public.plate_waste_stats(p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not public.has_role('chef') then return public._fail('FORBIDDEN', 'Réservé à la cuisine.'); end if;
  return jsonb_build_object('ok', true,
    'scans', (select count(*) from plate_scans where service_date between p_from and p_to),
    'avg_left', (select coalesce(round(avg(left_pct)), 0) from plate_scans where service_date between p_from and p_to),
    'empty_rate', (select coalesce(round(100.0 * count(*) filter (where left_pct <= 10) / nullif(count(*), 0)), 0)
                     from plate_scans where service_date between p_from and p_to),
    'dishes', coalesce((
      select jsonb_agg(x order by (x ->> 'avg_left')::int desc, (x ->> 'scans')::int desc) from (
        select jsonb_build_object('dish', d.name, 'scans', count(*), 'avg_left', round(avg(s.left_pct)),
          'worst', coalesce((
            select jsonb_agg(w order by (w ->> 'avg_left')::int desc) from (
              select jsonb_build_object('name', lower(e ->> 'name'), 'avg_left', round(avg((e ->> 'left_pct')::int))) w
                from plate_scans s2, jsonb_array_elements(s2.items) e
               where s2.dish_id = d.id and s2.service_date between p_from and p_to
               group by lower(e ->> 'name') having round(avg((e ->> 'left_pct')::int)) >= 20
               order by round(avg((e ->> 'left_pct')::int)) desc limit 2) z), '[]')) x
          from plate_scans s join dishes d on d.id = s.dish_id
         where s.service_date between p_from and p_to
         group by d.id, d.name) q), '[]'::jsonb),
    'recent', coalesce((
      select jsonb_agg(jsonb_build_object('at', s.created_at, 'dish', d.name, 'left_pct', s.left_pct, 'note', s.note) order by s.created_at desc)
        from (select * from plate_scans where service_date between p_from and p_to order by created_at desc limit 8) s
        left join dishes d on d.id = s.dish_id), '[]'::jsonb));
end $$;
revoke all on function public.plate_waste_stats(date, date) from public, anon;
grant execute on function public.plate_waste_stats(date, date) to authenticated;
