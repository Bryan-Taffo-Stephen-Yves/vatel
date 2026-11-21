-- La demande d'avis part 15 min après le repas (au lieu de 30) : l'assiette est souvent encore là pour la photo.
create or replace function public.request_reviews() returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare n int;
begin
  with due as (
    update public.tickets t set review_requested_at = now()
     where t.status = 'used' and t.dish_id is not null and t.review_requested_at is null and t.review_dismissed_at is null
       and t.used_at <= now() - interval '15 minutes' and t.used_at > now() - interval '1 day'
       and not exists (select 1 from public.ratings r where r.ticket_id = t.id)
    returning t.id, t.user_id, t.dish_id
  )
  insert into public.notifications (user_id, type, title, body, data)
  select due.user_id, 'rate_dish', 'Comment était ton ' || lower(split_part(d.name, ' ', 1)) || ' ?',
         'Note ton repas en 2 secondes. Une photo de ton assiette (facultative) aide la cuisine à ajuster les portions.',
         jsonb_build_object('ticket_id', due.id, 'dish_id', due.dish_id, 'href', '/app/avis/' || due.id)
    from due join public.dishes d on d.id = due.dish_id;
  get diagnostics n = row_count;
  return n;
end $$;

create or replace function public.pending_review() returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((
    select jsonb_build_object('ticket_id', t.id, 'dish', d.name, 'photo_url', d.photo_url, 'service', t.service, 'used_at', t.used_at)
      from public.tickets t join public.dishes d on d.id = t.dish_id
     where t.user_id = auth.uid() and t.status = 'used' and t.review_dismissed_at is null
       and t.used_at <= now() - interval '15 minutes' and t.used_at > now() - interval '1 day'
       and not exists (select 1 from public.ratings r where r.ticket_id = t.id)
     order by t.used_at desc limit 1), 'null'::jsonb)
$$;
