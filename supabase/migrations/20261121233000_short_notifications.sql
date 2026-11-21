-- Notifications courtes : sur l'écran verrouillé on ne voit que 2 lignes. Une ligne qui dit ce qui se passe
-- (avec un emoji), une ligne avec l'essentiel (montant, heure, plat). Pas de noms à rallonge (« Parent Démo (Konan) »).
-- Réécriture faite à l'enregistrement de la notification (AVANT insertion) : le même texte court sert pour le push,
-- la liste des notifications de l'appli et WhatsApp. Une seule fonction, sans toucher aux ~30 fonctions qui notifient.
-- Si un texte n'a pas la forme attendue, il est gardé tel quel (jamais de notification cassée).
-- Non modifiées volontairement : sécurité (security, ticket_pin, account_secured, whatsapp_linked, voice_code)
-- et lien de confirmation Jean (order_link) : chaque mot y compte.
create or replace function public._notif_short()
returns trigger language plpgsql set search_path = public, pg_temp as $$
declare
  t text := coalesce(new.title, '');
  b text := coalesce(new.body, '');
  m text[]; m2 text[];
  dish text;
begin
  case new.type
    -- Élève
    when 'parent_recharge' then
      new.title := 'Ton parent a rechargé ton compte 🥳🎉';
      m := regexp_match(b, 'nouveau solde (.+?)\.?$');
      if m is not null then new.body := 'Nouveau solde : ' || m[1]; end if;
    when 'transfer_received' then
      m := regexp_match(b, '^(\S+).* vous a envoyé (.+?)\.?$');
      if m is not null then new.title := 'Tu as reçu ' || m[2] || ' 💸'; new.body := 'De la part de ' || m[1]; end if;
    when 'wallet_credited' then
      m := regexp_match(b, '^(.+?) ajoutés');
      m2 := regexp_match(b, 'Nouveau solde : (.+?)\.?$');
      if t like 'Recharge envoyée%' then          -- parent qui recharge son enfant
        new.title := 'Recharge envoyée ✅';
        if m is not null then new.body := '+' || m[1] || ' sur le compte de ton enfant'; end if;
      else                                         -- recharge de son propre compte
        new.title := 'Recharge réussie ✅';
        if m2 is not null then new.body := 'Nouveau solde : ' || m2[1];
        elsif m is not null then new.body := '+' || m[1] || ' sur ton compte'; end if;
      end if;
    when 'low_balance' then
      new.title := 'Solde bas 🪫';
      m := regexp_match(b, 'solde est de (.+?)\.');
      if m is not null then new.body := 'Il te reste ' || m[1] || '. Pense à recharger.'; end if;
    when 'meal_gift' then
      new.title := 'Un repas t''est offert 🎁';
      m := regexp_match(b, '^(\S+).* vous offre (.+?)\.?$');
      if m is not null then new.body := m[1] || ' t''offre ' || m[2]; end if;
    when 'ticket_valid' then
      new.body := 'Montre ton QR au comptoir';
    when 'ticket_expiring' then
      new.title := 'Ton ticket expire bientôt ⏳';
      m := regexp_match(b, '^Ticket (.+?) : valable jusqu''à (.+?)\.?$');
      if m is not null then new.body := m[1] || ' · jusqu''à ' || m[2]; end if;
    when 'ticket_refunded' then
      if t not like '%💸' then new.title := t || ' 💸'; end if;
      m := regexp_match(b, ': (.+?) sont revenus');
      if m is not null then new.body := '+' || m[1] || ' sur ton solde'; end if;
    when 'order_placed' then
      m := regexp_match(t, 'n° (\d+)');
      new.title := 'Commande' || coalesce(' n° ' || m[1], '') || ' reçue ✅';
      if position('. ' in b) > 0 then new.body := split_part(b, '. ', 1); end if;
    when 'order_preparing' then
      new.title := 'Ta commande est en préparation 👨‍🍳';
      dish := split_part(b, ' en préparation', 1);
      m := regexp_match(b, 'Retrait à (.+?)\.?$');
      if m is not null and dish <> b then new.body := dish || ' · retrait à ' || m[1]; end if;
    when 'order_ready' then
      new.title := 'Ta commande est prête 🍽️';
      dish := split_part(b, ' t''attend', 1);
      m := regexp_match(b, 'avant (.+?)\.?$');
      if m is not null and dish <> b then new.body := dish || ' · avant ' || m[1]; end if;
    when 'order_pickup_reminder', 'order_reminder' then
      new.title := 'Ta commande t''attend 🍽️';
      m2 := regexp_match(b, '^(.+?) (?:est )?à récupérer avant');   -- le rappel nomme le plat quand il est connu
      dish := case when m2 is not null and m2[1] not in ('À', 'Ta commande') then m2[1] end;
      m := regexp_match(b, 'avant (\d{1,2}h\d{2})');
      if m is not null then
        new.body := coalesce(dish || ' · ', '') || 'à récupérer avant ' || m[1];
        new.body := upper(left(new.body, 1)) || substr(new.body, 2);
      end if;
    when 'order_missed' then
      new.title := 'Commande non récupérée 😕';
      new.body := 'Le service est terminé : elle n''est pas remboursée';
    when 'rate_dish' then
      if t not like '%😋' then new.title := t || ' 😋'; end if;
      new.body := 'Donne ton avis en 2 secondes';
    when 'review_reply' then
      new.title := 'La cuisine t''a répondu 💬';
    when 'menu_published' then
      new.title := 'Le menu de la semaine est là 🍽️';
      new.body := 'Réserve tes repas';
    when 'family_request' then
      new.title := 'Ton parent suit ton compte 👨‍👩‍👧';
      new.body := 'Il peut recharger ton compte et voir tes repas';
    -- Parent
    when 'family_accepted' then
      m := regexp_match(t, '^(\S+)');
      if m is not null then new.title := m[1] || ' a accepté ✅'; end if;
      new.body := 'Tu peux recharger son compte et suivre ses repas';
    when 'child_low_balance' then
      m := regexp_match(t, '^Solde bas : (\S+)');
      m2 := regexp_match(b, 'plus que (.+?) sur son compte');
      if m is not null then new.title := 'Solde bas pour ' || m[1] || ' 🪫'; end if;
      if m2 is not null then new.body := 'Il lui reste ' || m2[1] || '. Recharge en un clic.'; end if;
    -- Équipe
    when 'order_new' then
      m := regexp_match(b, '^(.+?) · (\S+)[^·]* · retrait (?:aujourd''hui )?à (.+)$');
      if m is not null then new.body := m[1] || ' · ' || m[2] || ' · ' || m[3]; end if;
    else null;
  end case;
  return new;
end $$;

drop trigger if exists notifications_short on public.notifications;
-- BEFORE INSERT : s'exécute avant l'envoi push / WhatsApp (triggers AFTER) ; après notifications_guest_skip (ordre alphabétique)
create trigger notifications_short before insert on public.notifications
  for each row execute function public._notif_short();
revoke all on function public._notif_short() from public, anon, authenticated;
