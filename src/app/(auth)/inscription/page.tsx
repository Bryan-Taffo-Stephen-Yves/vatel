"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { nextFromUrl } from "@/lib/next-path";
import { ShieldCheck } from "lucide-react";
import { rpc, supabase } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { PinPad } from "@/components/ui/pin-pad";
import { useT } from "@/lib/i18n";

export default function InscriptionPage() {
  const router = useRouter();
  // Page demandée avant la connexion (ex. lien d'invitation parent)
  const [nx, setNx] = useState<string | null>(null);
  useEffect(() => setNx(nextFromUrl()), []);
  const [step, setStep] = useState<"infos" | "pin" | "confirm">("infos");
  const [f, setF] = useState({ full_name: "", phone: "", email: "", password: "" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [firstPin, setFirstPin] = useState("");
  const t = useT();

  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });

  async function register(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const phone = f.phone.replace(/[^\d+]/g, "");
    if (f.full_name.trim().length < 2) return setError(t("Indiquez votre nom complet."));
    if (phone.replace(/\D/g, "").length < 8) return setError(t("Numéro de téléphone invalide."));
    if (f.password.length < 8) return setError(t("Mot de passe : 8 caractères minimum."));
    setBusy(true);
    const fullPhone = phone.startsWith("+") ? phone : "+225" + phone;
    const { data, error } = await supabase().auth.signUp({
      email: f.email.trim(),
      password: f.password,
      options: { data: { full_name: f.full_name.trim(), phone: fullPhone } },
    });
    if (error) {
      setBusy(false);
      if (/registered|exists/i.test(error.message)) return setError(t("Un compte existe déjà avec cet e-mail."));
      if (/phone|duplicate|unique|database/i.test(error.message)) return setError(t("Ce numéro de téléphone est déjà utilisé."));
      if (/rate/i.test(error.message)) return setError(t("Trop d'inscriptions en peu de temps. Réessayez dans quelques minutes."));
      return setError(t("Inscription impossible. Réessayez."));
    }
    if (!data.session) {
      // Projet configuré avec confirmation d'e-mail : on tente une connexion directe
      const { error: e2 } = await supabase().auth.signInWithPassword({ email: f.email.trim(), password: f.password });
      if (e2) { setBusy(false); return setError(t("Compte créé. Confirmez votre e-mail puis connectez-vous.")); }
    }
    setBusy(false);
    setStep("pin");
  }

  const onPin = useCallback(async (pin: string) => {
    if (step === "pin") { setFirstPin(pin); setError(null); setStep("confirm"); return; }
    if (pin !== firstPin) { setError(t("Les deux codes ne correspondent pas.")); setStep("pin"); return; }
    setBusy(true);
    const r = await rpc("set_pin", { p_pin: pin });
    setBusy(false);
    if (!r.ok) { setError(r.message); setStep("pin"); return; }
    router.replace(nextFromUrl() ?? "/app");
    router.refresh();
  }, [step, firstPin, router, t]);

  if (step !== "infos") {
    return (
      <section className="mt-10 flex flex-1 flex-col items-center text-center">
        <span className="grid size-16 place-items-center rounded-3xl bg-lime"><ShieldCheck className="size-8" /></span>
        <h1 className="mt-5 text-2xl font-extrabold">{step === "pin" ? t("Créez votre code PIN") : t("Confirmez votre code")}</h1>
        <p className="mt-2 max-w-xs text-sm text-muted">{t("Il protège vos transferts et vos achats de plus de 5\u00a0000\u00a0FCFA. Évitez 1234 ou 0000.")}</p>
        <div className="mt-8 w-full">
          <PinPad key={step} onComplete={onPin} error={error} busy={busy} label={step === "pin" ? t("4 chiffres") : t("Saisissez-le à nouveau")} />
        </div>
      </section>
    );
  }

  return (
    <>
      <section className="mt-8 mb-6">
        <h1 className="text-[28px] font-extrabold tracking-tight">{t("Créer mon compte")}</h1>
        <p className="mt-1 text-sm text-muted">{t("30 secondes, et votre prochain repas est réservé.")}</p>
      </section>
      <form onSubmit={register} className="space-y-4">
        <Field label={t("Nom complet")} autoComplete="name" required value={f.full_name} onChange={set("full_name")} placeholder="Aya Konan" />
        <Field label={t("Téléphone")} type="tel" inputMode="tel" autoComplete="tel" required value={f.phone} onChange={set("phone")} placeholder="07 07 07 07 07" />
        <Field label={t("E-mail")} type="email" inputMode="email" autoComplete="email" required value={f.email} onChange={set("email")} placeholder={t("vous@exemple.ci")} />
        <Field label={t("Mot de passe")} type="password" autoComplete="new-password" required value={f.password} onChange={set("password")} hint={t("8 caractères minimum")} error={error} />
        <Button type="submit" size="lg" block loading={busy}>{t("Continuer")}</Button>
      </form>
      <p className="mt-6 text-center text-sm text-muted">
        {t("Déjà inscrit ?")} <Link href={`/connexion${nx ? `?next=${encodeURIComponent(nx)}` : ""}`} className="font-bold text-ink underline decoration-lime decoration-[3px] underline-offset-4">{t("Se connecter")}</Link>
      </p>
    </>
  );
}
