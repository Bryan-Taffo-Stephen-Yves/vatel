"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { nextFromUrl } from "@/lib/next-path";
import { supabase } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Sheet } from "@/components/ui/sheet";
import { homeFor } from "@/lib/roles";

import { LangSwitch, useT } from "@/lib/i18n";

// « Tester l'app » : un compte de démonstration par rôle, chacun avec ce qu'il permet de voir
const DEMO = [
  { label: "Client", email: "client@dabali.ci", who: "Élève · Aya", what: "Menu, réserver un plat, payer, QR, avis" },
  { label: "Client 2", email: "client02@dabali.ci", who: "Élève · Adjoua", what: "Suggestions IA, historique détaillé" },
  { label: "Client 1", email: "client01@dabali.ci", who: "Élève", what: "Un autre compte élève" },
  { label: "Parent", email: "parent@dabali.ci", who: "Parent d'Aya", what: "Recharger son enfant, suivre ses repas" },
  { label: "Agent", email: "agent@dabali.ci", who: "Agent du comptoir", what: "Scanner les QR, repas du personnel" },
  { label: "Caisse", email: "caisse@dabali.ci", who: "Caissier", what: "Recharges en espèces, bilan, invités" },
  { label: "Chef", email: "chef@dabali.ci", who: "Chef de cuisine", what: "Menus IA, prévisions, stock, courses" },
  { label: "Admin", email: "admin@dabali.ci", who: "Administration", what: "Tableau de bord, rapports, équipe" },
];

export default function ConnexionPage() {
  const router = useRouter();
  // Page demandée avant la connexion (ex. lien d'invitation parent)
  const [nx, setNx] = useState<string | null>(null);
  useEffect(() => setNx(nextFromUrl()), []);
  const [email, setEmail] = useState("");
  // Panneau « Tester l'app » (ouvert d'office depuis la page d'accueil : /connexion?demo=1)
  const [demoOpen, setDemoOpen] = useState(false);
  useEffect(() => { try { if (new URLSearchParams(location.search).get("demo") === "1") setDemoOpen(true); } catch {} }, []);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const t = useT();

  async function signIn(e?: React.FormEvent, creds?: { email: string; password: string }) {
    e?.preventDefault();
    setBusy(true);
    setError(null);
    const { data, error } = await supabase().auth.signInWithPassword(creds ?? { email: email.trim(), password });
    if (error) {
      setBusy(false);
      setError(/invalid/i.test(error.message) ? t("E-mail ou mot de passe incorrect.") : t("Connexion impossible. Réessayez."));
      return;
    }
    const { data: p } = await supabase().from("profiles").select("role").eq("id", data.user.id).single();
    router.replace(nextFromUrl() ?? homeFor(p?.role));
    router.refresh();
  }

  return (
    <>
      <section className="mt-10 mb-8">
        <div className="mb-4 flex justify-end"><LangSwitch /></div>
        <h1 className="text-[34px] font-extrabold leading-[1.05] tracking-tight">
          {t("Mangez sans")} <span className="relative whitespace-nowrap"><span className="relative z-10">{t("attendre")}.</span><span className="absolute inset-x-0 bottom-1 -z-0 h-3 rounded bg-lime" /></span>
        </h1>
        <p className="mt-3 text-[15px] text-muted">{t("Rechargez, réservez votre plat, présentez votre QR. C'est tout.")}</p>
        {/* Simple illustration (pas des boutons) : quelques plats + les 3 étapes */}
        <div className="mt-6 flex items-center gap-3">
          <div className="flex -space-x-3">
            {["attieke-poisson", "alloco-poulet", "garba", "poulet-frites"].map((d, i) => (
              // eslint-disable-next-line @next/next/no-img-element
              <img key={d} src={`/dishes/${d}.jpg`} alt="" style={{ animationDelay: `${i * 70}ms` }}
                className="animate-pop size-12 rounded-full object-cover ring-[3px] ring-canvas" />
            ))}
          </div>
          <p className="text-[13px] font-semibold leading-snug text-ink-2">{t("Solde prépayé · menu en photos")}<br />{t("ticket QR, même hors ligne")}</p>
        </div>
      </section>

      <form onSubmit={signIn} className="space-y-4">
        <Field label={t("E-mail")} type="email" autoComplete="email" inputMode="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder={t("vous@exemple.ci")} />
        <Field label={t("Mot de passe")} type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" error={error} />
        <Button type="submit" size="lg" block loading={busy}>{t("Se connecter")}</Button>
      </form>

      <p className="mt-6 text-center text-sm text-muted">
        {t("Pas encore de compte ?")} <Link href={`/inscription${nx ? `?next=${encodeURIComponent(nx)}` : ""}`} className="font-bold text-ink underline decoration-lime decoration-[3px] underline-offset-4">{t("Créer un compte")}</Link>
      </p>

      <div className="mt-auto pt-10">
        <button type="button" onClick={() => setDemoOpen(true)}
          className="flex h-14 w-full items-center justify-center gap-2 rounded-full border-2 border-ink text-[15px] font-extrabold active:scale-[0.99]">
          ✨ {t("Tester l'app")} <span className="text-sm font-semibold text-muted">· {t("sans créer de compte")}</span>
        </button>
      </div>

      <Sheet open={demoOpen} onClose={() => setDemoOpen(false)} title={t("Tester l'app")}>
        <p className="-mt-2 mb-4 text-sm text-muted">{t("Choisissez un rôle : vous entrez directement dans son espace, avec des données de démonstration.")}</p>
        <div className="grid gap-2">
          {DEMO.map((d) => (
            <button key={d.email} type="button" disabled={busy} aria-label={d.label}
              onClick={() => signIn(undefined, { email: d.email, password: "Dabali2026!" })}
              className="flex items-center gap-3 rounded-2xl border border-line bg-card p-3 text-left transition hover:border-ink active:scale-[0.99] disabled:opacity-50">
              <span className="min-w-0 flex-1">
                <span className="block font-extrabold">{t(d.who)}</span>
                <span className="block text-xs text-muted">{t(d.what)}</span>
              </span>
              <span className="text-lg text-muted" aria-hidden>›</span>
            </button>
          ))}
        </div>
      </Sheet>
    </>
  );
}
