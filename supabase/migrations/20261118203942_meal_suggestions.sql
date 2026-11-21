-- Suggestions de repas personnalisées par l'IA (bonus du guide Vatel) : mises en cache par élève et par repas.
create table if not exists public.ai_meal_suggestions (
  user_id      uuid not null references public.profiles (id) on delete cascade,
  service_date date not null,
  service      public.service_kind not null,
  input_hash   text not null,
  result       jsonb not null,
  created_at   timestamptz not null default now(),
  primary key (user_id, service_date, service)
);
alter table public.ai_meal_suggestions enable row level security;
create policy "suggestions : les miennes" on public.ai_meal_suggestions for select to authenticated using (user_id = auth.uid());
grant select on public.ai_meal_suggestions to authenticated;
grant all on public.ai_meal_suggestions to service_role;
