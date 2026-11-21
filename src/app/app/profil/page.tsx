"use client";
import { Bitmoji } from "@/components/bitmoji";
import { BITMOJIS } from "@/lib/bitmoji";
import { useEffect, useState } from "react";
import { PushToggle } from "@/components/push-toggle";
import { InstallApp } from "@/components/install-app";
import { useRouter } from "next/navigation";
import clsx from "clsx";
import { LogOut, KeyRound, Bell, Sparkles, Gift, ChevronRight, LayoutDashboard, ScanLine, PhoneOff, Smartphone, ScanFace, Users } from "lucide-react";
import { biometricLabel, biometricSupported, disableBiometric, enableBiometric, prepareBiometric, prepareEnable } from "@/lib/biometric";
import { syncTokens } from "@/lib/tickets";
import { rpc, supabase } from "@/lib/supabase/client";
import { PageHeader } from "@/components/app/page-header";
import { FamilyPeek } from "@/components/app/family-peek";
import { Qr } from "@/components/qr";
import { Sheet } from "@/components/ui/sheet";
import { PinPad } from "@/components/ui/pin-pad";
import { useToast } from "@/components/ui/toast";
import { useAppData } from "@/components/app/app-data";
import { WhatsAppLink } from "@/components/app/whatsapp-link";
import { DietSection } from "@/components/app/diet-section";
import { LangSwitch, useLang, useT } from "@/lib/i18n";
import { setSfx, sfx, sfxOn } from "@/lib/sfx";

export default function ProfilePage() {
  const router = useRouter();
  const t = useT();
  const lang = useLang();
  const en = lang === "en";
  const toast = useToast();
  const { profile, refresh } = useAppData();
  const [pinStep, setPinStep] = useState<null | "old" | "new">(null);
  const [oldPin, setOldPin] = useState("");
  const [pinErr, setPinErr] = useState<string | null>(null);
  const points = profile?.points ?? 0;
  const [back, setBack] = useState<string | null>(null);
  const [waOpen, setWaOpen] = useState(false);

  // Arrivée depuis un paiement ou un transfert sans code PIN : on ouvre directement la création
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    if (q.get("pin") === "new") { setOldPin(""); setPinStep("new"); }
    const b = q.get("back");
    if (b?.startsWith("/app/")) setBack(b);
    if (q.get("whatsapp") === "1") setWaOpen(true);
  }, []);

  async function toggleSeats() {
    if (!profile) return;
    await supabase().from("profiles").update({ notify_free_seats: !profile.notify_free_seats }).eq("id", profile.id);
    refresh();
  }

  // Téléphone perdu ou volé : nouveaux QR, autres appareils déconnectés (celui-ci reste connecté)
  const [lostOpen, setLostOpen] = useState(false);
  const [pickOpen, setPickOpen] = useState(false);
  // Face ID / empreinte
  const [bioOk, setBioOk] = useState<boolean | null>(null);
  const [bioBusy, setBioBusy] = useState(false);
  useEffect(() => { biometricSupported().then(setBioOk); }, []);
  const bioName = () => (en && biometricLabel() === "l'empreinte" ? "fingerprint" : biometricLabel());
  useEffect(() => {
    if (!bioOk || !profile) return;
    void (profile.biometric_enabled ? prepareBiometric() : prepareEnable());
  }, [bioOk, profile]);
  // Activer Face ID : code PIN d'abord (exigé aussi par le serveur), puis un 2e geste pour lancer Face ID
  const [bioPin, setBioPin] = useState<"pin" | "ready" | null>(null);
  const [bioPinErr, setBioPinErr] = useState<string | null>(null);
  async function confirmBioPin(pin: string) {
    const r = await rpc("check_my_pin", { p_pin: pin });
    if (!r.ok) return setBioPinErr(r.message);
    setBioPinErr(null); setBioPin("ready");
  }
  async function toggleBiometric() {
    if (!profile || bioBusy) return;
    if (!profile.biometric_enabled && bioPin !== "ready") { setBioPinErr(null); setBioPin("pin"); return; }
    setBioPin(null);
    setBioBusy(true);
    const r = profile.biometric_enabled ? await disableBiometric() : await enableBiometric();
    setBioBusy(false);
    if (!r.ok) return toast("err", r.message);
    await refresh();
    toast("ok", en
      ? (profile.biometric_enabled ? `${bioName()} turned off.` : `${bioName()} turned on: the app and payments are protected.`)
      : (profile.biometric_enabled ? `${biometricLabel()} désactivé.` : `${biometricLabel()} activé : l'appli et les paiements sont protégés.`));
  }
  async function pickAvatar(id: string) {
    if (!profile) return;
    setPickOpen(false);
    const { error } = await supabase().from("profiles").update({ avatar: id }).eq("id", profile.id);
    if (error) return toast("err", t("Impossible d'enregistrer, réessayez avec du réseau."));
    await refresh();
    toast("ok", `${en ? "Here's your new bitmoji:" : "Voilà ton nouveau bitmoji :"} ${BITMOJIS.find((b) => b.id === id)?.name} 😄`);
  }
  const [lostBusy, setLostBusy] = useState(false);
  async function secureDevices() {
    setLostBusy(true);
    let keep: string | null = null;
    try { keep = (await (await navigator.serviceWorker?.getRegistration())?.pushManager.getSubscription())?.endpoint ?? null; } catch {}
    const r = await rpc<{ tickets: number }>("secure_my_devices", { p_keep_endpoint: keep });
    setLostBusy(false);
    if (!r.ok) return toast("err", r.message);
    await syncTokens().catch(() => {});
    setLostOpen(false);
    toast("ok", en
      ? `Old phone logged out · ${r.tickets} QR code${r.tickets > 1 ? "s" : ""} renewed.`
      : `Ancien téléphone déconnecté · ${r.tickets} QR renouvelé${r.tickets > 1 ? "s" : ""}.`);
  }

  async function onPin(pin: string) {
    if (pinStep === "old") { setOldPin(pin); setPinErr(null); setPinStep("new"); return; }
    const r = await rpc("set_pin", { p_pin: pin, p_current_pin: oldPin });
    if (!r.ok) { setPinErr(r.message); if (r.code.startsWith("PIN_INVALID") || r.code === "PIN_LOCKED") setPinStep("old"); return; }
    setPinStep(null);
    toast("ok", t(oldPin ? "Code PIN modifié." : "Code PIN créé."));
    if (back) router.push(back);
  }

  async function logout() {
    await supabase().auth.signOut();
    try { ["dabali:me", "dabali:tickets", "dabali:qr"].forEach((k) => localStorage.removeItem(k)); } catch {}
    router.replace("/connexion");
    router.refresh();
  }

  return (
    <main>
      <PageHeader title="Profil" back={false} />
      <div className="px-4">
        {/* QR de transfert visible dès l'ouverture du profil (rien à toucher pour le montrer) */}
        <section className="flex flex-col items-center rounded-[28px] bg-card p-6 text-center shadow-[var(--shadow-card)]">
          <button onClick={() => setPickOpen(true)} aria-label={t("Changer mon bitmoji")} className="relative transition active:scale-95">
            <Bitmoji avatar={profile?.avatar} seed={profile?.id} className="size-24 ring-4 ring-lime" bounce />
            <span className="absolute -bottom-1 -right-1 rounded-full bg-ink px-2 py-0.5 text-[10px] font-extrabold text-lime">{t("Changer")}</span>
          </button>
          <h2 className="mt-3 text-xl font-extrabold">{profile?.full_name}</h2>
          <p className="text-sm text-muted">{profile?.phone}</p>
          {profile?.is_parent ? (
            <p className="mt-3 rounded-full bg-lime px-4 py-1.5 text-sm font-extrabold">{t("Compte parent")}</p>
          ) : (<>
          <div className="mt-5 w-44 rounded-2xl bg-white p-2 ring-1 ring-line">
            {profile && <Qr value={`DABALI:${profile.short_code}`} size={180} />}
          </div>
          <p className="mt-3 rounded-full bg-ink px-4 py-1.5 text-lg font-extrabold tracking-wider text-lime">{profile?.short_code}</p>
          <p className="mt-2 max-w-[240px] text-xs text-muted">{t("Montrez ce QR pour recevoir un transfert ou un repas offert.")}</p>
          </>)}
        </section>

        {!profile?.is_parent && <FamilyPeek invite />}

        {!profile?.is_parent && <section id="fidelite" className="mt-4 rounded-[24px] bg-lime p-5">
          <div className="flex items-center gap-2"><Sparkles className="size-5" /><h3 className="font-extrabold">{t("Fidélité")}</h3></div>
          <p className="mt-1 text-sm font-semibold text-ink/70">{t("1 repas servi = 1 point · 10 points = 1 petit-déjeuner offert")}</p>
          <p className="mt-3 text-[34px] font-extrabold leading-none">{points} <span className="text-base font-bold text-ink/60">point{points > 1 ? "s" : ""}</span></p>
          <div className="mt-3 grid grid-cols-10 gap-1.5">
            {Array.from({ length: 10 }, (_, i) => (
              <span key={i} style={{ animationDelay: `${i * 40}ms` }} className={clsx("animate-pop aspect-square rounded-full", i < points % 10 || (points > 0 && points % 10 === 0) ? "bg-ink" : "bg-white/60")} />
            ))}
          </div>

          <p className="mt-3 text-sm font-bold">
            {points >= 10
              ? <span className="flex items-center gap-1.5"><Gift className="size-4 shrink-0" />{en
                ? `${Math.floor(points / 10)} free breakfast${points >= 20 ? "s" : ""} to use in “Buy”${points % 10 ? ` · ${points % 10}/10 towards the next one` : ""}`
                : `${Math.floor(points / 10)} petit-déjeuner${points >= 20 ? "s" : ""} offert${points >= 20 ? "s" : ""} à utiliser dans « Acheter »${points % 10 ? ` · ${points % 10}/10 vers le suivant` : ""}`}</span>
              : en ? `${10 - points} more meal${10 - points > 1 ? "s" : ""} until your free breakfast` : `Encore ${10 - points} repas avant votre petit-déjeuner offert`}
          </p>
        </section>}

        <section className="mt-4 flex items-center justify-between rounded-[24px] bg-card p-4 shadow-[var(--shadow-card)]">
          <p className="font-bold">🌍 {t("Langue")} <span className="block text-xs font-semibold text-muted">Français · English</span></p>
          <LangSwitch />
        </section>

        <SfxSwitch parent={!!profile?.is_parent} />

        {!profile?.is_parent && <DietSection />}

        {!profile?.is_parent && <section className="mt-4 flex gap-3 rounded-[24px] bg-card p-4 shadow-[var(--shadow-card)]">
          <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-canvas"><Smartphone className="size-[18px]" /></span>
          <div>
            <p className="font-bold">{t("Téléphone éteint ou oublié ?")}</p>
            <p className="mt-0.5 text-sm text-muted">{en
              ? <>You can still eat: at the counter, give your name or your code <b className="text-ink">{profile?.short_code}</b>, then type your PIN on the staff member&apos;s phone.</>
              : <>Vous pouvez quand même manger : au comptoir, donnez votre nom ou votre code <b className="text-ink">{profile?.short_code}</b>, puis tapez votre code PIN sur le téléphone de l&apos;agent.</>}</p>
          </div>
        </section>}

        <div className="mt-4 space-y-3"><InstallApp variant="row" /><PushToggle /></div>
        <div className="mt-4 divide-y divide-line overflow-hidden rounded-[24px] bg-card shadow-[var(--shadow-card)]">
          <Row icon={Bell} label={t("Alerte places libres")} hint={t("Prévenez-moi quand le réfectoire se vide")}
            right={<span className={clsx("h-7 w-12 rounded-full p-1 transition", profile?.notify_free_seats ? "bg-ink" : "bg-line")}>
              <span className={clsx("block size-5 rounded-full transition", profile?.notify_free_seats ? "translate-x-5 bg-lime" : "bg-white")} /></span>}
            onClick={toggleSeats} />
          <Row icon={ScanFace} label={en ? `Protect with ${bioName()}` : `Protéger avec ${biometricLabel()}`}
            hint={t(bioOk === false ? "Non disponible sur cet appareil" : "Ouverture de l'appli, recharges, transferts, cadeaux et gros achats")}
            right={<span className={clsx("h-7 w-12 rounded-full p-1 transition", profile?.biometric_enabled ? "bg-ink" : "bg-line", bioBusy && "opacity-50")}>
              <span className={clsx("block size-5 rounded-full transition", profile?.biometric_enabled ? "translate-x-5 bg-lime" : "bg-white")} /></span>}
            onClick={() => (bioOk ? toggleBiometric() : toast("err", t("Face ID ou empreinte non disponible sur cet appareil.")))} />
          <Row icon={Users} label={t("Ma famille")} hint={t("Parent : recharger et suivre les repas de votre enfant")} onClick={() => router.push("/app/famille")} />
          <WhatsAppLink autoOpen={waOpen} />
          <Row icon={KeyRound} label={t("Changer mon code PIN")} hint={t("Il sert aussi à manger sans téléphone")} onClick={() => { setPinErr(null); setPinStep("old"); }} />
          <Row icon={PhoneOff} label={t("J'ai perdu mon téléphone")} hint={t("Bloquer les QR et déconnecter l'ancien appareil")} onClick={() => setLostOpen(true)} />
          {profile && ["agent", "admin"].includes(profile.role) && <Row icon={ScanLine} label={t("Ouvrir le scanner")} onClick={() => router.push("/scan")} />}
          {profile && ["chef", "caissier", "admin"].includes(profile.role) && <Row icon={LayoutDashboard} label={t("Tableau de bord")} onClick={() => router.push("/admin")} />}
          <Row icon={LogOut} label={t("Se déconnecter")} danger onClick={logout} />
        </div>
      </div>

      <Sheet open={pickOpen} onClose={() => setPickOpen(false)} title={t("Choisis ton bitmoji")}>
        <p className="-mt-1 mb-3 text-sm text-muted">{t("Il s'affiche dans l'appli et au comptoir : l'agent te reconnaît plus vite.")}</p>
        <div className="grid grid-cols-3 gap-3">
          {BITMOJIS.map((b, i) => {
            const on = (profile?.avatar ?? null) === b.id;
            return (
              <button key={b.id} onClick={() => pickAvatar(b.id)} style={{ animationDelay: `${i * 30}ms` }}
                className={clsx("animate-pop flex flex-col items-center gap-1 rounded-2xl p-2 transition active:scale-95", on ? "bg-ink text-white" : "bg-canvas")}>
                <Bitmoji avatar={b.id} mood={on ? "laugh" : "happy"} className="size-20" />
                <span className="text-xs font-bold">{b.name}</span>
              </button>
            );
          })}
        </div>
      </Sheet>

      <Sheet open={lostOpen} onClose={() => setLostOpen(false)} title={t("Téléphone perdu ou volé")}>
        <ul className="space-y-2 text-sm text-ink-2">
          <li>• {en
            ? <>QR codes saved on the old phone <b>will no longer work</b>, even offline.</>
            : <>Les QR gardés dans l&apos;ancien téléphone <b>ne fonctionneront plus</b>, même hors ligne.</>}</li>
          <li>• {t("Vos tickets et votre solde restent intacts : les nouveaux QR s'affichent ici.")}</li>
          <li>• {t("L'ancien téléphone est déconnecté et ne reçoit plus vos notifications.")}</li>
        </ul>
        <p className="mt-3 text-xs text-muted">{t("Pensez aussi à changer votre code PIN si quelqu'un a pu le voir.")}</p>
        <button onClick={secureDevices} disabled={lostBusy} className="mt-5 h-12 w-full rounded-full bg-err font-bold text-white disabled:opacity-60">
          {t(lostBusy ? "Sécurisation…" : "Déconnecter l'ancien téléphone")}
        </button>
      </Sheet>

      <Sheet open={pinStep !== null} onClose={() => setPinStep(null)} title={t("Code PIN")}>
        <PinPad key={pinStep} onComplete={onPin} error={pinErr} label={t(pinStep === "old" ? "Code actuel" : "Nouveau code")} />
      </Sheet>
      <Sheet open={bioPin !== null} onClose={() => setBioPin(null)} title={en ? `Turn on ${bioName()}` : `Activer ${biometricLabel()}`}>
        {bioPin === "pin"
          ? <PinPad label={t("Confirme avec ton code PIN")} error={bioPinErr} onComplete={confirmBioPin} />
          : <button onClick={toggleBiometric} className="h-14 w-full rounded-full bg-ink text-lg font-extrabold text-white">
              {en ? `Turn on ${bioName()} now` : `Activer ${biometricLabel()} maintenant`}
            </button>}
      </Sheet>
    </main>
  );
}

/** Sons et petites animations de l'appli (bip, cloche « commande prête », réactions des avis) */
function SfxSwitch({ parent }: { parent: boolean }) {
  const t = useT();
  const [on, setOn] = useState(true);
  useEffect(() => setOn(sfxOn()), []);
  const flip = () => { const n = !on; setSfx(n); setOn(n); if (n) sfx.tap(); };
  return (
    <button onClick={flip} role="switch" aria-checked={on} className="mt-4 flex w-full items-center justify-between rounded-[24px] bg-card p-4 text-left shadow-[var(--shadow-card)]">
      <span className="font-bold">{on ? "🔊" : "🔇"} {t("Sons de l'appli")}
        <span className="block text-xs font-semibold text-muted">{t(parent ? "Petits sons quand une recharge passe" : "Cloche quand ta commande est prête, réactions des avis")}</span></span>
      <span className={clsx("h-7 w-12 shrink-0 rounded-full p-1 transition", on ? "bg-ink" : "bg-line")}>
        <span className={clsx("block size-5 rounded-full transition", on ? "translate-x-5 bg-lime" : "bg-white")} /></span>
    </button>
  );
}

function Row({ icon: I, label, hint, right, onClick, danger }: {
  icon: typeof Bell; label: string; hint?: string; right?: React.ReactNode; onClick: () => void; danger?: boolean;
}) {
  return (
    <button onClick={onClick} className="flex w-full items-center gap-3 px-4 py-3.5 text-left active:bg-canvas">
      <span className={clsx("grid size-10 place-items-center rounded-xl", danger ? "bg-err-soft text-err" : "bg-canvas")}><I className="size-[18px]" /></span>
      <span className="flex-1">
        <span className={clsx("block text-[15px] font-bold", danger && "text-err")}>{label}</span>
        {hint && <span className="block text-xs text-muted">{hint}</span>}
      </span>
      {right ?? <ChevronRight className="size-5 text-off" />}
    </button>
  );
}
