/* eslint-disable @next/next/no-img-element, react/no-unescaped-entities -- page statique : images servies telles quelles, apostrophes françaises */
import Link from "next/link";
import { ChefArt } from "@/components/chef";
import type { ChefWho } from "@/lib/chefs-svg";

/**
 * Page d'accueil publique de Vatel Cantine (visiteurs non connectés).
 * Même construction que la landing de Mon Jeton : grand titre en capitales avec un mot surligné, téléphone incliné
 * sur un fond en arche, bandeau des moyens de paiement, blocs « 01 / … » qui alternent texte et écran, « Pour qui ? »,
 * FAQ, appel final et grand mot-symbole en pied de page. Couleurs Vatel (noir, bleu) et vraies captures de l'appli.
 */

const DEMO = "/connexion?demo=1";

function Phone({ src, alt, tilt = 0, className = "" }: { src: string; alt: string; tilt?: number; className?: string }) {
  return (
    <div className={`relative w-[270px] shrink-0 rounded-[44px] bg-[#2a2e33] p-2 shadow-[0_0_0_1px_#4a5058,inset_0_0_0_3px_#757b84,0_26px_38px_-10px_#000a] sm:w-[300px] ${className}`}
      style={{ transform: `rotate(${tilt}deg)` }}>
      <div className="overflow-hidden rounded-[36px] border border-black bg-[#f6f7f9]">
        <img src={src} alt={alt} width={640} height={1090} loading="lazy" decoding="async" className="block h-auto w-full" />
      </div>
    </div>
  );
}

function Laptop({ src, alt }: { src: string; alt: string }) {
  return (
    <div className="w-full max-w-[640px] overflow-hidden rounded-2xl border border-[#2a3340] bg-[#0b0f14] shadow-[0_30px_60px_-20px_#000c]">
      <div className="flex items-center gap-1.5 border-b border-[#202833] px-4 py-2.5">
        <span className="size-2.5 rounded-full bg-[#ff5f57]" /><span className="size-2.5 rounded-full bg-[#febc2e]" /><span className="size-2.5 rounded-full bg-[#28c840]" />
        <span className="ml-3 truncate text-[11px] text-[#8b98a8]">vatel-cantine.netlify.app/admin</span>
      </div>
      <img src={src} alt={alt} width={1440} height={900} loading="lazy" decoding="async" className="block h-auto w-full" />
    </div>
  );
}

const Mark = ({ children }: { children: React.ReactNode }) => (
  <mark className="rounded-[10px] bg-[#53b5fd] px-[.15em] pb-[.06em] text-[#06121c] [box-decoration-break:clone]">{children}</mark>
);

function Tag({ children }: { children: React.ReactNode }) {
  return <span className="mb-6 inline-block rounded-full border border-[#2f5878] bg-[#10263a] px-3 py-1.5 text-[11px] font-bold tracking-wide text-[#95d1f7]">{children}</span>;
}

function Benefits({ items }: { items: string[] }) {
  return (
    <ul className="mt-6 space-y-3 text-[15px] text-[#c9d4de]">
      {items.map((i) => (
        <li key={i} className="relative pl-9">
          <span aria-hidden className="absolute left-0 top-0.5 grid size-6 place-items-center rounded-full border border-[#3b8fd0] text-sm text-[#53b5fd]">✓</span>{i}
        </li>
      ))}
    </ul>
  );
}

type Show = { id: string; tag: string; title: React.ReactNode; text: string; items: string[]; img: string; alt: string; float: [string, string]; who: ChefWho; laptop?: boolean };
const SHOWS: Show[] = [
  { id: "menu", tag: "01 / Le menu et l'IA", title: <>LE MENU DE LA SEMAINE,<br /> <Mark>CHOISI POUR TOI.</Mark></>,
    text: "Les plats des 7 prochains jours en photos, avec les calories, les notes des élèves et les allergènes. L'IA propose chaque jour les plats qui te ressemblent.",
    items: ["4 services : petit-déjeuner, déjeuner, snack, dîner", "Allergies et régime signalés sur chaque plat", "Suggestions personnalisées « Pour toi »"],
    img: "/landing/eleve-menu.webp", alt: "Écran Menu de l'appli Vatel : plats du lundi avec photo, note et bouton Réserver", float: ["Populaire", "4,4 ★ · 199 avis"], who: "cupcakes" },
  { id: "reserver", tag: "02 / Réserver", title: <>CHOISIS TON PLAT,<br /> <Mark>ON LE PRÉPARE.</Mark></>,
    text: "Réserve ton plat jusqu'à 7 jours à l'avance, choisis ton heure de retrait et paie avec ton solde. La cuisine prépare, tu passes le prendre.",
    items: ["Plusieurs plats, entrée ou dessert en option", "Heure de retrait au quart d'heure", "Annulation remboursée jusqu'à l'heure limite"],
    img: "/landing/eleve-reserver.webp", alt: "Écran Commander : choix du jour, du repas, du plat et de l'heure de retrait", float: ["Retrait 11h30", "2 500 FCFA"], who: "louche" },
  { id: "qr", tag: "03 / Le QR", title: <>PRÉSENTE TON QR,<br /> <Mark>C'EST SERVI.</Mark></>,
    text: "Au comptoir, l'agent scanne ton QR : il voit ta photo et ton plat, et le QR ne sert qu'une fois. Ton téléphone est déchargé ? Ton code et ton PIN suffisent.",
    items: ["QR signé, impossible à recopier", "Fonctionne même sans réseau", "Payer demande ton PIN ou Face ID"],
    img: "/landing/eleve-qr.webp", alt: "Écran Ma commande avec le QR à présenter au comptoir", float: ["Commande n° 4", "Valide · lundi 11h30"], who: "chef" },
  { id: "parents", tag: "04 / Les parents", title: <>RECHARGE À DISTANCE,<br /> <Mark>SUIS SES REPAS.</Mark></>,
    text: "Le parent recharge le compte de son enfant par Wave, Orange Money, MTN ou Moov, voit ce qu'il mange et reçoit une alerte quand le solde baisse.",
    items: ["Seul le numéro enregistré par l'école peut suivre l'élève", "L'enfant est prévenu de chaque recharge", "Repas, dépenses et jours de présence"],
    img: "/landing/parent-accueil.webp", alt: "Accueil du compte parent : solde d'Aya, bouton Recharger Aya, repas de la semaine", float: ["Recharge reçue", "+5 000 FCFA"], who: "fouet" },
  { id: "cuisine", tag: "05 / La cuisine et l'administration", title: <>MOINS DE RESTES,<br /> <Mark>PLUS DE GOÛT.</Mark></>,
    text: "Les avis et les photos d'assiettes rendues nourrissent les prévisions : la cuisine sait combien préparer, quoi acheter, et quels plats revoir. Le lundi, le rapport de la semaine arrive tout seul.",
    items: ["Menus de la semaine proposés par l'IA, validés par le chef", "Courses calculées, frais acheté juste pour ses jours", "Rapports, stock, caisse, personnel et invités"],
    img: "/landing/admin-semaine.webp", alt: "Rapport de la semaine : plats à garder, plats à revoir, satisfaction et part laissée", float: ["Restes", "13 % → 8,5 %"], who: "chef", laptop: true },
];

const AUDIENCES: { who: ChefWho; title: string; text: string }[] = [
  { who: "cupcakes", title: "Élèves", text: "Réserver, payer sans espèces et manger sans faire la queue, même sans réseau." },
  { who: "fouet", title: "Parents", text: "Recharger à distance, suivre les repas et recevoir les alertes de solde." },
  { who: "louche", title: "Personnel", text: "Repas subventionné par l'école avec une carte QR, même sans smartphone." },
  { who: "chef", title: "Cuisine et administration", text: "Prévoir juste, acheter juste, suivre la caisse et les rapports." },
];

const FIGURES: [string, string][] = [
  ["7 jours", "pour réserver son plat à l'avance"],
  ["4 services", "petit-déjeuner, déjeuner, snack, dîner"],
  ["1 500 F", "payés par l'école sur chaque repas du personnel"],
  ["0 espèce", "Mobile Money, solde prépayé et QR"],
];

const FAQ: [string, string][] = [
  ["Comment essayer l'appli ?", "Touchez « Tester l'app » et choisissez un rôle (élève, parent, agent, chef, caisse, administration) : vous entrez directement dans son espace, avec des données de démonstration."],
  ["Comment je paie mes repas ?", "Vous rechargez votre compte cantine par Wave, Orange Money, MTN MoMo ou Moov Money, ou en espèces à la caisse. Chaque repas est ensuite payé avec ce solde, confirmé par votre PIN ou Face ID."],
  ["Et si je n'ai pas de réseau au comptoir ?", "Votre QR reste dans le téléphone et marche hors ligne. Sans téléphone, l'agent vous retrouve par votre nom ou votre code et vous tapez votre PIN."],
  ["Quelqu'un peut-il manger à ma place ?", "Non : le QR est signé et ne sert qu'une fois, l'agent voit votre photo, et payer demande votre PIN ou Face ID."],
  ["Mes allergies sont-elles prises en compte ?", "Oui. Indiquez-les dans votre profil : les plats concernés sont signalés dans le menu, et un plat dangereux pour une allergie grave ne peut pas être commandé."],
  ["Faut-il installer une appli ?", "Non, elle s'ouvre dans le navigateur. Vous pouvez l'ajouter à l'écran d'accueil de votre iPhone ou Android pour l'ouvrir comme une appli."],
];

export function Landing() {
  return (
    <div className="min-h-dvh overflow-x-hidden bg-[#0d0d0c] text-[#eef3f7] [font-feature-settings:'ss01']">
      {/* En-tête */}
      <header className="sticky top-0 z-40 border-b border-[#1f252c] bg-[#0d0d0c]/90 backdrop-blur pt-[env(safe-area-inset-top)]">
        <div className="mx-auto flex max-w-6xl items-center gap-4 px-4 py-3 sm:px-6">
          <Link href="/" className="flex items-center gap-2.5 font-extrabold tracking-tight" aria-label="Vatel Cantine, accueil">
            <img src="/brand/vatel-mark-96.png" width={40} height={40} alt="" className="size-10 rounded-full bg-white" />
            <span className="text-lg">Vatel<span className="text-[#53b5fd]">.</span></span>
          </Link>
          <nav aria-label="Navigation principale" className="ml-6 hidden gap-1 text-sm font-semibold text-[#aebbc8] md:flex">
            <a href="#fonctionnalites" className="rounded-full px-3 py-1.5 hover:bg-[#1a2027] hover:text-white">Fonctionnalités</a>
            <a href="#pour-qui" className="rounded-full px-3 py-1.5 hover:bg-[#1a2027] hover:text-white">Pour qui ?</a>
            <a href="#faq" className="rounded-full px-3 py-1.5 hover:bg-[#1a2027] hover:text-white">Questions</a>
          </nav>
          <div className="ml-auto flex items-center gap-2">
            <Link href="/connexion" className="hidden rounded-[9px] px-3 py-2 text-sm font-bold text-[#cfd9e2] hover:text-white sm:block">Se connecter</Link>
            <Link href={DEMO} className="rounded-[9px] bg-[#53b5fd] px-4 py-2.5 text-sm font-extrabold text-[#06121c] hover:brightness-110">Tester l'app ↗</Link>
          </div>
        </div>
      </header>

      <main id="contenu">
        {/* Hero */}
        <section className="mx-auto grid max-w-6xl items-center gap-12 px-4 pb-16 pt-12 sm:px-6 lg:grid-cols-[1.05fr_1fr] lg:pb-20 lg:pt-16">
          <div className="text-center lg:text-left">
            <h1 className="flex flex-col items-center gap-1 text-[clamp(44px,6vw,78px)] font-extrabold leading-[1.04] tracking-[-0.055em] lg:items-start">
              <span>RÉSERVEZ VOTRE</span>
              <span><Mark>PLAT,</Mark></span>
              <span className="text-transparent [-webkit-text-stroke:1.8px_#6f8396]">PAYEZ,</span>
              <span><b className="inline-block rounded-[15px] border border-[#2f6a96] px-[.18em] pb-[.05em] font-extrabold leading-none text-[#53b5fd]">MANGEZ.</b></span>
            </h1>
            <p className="mx-auto mt-7 max-w-[520px] text-base leading-[1.8] text-[#aebbc8] lg:mx-0">
              Vatel Cantine, c'est la cantine de l'école dans le téléphone : le menu de la semaine, le plat réservé à l'heure choisie, le paiement par Mobile Money et un QR au comptoir. Pour les élèves, les parents, le personnel et la cuisine.
            </p>
            <div className="mt-8 flex flex-wrap items-center justify-center gap-3 lg:justify-start">
              <Link href={DEMO} className="inline-flex min-h-14 items-center gap-3 rounded-[9px] bg-[#53b5fd] px-6 text-[15px] font-extrabold text-[#06121c] hover:brightness-110">Tester l'app ↗</Link>
              <Link href="/connexion" className="inline-flex min-h-14 items-center rounded-[9px] border border-[#2f3a46] px-6 text-[15px] font-bold hover:border-[#53b5fd]">Se connecter</Link>
              <a href="#fonctionnalites" className="px-2 text-sm font-bold text-[#95d1f7] underline-offset-4 hover:underline">▶ Voir les écrans</a>
            </div>
            <p className="mt-6 text-sm text-[#8696a6]">Sans créer de compte · élève, parent, agent, chef, caisse ou administration</p>
          </div>

          {/* Scène : arche bleue, mot vertical, téléphone incliné, mascotte */}
          <div className="relative mx-auto h-[600px] w-full max-w-[520px] sm:h-[660px]">
            <div aria-hidden className="absolute inset-x-2 bottom-4 top-6 overflow-hidden rounded-[130px_130px_14px_14px] bg-[#dcefff] sm:left-14">
              <span className="absolute -right-6 top-28 rotate-90 text-[150px] font-extrabold leading-[.76] tracking-[-0.09em] text-[#9fd2fb] opacity-80">vatel.</span>
            </div>
            <span aria-hidden className="absolute left-4 top-0 z-10 hidden text-[11px] sm:block font-extrabold leading-tight tracking-wide text-[#95d1f7] sm:left-16">BON REPAS.<br /> BONNE AMBIANCE.</span>
            <div className="absolute right-1/2 top-3 z-20 translate-x-1/2 sm:right-10 sm:translate-x-0">
              <Phone src="/landing/eleve-aujourdhui.webp" alt="Accueil élève de l'appli Vatel : solde, commande à l'avance et suggestions de l'IA" tilt={4} />
            </div>
            <div aria-hidden className="absolute bottom-4 left-0 z-30 hidden h-[330px] sm:block"><ChefArt who="chef" mood="happy" /></div>
            <div className="absolute bottom-8 right-2 z-30 rotate-[-3deg] rounded-xl border border-[#d7e3ee] bg-white px-4 py-3 text-[#0d0d0c] shadow-[0_10px_22px_#0003] sm:right-0">
              <p className="text-[11px] font-bold text-[#5d6673]">Pour toi · Déjeuner</p>
              <p className="text-sm font-extrabold">Spaghetti sautés · 1 500 F</p>
            </div>
          </div>
        </section>

        {/* Moyens de paiement */}
        <section aria-labelledby="paiement" className="border-y border-[#d9e2ea] bg-[#f2f6f9] text-[#0d0d0c]">
          <div className="mx-auto flex max-w-6xl flex-col items-center gap-6 px-4 py-8 sm:px-6 md:flex-row md:justify-between">
            <h2 id="paiement" className="text-center text-sm font-extrabold tracking-wide md:text-left">RECHARGEZ AVEC VOS MOYENS DE PAIEMENT<br /><span className="font-semibold text-[#5d6673]">via Jèko, paiement sécurisé</span></h2>
            <ul className="flex flex-wrap items-center justify-center gap-x-8 gap-y-4" aria-label="Moyens de paiement acceptés">
              <li className="rounded-lg bg-[#1dc8ff1a] px-2 py-1"><img src="/landing/pay/wave.png" width={117} height={38} alt="Wave" className="h-8 w-auto" /></li>
              <li className="flex items-center gap-2 font-extrabold"><img src="/landing/pay/orange.svg" width={36} height={36} alt="" className="size-9" /><span>Orange Money</span></li>
              <li className="flex items-center gap-1 font-extrabold"><img src="/landing/pay/mtn.svg" width={68} height={38} alt="MTN" className="h-8 w-auto" /><span>MoMo</span></li>
              <li className="rounded-lg bg-[#0b3a8f] px-2 py-1"><img src="/landing/pay/moov.png" width={108} height={51} alt="Moov Money" className="h-9 w-auto" /></li>
            </ul>
          </div>
        </section>

        {/* Blocs fonctionnalités (alternés) */}
        <div id="fonctionnalites">
          {SHOWS.map((s, i) => (
            <section key={s.id} id={s.id} className={i % 2 ? "bg-[#0b1824]" : "bg-[#0d0d0c]"}>
              <div className={`mx-auto grid max-w-6xl items-center gap-12 px-4 py-20 sm:px-6 lg:min-h-[640px] lg:gap-20 ${s.laptop ? "lg:grid-cols-[0.9fr_1.1fr]" : "lg:grid-cols-[1.08fr_1fr]"}`}>
                <div className={`min-w-0 ${i % 2 ? "lg:order-2" : ""}`}>
                  <Tag>{s.tag}</Tag>
                  <h2 className="text-[clamp(30px,3.5vw,48px)] font-extrabold leading-[1.24] tracking-[-0.05em]">{s.title}</h2>
                  <p className="mt-5 max-w-[520px] text-base leading-[1.8] text-[#aebbc8]">{s.text}</p>
                  <Benefits items={s.items} />
                </div>
                <div className={`relative flex min-w-0 justify-center py-6 ${i % 2 ? "lg:order-1" : ""}`}>
                  <div aria-hidden className={`absolute inset-y-6 -z-0 rounded-[130px_130px_17px_17px] ${i % 2 ? "bg-[#10263a]" : "bg-[#132131]"} ${s.laptop ? "inset-x-0" : "left-1/2 w-[340px] -translate-x-1/2"}`} />
                  <div className="relative z-10">{s.laptop ? <Laptop src={s.img} alt={s.alt} /> : <Phone src={s.img} alt={s.alt} tilt={i % 2 ? -3 : 3} />}</div>
                  {!s.laptop && <div aria-hidden className={`absolute bottom-4 z-20 hidden h-[260px] lg:block ${i % 2 ? "-right-4" : "-left-4"}`}><ChefArt who={s.who} mood="happy" /></div>}
                  <div className={`absolute top-16 z-30 flex rotate-[-3deg] flex-col rounded-xl border border-[#dfe8f0] bg-[#f4f8fb] px-4 py-2.5 text-[#0d0d0c] shadow-[0_10px_22px_#0004] ${i % 2 ? "left-0" : "right-0"}`}>
                    <span className="text-[11px] font-bold text-[#5d6673]">{s.float[0]}</span><strong className="text-sm">{s.float[1]}</strong>
                  </div>
                </div>
              </div>
            </section>
          ))}
        </div>

        {/* Pour qui ? */}
        <section id="pour-qui" className="mx-auto max-w-6xl px-4 py-20 sm:px-6">
          <div className="mx-auto max-w-2xl text-center">
            <Tag>Pour qui ?</Tag>
            <h2 className="text-[clamp(30px,3.5vw,48px)] font-extrabold leading-[1.24] tracking-[-0.05em]">PENSÉE POUR <Mark>TOUTE L'ÉCOLE.</Mark></h2>
            <p className="mt-4 text-[#aebbc8]">Une seule appli, et chacun y trouve ce qu'il lui faut.</p>
          </div>
          <div className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
            {AUDIENCES.map((a) => (
              <article key={a.title} className="rounded-2xl border border-[#1f2a35] bg-[#111820] p-5">
                <div aria-hidden className="mx-auto flex h-[190px] justify-center rounded-[90px_90px_12px_12px] bg-[#dcefff] pt-3"><ChefArt who={a.who} mood="happy" anim={false} /></div>
                <h3 className="mt-5 text-lg font-extrabold tracking-tight">{a.title}</h3>
                <p className="mt-1.5 text-sm leading-relaxed text-[#aebbc8]">{a.text}</p>
              </article>
            ))}
          </div>
          <div className="mt-10 flex flex-col gap-3 border-y border-[#1f2a35] py-7 sm:flex-row sm:items-center sm:gap-5">
            <span aria-hidden className="text-2xl">🔒</span>
            <p className="text-sm text-[#aebbc8]"><strong className="text-[#e6eef5]">Votre argent est en sécurité.</strong> Paiements confirmés par Jèko, chaque franc tracé, PIN ou Face ID pour payer.</p>
            <span className="text-[11px] font-bold tracking-widest text-[#6f8396] sm:ml-auto">PENSÉE EN FCFA. PENSÉE POUR VATEL.</span>
          </div>
        </section>

        {/* En chiffres (à la place de témoignages) */}
        <section className="bg-[#f2f6f9] text-[#0d0d0c]">
          <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
            <h2 className="text-center text-[clamp(28px,3vw,42px)] font-extrabold tracking-[-0.05em]">LA CANTINE, <Mark>SANS ATTENDRE.</Mark></h2>
            <dl className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {FIGURES.map(([n, l]) => (
                <div key={n} className="rounded-2xl border border-[#d9e2ea] bg-white p-6">
                  <dt className="text-[34px] font-extrabold leading-none tracking-[-0.04em]">{n}</dt>
                  <dd className="mt-2 text-sm text-[#5d6673]">{l}</dd>
                </div>
              ))}
            </dl>
          </div>
        </section>

        {/* FAQ */}
        <section id="faq" className="mx-auto grid max-w-6xl gap-10 px-4 py-20 sm:px-6 lg:grid-cols-[0.8fr_1.2fr]">
          <div>
            <span className="text-[11px] font-bold tracking-widest text-[#95d1f7]">ON VOUS RÉPOND</span>
            <h2 className="mt-3 text-[clamp(28px,3vw,40px)] font-extrabold leading-tight tracking-[-0.05em]">Bien commencer,<br /> ça commence ici.</h2>
          </div>
          <div className="divide-y divide-[#1f2a35] border-y border-[#1f2a35]">
            {FAQ.map(([q, a]) => (
              <details key={q} className="group py-4">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-4 font-bold">{q}<span aria-hidden className="text-xl text-[#53b5fd] transition group-open:rotate-45">+</span></summary>
                <p className="mt-3 text-[15px] leading-relaxed text-[#aebbc8]">{a}</p>
              </details>
            ))}
          </div>
        </section>

        {/* Appel final */}
        <section className="mx-auto flex max-w-6xl flex-col gap-8 px-4 py-16 sm:px-6 md:flex-row md:items-center md:justify-between">
          <div>
            <span className="text-[11px] font-bold tracking-widest text-[#95d1f7]">BON REPAS. BONNE AMBIANCE.</span>
            <h2 className="mt-4 text-[clamp(36px,5vw,64px)] font-extrabold leading-[1.15] tracking-[-0.06em]">PRÊT À MANGER<br /> <span className="text-[#53b5fd]">SANS ATTENDRE ?</span></h2>
            <p className="mt-3 text-sm text-[#aebbc8]">Choisissez un rôle et découvrez l'appli en une minute.</p>
          </div>
          <Link href={DEMO} className="inline-flex min-h-14 items-center justify-center gap-3 self-start rounded-[9px] bg-[#53b5fd] px-7 text-[15px] font-extrabold text-[#06121c] hover:brightness-110 md:self-auto">Tester l'app ↗</Link>
        </section>

        {/* Pied de page */}
        <footer className="mx-auto max-w-6xl overflow-hidden px-4 pb-[max(0px,env(safe-area-inset-bottom))] pt-8 sm:px-6">
          <div className="flex flex-col gap-4 border-t border-[#1f2a35] pt-8 sm:flex-row sm:items-center sm:justify-between">
            <span className="flex items-center gap-2.5 font-extrabold">
                <img src="/brand/vatel-mark-96.png" width={36} height={36} alt="" className="size-9 rounded-full bg-white" /><span>Vatel Cantine<span className="text-[#53b5fd]">.</span></span>
            </span>
            <div className="flex flex-wrap gap-5 text-sm text-[#aebbc8]">
              <a href="#fonctionnalites" className="hover:text-white">L'application</a>
              <Link href={DEMO} className="hover:text-white">Tester l'app</Link>
              <Link href="/connexion" className="hover:text-white">Se connecter</Link>
              <Link href="/inscription" className="hover:text-white">Créer un compte</Link>
            </div>
          </div>
          <p className="mt-6 text-xs text-[#6f8396]">© 2026 Vatel Cantine · Abidjan, Côte d'Ivoire.</p>
          <div aria-hidden className="mt-2 -mb-3 whitespace-nowrap text-center text-[clamp(80px,19vw,240px)] font-extrabold leading-none tracking-[-0.09em] text-[#16222d]">vatel<span className="text-[#53b5fd]">.</span></div>
        </footer>
      </main>
    </div>
  );
}
