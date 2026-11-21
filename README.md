# Vatel — la cantine connectée

Application complète de gestion de cantine pour l'école hôtelière **Vatel Abidjan** : porte-monnaie prépayé,
réservation et commande de plats, tickets QR, suivi parent, cuisine pilotée par les données et agents IA
(WhatsApp, téléphone, achats fournisseurs). Hackathon « Cantine de Vatel » — novembre 2026.

> **Démo en ligne : https://vatel-cantine.netlify.app** (installable sur téléphone : PWA)
> **Guide d'utilisation, rôle par rôle : [docs/GUIDE_UTILISATION.md](docs/GUIDE_UTILISATION.md)**
> Cahier des charges détaillé : [docs/CAHIER_DES_CHARGES.md](docs/CAHIER_DES_CHARGES.md) · Retours d'expérience : [docs/RETEX.md](docs/RETEX.md)

> **Comment ce dépôt a été construit.** Application préparée à partir du cahier des charges reçu en amont, comme
> prévu par l'organisation. Le code a été remis ici le jour du concours en 14 blocs thématiques (un commit par bloc,
> heure réelle). Le travail de la journée suit en commits normaux. Développé avec l'aide de l'IA (Claude), autorisée
> par le règlement.

## Les problèmes et nos réponses

| Problème du sujet | Réponse dans Vatel Cantine |
|---|---|
| Longues files d'attente | Achat et **commande à l'avance avec heure de retrait** ; QR scanné en 1 s au comptoir ; affluence du réfectoire en direct |
| Gaspillage faute de planification | **Prévisions** par plat (popularité, historique) + **guide de production** du chef (portions, reprises, ingrédients, restes saisis qui font apprendre le système) |
| Régimes et allergies | Allergies et régime dans le profil ; plats incompatibles **signalés** (menu, fiche, commande) ou **masqués** ; suggestions IA compatibles |
| Manque de transparence menus / tarifs | Menu de la semaine illustré, prix, composition, calories, allergènes, notes des élèves |
| Gestion manuelle fastidieuse | Tableau de bord, menus, stock, courses automatiques, **rapports d'activité** (PDF / CSV), agents IA qui commandent et appellent les fournisseurs |

## Fonctionnalités du guide

**Minimum requis — tout est fait**

| Exigence | Où |
|---|---|
| Inscription et connexion | `/inscription`, `/connexion` (+ Face ID, double authentification pour l'équipe) |
| Consultation du menu de la semaine | `/app/menu` (8 jours, par repas, ruptures en direct) |
| Réservation d'un repas | Tickets par repas `/app/acheter` · commande d'un plat à heure de retrait `/app/commander` (plusieurs plats, suppléments) |
| Solde et historique | Accueil (solde en direct) · `/app/historique` |
| Création / modification des menus | `/admin/menu` (semaine, soumission, publication) · `/admin/plats` |
| Commandes du jour | `/admin/commandes` (écran cuisine : reçue → en préparation → prête) |
| Tableau de bord et statistiques | `/admin` · `/admin/ventes` · `/admin/rapports` |

**Utilisateurs**

| Profil | Ce qu'il peut faire |
|---|---|
| Élève / employé | Menu, réservation, paiement sans espèces (porte-monnaie, Mobile Money), QR, allergies et régime, avis, fidélité, transfert, cadeaux |
| Parent | `/app/famille` : lier le compte de son enfant (l'enfant accepte), le **recharger en ligne**, voir **ce qu'il mange**, **alerte de solde bas** |
| Administrateur / chef | Menus à l'avance, **nombre de repas à préparer** (prévisions + production), **stock et ruptures**, **rapports d'activité** |

**Bonus — tous présents**

| Bonus | Où |
|---|---|
| Notation des plats | Avis 30 min après le repas, plaintes en un clic, réponse du chef |
| Suggestions personnalisées (IA) | Carte « Pour toi » sur l'accueil (Claude : goûts, notes, allergies, régime, solde) |
| Multi-langue | Français / anglais (bouton FR / EN : connexion, profil) |
| Application mobile | PWA installable (Android / iOS), Face ID |
| Mobile Money (Wave, Orange Money, MTN, Moov, Djamo) | Recharge et recharge parent en vrai via Jèko (frais de 1,6 % affichés et payés par l'élève) |
| Notifications push temps réel | Web Push + notifications dans l'appli + WhatsApp |
| Mode hors ligne | QR et menu disponibles sans réseau |

**En plus (innovation)**

- **Jean, agent IA sur WhatsApp** : menu, solde, commande en langage naturel (« 4 alloco et 1 riz pour 18h ») ou note vocale, confirmation Face ID / PIN.
- **Jean au téléphone** (Retell) : commander par appel.
- **Agent qui appelle les fournisseurs** : négocie avec le carnet de prix, règles de décision dans le code, accent ivoirien (`/admin/appels`).
- **Tournée d'achats suivie en direct** : carte, arrêts, liste modifiable depuis le groupe WhatsApp (`/admin/livraisons`, `/suivi/…`).

## Architecture

- **Front** : Next.js 15 (React 19) + Tailwind CSS 4, PWA (service worker, hors ligne), hébergé sur Netlify.
- **Back** : Supabase — PostgreSQL (RLS sur toutes les tables, fonctions SQL transactionnelles `SECURITY DEFINER`), Auth, Realtime, Storage, pg_cron, Edge Functions (Deno).
- **IA** : Claude (Anthropic) pour les briefs du chef, suggestions, Jean (WhatsApp / téléphone) ; Retell (voix) ; ElevenLabs (notes vocales) ; Green API (WhatsApp) ; OSRM / OpenStreetMap (itinéraires).
- **Sécurité** : l'argent ne bouge que par des fonctions SQL vérifiées ; QR signés (HMAC) à usage unique ; PIN haché + blocage ; aucune clé dans le code (secrets Supabase).
- **Tests** : `supabase/tests/` (plus de 450 vérifications SQL, QR et concurrence).

## Comptes de démo

Mot de passe commun : **`Dabali2026!`** — boutons « Comptes de démo » sur l'écran de connexion.

| Rôle | E-mail | Remarque |
|---|---|---|
| Client | `client@dabali.ci` | Aya Konan · identifiant **DB-2026** · PIN **2580** · 12 points |
| Agent | `agent@dabali.ci` | ouvre directement `/scan` · bouton « Sans téléphone » : chercher « Aya », PIN 2580 |
| Caisse | `caisse@dabali.ci` | |
| Chef | `chef@dabali.ci` | |
| Admin | `admin@dabali.ci` | accès à tout |
| 29 autres clients | `client01@dabali.ci` … `client29@dabali.ci` | PIN **2580** aussi |

## Lancer en local

```bash
npm install
npm run dev
```

L'appli pointe par défaut sur le projet Supabase `punghxwtknejxkedaoty` (URL + clé anon publiques dans
`src/lib/config.ts`, surchargeables via `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY`).
La caméra (`/scan`) exige HTTPS sur téléphone : tester via le site déployé ou un tunnel HTTPS.

## Base de données

Migrations dans `supabase/migrations/` (déjà appliquées sur le projet), seed dans `supabase/seed.sql`.

```bash
npx supabase link --project-ref punghxwtknejxkedaoty
npx supabase db push
npx supabase functions deploy ticket-token
npx supabase functions deploy redeem-ticket
```

**Signature des QR** : les Edge Functions utilisent `QR_HMAC_SECRET` s'il est défini
(`npx supabase secrets set QR_HMAC_SECRET="$(openssl rand -base64 48)"`), sinon une clé dérivée de la clé
`service_role`, injectée par Supabase côté serveur uniquement. Changer la clé invalide les QR en cache.

### Tests

Postgres ≥ 15 et Node ≥ 22.18 suffisent (les tests simulent `auth.uid()` et les rôles Supabase) :

```bash
PGHOST=localhost PGUSER=postgres supabase/tests/run.sh      # 191 vérifications SQL + QR + concurrence
SUPABASE_URL=… SUPABASE_ANON_KEY=… scripts/smoke-remote.sh  # API bout en bout (consomme un ticket de démo)
BASE=https://vatel-cantine.netlify.app SCAN_DATE=AAAA-MM-JJ node scripts/e2e-deployed.js  # parcours complet dans un navigateur sur le site en ligne
python -m pytest vision/ -q                                 # module vision
```

| Critère §12 | Vérifié par |
|---|---|
| 2e scan refusé, même sur 10 scanners simultanés | `30_tickets_redeem.sql`, `concurrency.sh`, `smoke-remote.sh` |
| QR modifié à la main refusé | `qr.test.ts` (chaque caractère), `smoke-remote.sh` |
| Solde jamais négatif ; somme des transactions = solde | `tests.check_ledger()`, achats concurrents, seed |
| PIN faux refusé ; 3 PIN faux → blocage 15 min | `20_transfer_pin.sql`, `concurrency.sh` |
| Plat épuisé grisé sans recharger | mesuré : 0,3 s entre la rupture en base et le plat grisé dans l'appli (Realtime) |
| Ticket non utilisé → rouge après son service | `30_tickets_redeem.sql` + affichage immédiat côté appli |
| QR affiché en mode avion | test Playwright hors ligne (service worker + cache local des jetons) |
| Menu non soumis mercredi 23h59 → alerte admin | `40_menu_rls.sql` (cron horaire) |
| Aucune image écrite par le module vision | `vision/test_occupancy.py` |
| PWA installable, utilisable en 360 px | manifeste + icônes + service worker ; maquettes testées au format Pixel 7 |

## Module vision (affluence)

```bash
cd vision
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env            # SUPABASE_SERVICE_ROLE_KEY + ROOM_ID (select id from rooms)
python calibrate.py --source demo.mp4      # cliquer les coins de chaque table → zones.json
python occupancy.py --source demo.mp4 --preview
```

Sources acceptées : webcam (`0`), fichier vidéo, flux RTSP, ou téléphone Android avec *IP Webcam*
(`http://IP:8080/video`). Une image analysée toutes les 2 s, un relevé envoyé toutes les 10 s. Sans relevé
depuis 2 minutes, l'appli bascule sur une estimation à partir du rythme des scans.

**Rythme du comptoir** (`_scan_rhythm`, écrans Pilote du service et Affluence) : l'écart entre deux scans de l'agent
mesure l'affluence sans caméra. Un QR scanné toutes les 10 à 30 s = forte affluence ; des écarts qui s'allongent = la
file diminue. Le Pilote propose un renfort quand le comptoir est sous pression et que la caméra ne voit pas la file.

## Variables d'environnement

Voir [.env.example](.env.example) et [vision/.env.example](vision/.env.example).
La clé `service_role` ne doit **jamais** être exposée au navigateur (pas de préfixe `NEXT_PUBLIC_`).

## Règles pour le code front

- Aucune écriture dans `wallets`, `transactions`, `tickets` : uniquement les RPC (`rpc(...)` dans `src/lib/supabase/client.ts`).
- Les RPC renvoient `{ ok: true, … }` ou `{ ok: false, code, message }` : afficher `message` (déjà en français).
- `tickets` et `profiles` ont des droits par colonne : lister les colonnes, pas de `select('*')`.

## Phase 2 (hors hackathon)

OTP SMS, scanner hors ligne avec file de synchronisation, planning des équipes,
multi-établissements, notifications push (table `push_subscriptions` prête).
