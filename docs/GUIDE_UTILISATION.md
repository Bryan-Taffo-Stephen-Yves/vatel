# Guide d'utilisation — Vatel Cantine

Site : **https://vatel-cantine.netlify.app** (sur ordinateur ou téléphone).

## Tester sans créer de compte

Sur la page d’accueil ou l’écran de connexion, toucher **« Tester l’app »** : les comptes de démo s’affichent et connectent en un clic.
Mot de passe commun des comptes de démo : `Dabali2026!` · code PIN des élèves de démo : `2580`.

| Bouton | Qui | À essayer |
|---|---|---|
| Client | Aya, élève (identifiant DB-2026) | Menu, réserver un plat, payer, QR, avis |
| Client 1 / Client 2 | Autres élèves | Suggestions, historique |
| Parent | Parent d'Aya | Recharger son enfant, suivre ses repas |
| Agent | Agent du comptoir | Scanner les QR |
| Caisse | Caissier | Recharges en espèces, bilan de caisse |
| Chef | Chef de cuisine | Commandes, Pilote du service, prévisions, stock, courses |
| Admin | Administration | Tout, plus l'équipe, les rapports, l'affluence et les réglages |

---

## 1. L'élève

**Créer son compte** : « Créer un compte », puis nom, e-mail, téléphone, mot de passe. Choisir ensuite un
**code PIN à 4 chiffres** : il sera demandé pour chaque dépense.

**Recharger son compte** (Accueil → Recharger)
1. Choisir le montant (toucher le montant pour le modifier).
2. Choisir l'opérateur : Wave, Orange Money, MTN MoMo, Moov Money ou Djamo.
3. Saisir le numéro qui paie, puis « Payer » : le total affiché comprend les frais Mobile Money (1,6 %).
4. Confirmer sur son téléphone. Le solde est crédité dès que Jèko confirme le paiement.
   On peut aussi recharger **en espèces à la caisse** en donnant son identifiant (ex. DB-2026).

**Voir le menu** (onglet Menu) : la semaine, repas par repas, avec photos, prix, calories et allergènes.
« Seulement ce qui me convient » cache les plats qui ne vont pas avec ses allergies et son régime
(à régler dans Profil → Allergies et régime).

**Acheter un ticket** (Accueil → Acheter) : choisir le repas (petit-déjeuner, déjeuner, snack, dîner) et le nombre de
tickets. Le plat se choisit au comptoir. On peut aussi **offrir** des tickets à quelqu'un.

**Commander un plat à l'avance** (Accueil → Commander à l'avance)
1. Choisir le jour, le repas, le ou les plats, et l'heure de retrait.
2. Confirmer avec son code PIN : le solde est débité et la cuisine reçoit la commande.
3. Les notifications suivent la commande : « en préparation », puis « prête ».
Sans réseau, la commande est gardée sur le téléphone et envoyée dès que la connexion revient.

**Retirer son repas** : onglet **Mon QR** (au centre en bas), présenter l'écran à l'agent du comptoir.
Le QR s'affiche même sans réseau.

**Autres écrans** : Historique (toutes les dépenses et recharges), Notifications, Transférer (envoyer de l'argent à un
autre élève, avec le PIN), Avis (noter le plat après le repas, avec une photo si on veut).

## 2. Jean, l'agent IA sur WhatsApp

Écrire à Jean sur WhatsApp, depuis le numéro enregistré dans son profil.
- Par écrit : « Mets-moi 2 alloco poulet pour 12h30 », « C'est quoi le menu ? », « Mon solde ».
- Ou en **note vocale**.
Jean récapitule et envoie un **lien de confirmation** : rien n'est commandé sans la confirmation de l'élève
(Face ID ou code PIN), et le lien n'est valable que 15 minutes. Jean tient compte des allergies et propose un autre plat
si besoin. Il prévient ensuite quand la commande est en préparation, puis prête.

## 3. Le parent

Menu **Ma famille** :
1. Saisir l'identifiant de l'enfant (ex. DB-2026, visible sur son profil) ; l'enfant accepte depuis son appli.
2. **Recharger son compte** en Mobile Money.
3. Voir ce qu'il mange, ce qu'il dépense, ses statistiques, et recevoir une **alerte de solde bas**.

## 4. L'agent du comptoir

Le compte Agent ouvre directement le **scanner**.
1. Choisir le service (petit-déjeuner, déjeuner, snack…).
2. Scanner le QR de l'élève :
   - **écran vert** : ticket valide, avec le nom, la photo, le dessert ou supplément déjà payé et les plats disponibles ;
   - **écran rouge « Déjà utilisé »** : le ticket a déjà servi, avec l'heure et le nom de l'agent qui l'a scanné.
3. Élève sans téléphone : bouton **« Sans téléphone »**, chercher son nom, il tape son PIN.

## 5. La caisse

- **Créditer un compte en espèces** : chercher l'élève (nom, téléphone ou identifiant DB-…), choisir le montant, « Créditer ».
- **Bilan de caisse** (aujourd'hui ou hier) : espèces à remettre, Mobile Money reçu, export CSV.

## 6. Le chef de cuisine

| Écran | À quoi il sert |
|---|---|
| Vue d'ensemble | Ventes du jour, repas servis, alertes (ruptures, risques de manquer) |
| **Commandes** | Les commandes du jour en colonnes : Reçues → « Je prépare » → En préparation → « Prête » → Prêtes. Les allergies sont en rouge. L'élève est notifié à chaque étape. |
| **Pilote du service** | Pendant le service : repas servis, file d'attente, consignes à faire maintenant (relancer un plat qui va manquer, appeler un renfort, relancer les élèves). On peut lui poser une question à voix haute. La carte **Rythme du comptoir** montre l'écart entre deux scans : un passage toutes les 10 à 30 s = forte affluence ; des écarts qui s'allongent = la file diminue. |
| Menu hebdo | Préparer et publier le menu de la semaine |
| Plats | Les fiches des plats : prix, photo, recettes, allergènes |
| Production | Combien préparer de chaque plat aujourd'hui (assistant IA) |
| Prévisions | Repas attendus des prochains jours et ingrédients nécessaires |
| Stock | Ingrédients, seuils d'alerte, durée de conservation des produits frais |
| **Courses** | La liste d'achats des 3 prochains jours, calculée par l'appli. Envoyée chaque jour à 15 h au chef et à l'admin ; bouton « Envoyer le point » et « Imprimer ». |
| Gaspillage | Ce qui reste dans les assiettes (photos analysées), plat par plat |
| Avis | Les notes et commentaires des élèves, les plaintes |
| Rapports | Rapport d'activité à imprimer ou exporter (PDF, CSV) |

## 7. L'administrateur

Tout ce que voit le chef, plus :
- **Caisse**, **Ventes** et **Rapports** : chiffre d'affaires, recharges, heures de pointe, export CSV.
- **Équipe** : ajouter un membre (agent, caisse, chef, admin), le bloquer, consulter le journal des actions.
- **Paramètres** : horaires et prix des repas, validité des tickets, jours de service, sécurité.
- **Affluence** (caméra) :
  1. Fixer un téléphone en hauteur dans la salle, ouvrir `/scan/camera` (compte Agent ou Admin) et toucher **Démarrer**.
  2. Sur l'ordinateur, page Affluence : **Demander une photo**, puis tracer à la souris un rectangle par table
     (avec ses chaises) et la file d'attente. Enregistrer.
  3. Le téléphone compte alors les tables occupées et la file. Il ne reconnaît personne, n'envoie que des chiffres,
     et la photo de réglage est effacée sous 24 h. Caméra éteinte : l'affluence est estimée avec les plateaux.
  4. Sans caméra, la carte **Rythme du comptoir** lit l'affluence dans les scans de l'agent : un QR scanné toutes
     les 10 à 30 secondes, c'est beaucoup de monde ; quand l'écart entre deux scans s'allonge, la file diminue.

## Sécurité, en bref

- Un paiement n'est crédité qu'après la confirmation signée de Jèko.
- Chaque dépense demande le code PIN (3 erreurs : blocage 15 minutes).
- Un QR ne sert qu'une fois, même scanné sur plusieurs téléphones en même temps.
- Chaque rôle ne voit que ce qui le concerne.
