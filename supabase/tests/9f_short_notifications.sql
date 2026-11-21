-- Notifications courtes : réécriture à l'enregistrement (les vrais textes longs relevés en base → version courte)
begin;
select tests.setup();
select tests.as_service();
create temp table cas (type text, title text, body text, t_ok text, b_ok text, k serial);
insert into cas values
 ('parent_recharge', 'Parent Démo (Konan) a rechargé ton compte 💚', '+500 FCFA · nouveau solde 117 000 FCFA.', 'Ton parent a rechargé ton compte 🥳🎉', 'Nouveau solde : 117 000 FCFA'),
 ('transfer_received', 'Transfert reçu', 'Aya Konan vous a envoyé 5 000 FCFA.', 'Tu as reçu 5 000 FCFA 💸', 'De la part de Aya'),
 ('wallet_credited', 'Recharge envoyée', '500 FCFA ajoutés au compte cantine par Wave.', 'Recharge envoyée ✅', '+500 FCFA sur le compte de ton enfant'),
 ('wallet_credited', 'Recharge reçue', '5 000 FCFA ajoutés par Wave. Nouveau solde : 105 000 FCFA.', 'Recharge réussie ✅', 'Nouveau solde : 105 000 FCFA'),
 ('low_balance', 'Solde bas', 'Votre solde est de 1 700 FCFA. Pensez à recharger.', 'Solde bas 🪫', 'Il te reste 1 700 FCFA. Pense à recharger.'),
 ('meal_gift', 'Un repas vous est offert 🎁', 'Koffi Diabaté vous offre 1 ticket Dîner.', 'Un repas t''est offert 🎁', 'Koffi t''offre 1 ticket Dîner'),
 ('ticket_expiring', 'Votre ticket expire bientôt ⏳', 'Ticket Déjeuner : valable jusqu''à 14h30.', 'Ton ticket expire bientôt ⏳', 'Déjeuner · jusqu''à 14h30'),
 ('ticket_refunded', 'Ticket Déjeuner remboursé', 'Ton ticket n''a pas été utilisé à temps : 2 500 FCFA sont revenus sur ton solde.', 'Ticket Déjeuner remboursé 💸', '+2 500 FCFA sur ton solde'),
 ('order_placed', 'Commande n° 1 bien reçue ✅', 'Attiéké poisson braisé · retrait aujourd''hui à 13h30. On te prévient quand la cuisine la prépare, puis quand elle est prête.', 'Commande n° 1 reçue ✅', 'Attiéké poisson braisé · retrait aujourd''hui à 13h30'),
 ('order_preparing', 'La cuisine prépare ta commande n° 1 👨‍🍳', 'Attiéké poisson braisé en préparation. Retrait à 13h30.', 'Ta commande est en préparation 👨‍🍳', 'Attiéké poisson braisé · retrait à 13h30'),
 ('order_ready', 'Ta commande n° 1 est prête 🍽️', 'Attiéké poisson braisé t''attend au comptoir. À récupérer avant 14h30.', 'Ta commande est prête 🍽️', 'Attiéké poisson braisé · avant 14h30'),
 ('order_pickup_reminder', 'Ta commande n° 1 t''attend 🍽️', 'Attiéké poisson braisé est à récupérer avant 14h30. Après, elle sera perdue.', 'Ta commande t''attend 🍽️', 'Attiéké poisson braisé · à récupérer avant 14h30'),
 ('order_pickup_reminder', 'Ta commande n° 2 t''attend 🍽️', 'Garba à récupérer avant 14h30. Après, elle sera perdue.', 'Ta commande t''attend 🍽️', 'Garba · à récupérer avant 14h30'),
 ('order_reminder', 'Ta commande n° 1 t''attend 🍽️', 'À récupérer avant 14h30, sinon elle sera perdue.', 'Ta commande t''attend 🍽️', 'À récupérer avant 14h30'),
 ('menu_published', 'Le menu de la semaine est disponible 🍽️', 'Découvrez les plats de la semaine du 23/11 et réservez vos repas.', 'Le menu de la semaine est là 🍽️', 'Réserve tes repas'),
 ('child_low_balance', 'Solde bas : Aya Konan', 'Aya Konan n''a plus que 300 FCFA sur son compte cantine. Rechargez-le en un clic.', 'Solde bas pour Aya 🪫', 'Il lui reste 300 FCFA. Recharge en un clic.'),
 ('family_accepted', 'Aya Konan a accepté ✅', 'Vous pouvez maintenant recharger son compte et suivre ses repas.', 'Aya a accepté ✅', 'Tu peux recharger son compte et suivre ses repas'),
 ('order_new', 'Nouvelle commande n° 1 🛎️', 'Attiéké poisson braisé · Koffi Diabaté · retrait aujourd''hui à 13h30', 'Nouvelle commande n° 1 🛎️', 'Attiéké poisson braisé · Koffi · 13h30'),
 -- texte inattendu : gardé tel quel ; sécurité : jamais modifiée
 ('transfer_received', 'Transfert reçu', 'Un texte différent', 'Transfert reçu', 'Un texte différent'),
 ('security', 'Face ID activé', 'Face ID vient d''être activé sur un appareil. Si ce n''est pas toi, va dans Profil.', 'Face ID activé', 'Face ID vient d''être activé sur un appareil. Si ce n''est pas toi, va dans Profil.');
select public._notify(tests.uid('alice'), type, title, body, jsonb_build_object('k', k)) from cas order by k;
select tests.ok(n.title = c.t_ok and n.body = c.b_ok, c.type || ' : « ' || n.title || ' » / « ' || n.body || ' »')
  from cas c join public.notifications n on n.user_id = tests.uid('alice') and (n.data ->> 'k')::int = c.k;
select tests.eq((select count(*)::int from public.notifications where user_id = tests.uid('alice') and data ? 'k'), (select count(*)::int from cas), 'tous les cas vérifiés');
rollback;
