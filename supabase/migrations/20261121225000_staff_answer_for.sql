-- Personnel sans smartphone (téléphone à touches, pas de WhatsApp) : le chef d'équipe ou l'administration
-- répond « mange / ne mange pas » à sa place depuis la page Équipe, pour que la cuisine ait le bon compte.
--  · p_answer null = effacer la réponse du jour ;
--  · pas besoin que la question WhatsApp soit partie (ces employés ne la reçoivent pas) ;
--  · chaque réponse donnée pour quelqu'un d'autre est tracée (audit).

create or replace function public.staff_meal_answer_for(p_user uuid, p_answer boolean) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_today date := public.today_abidjan(); v_name text;
begin
  if not public.has_role('caissier') then return public._fail('FORBIDDEN', 'Réservé à l''administration.'); end if;
  select full_name into v_name from public.profiles where id = p_user and staff_job is not null and not is_blocked;
  if not found then return public._fail('NOT_STAFF', 'Cette personne n''est pas dans le personnel.'); end if;
  if exists (select 1 from public.staff_meals where user_id = p_user and service_date = v_today) then
    return public._fail('ALREADY_SERVED', v_name || ' a déjà mangé aujourd''hui.');
  end if;
  if p_answer is null then
    delete from public.staff_meal_answers where user_id = p_user and service_date = v_today;
  else
    insert into public.staff_meal_answers (user_id, service_date, answer) values (p_user, v_today, p_answer)
    on conflict (user_id, service_date) do update set answer = excluded.answer, answered_at = now();
  end if;
  perform public._audit('staff_meal_answer_for', p_user::text, jsonb_build_object('answer', p_answer));
  return jsonb_build_object('ok', true, 'answer', p_answer);
end $$;

revoke all on function public.staff_meal_answer_for(uuid, boolean) from public, anon;
grant execute on function public.staff_meal_answer_for(uuid, boolean) to authenticated;
