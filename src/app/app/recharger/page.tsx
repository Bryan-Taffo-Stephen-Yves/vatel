"use client";
import { sfx } from "@/lib/sfx";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import clsx from "clsx";
import { Smartphone, Banknote, Info, CheckCircle2, XCircle, Loader2 } from "lucide-react";
import { edge, rpc, supabase } from "@/lib/supabase/client";
import { PageHeader } from "@/components/app/page-header";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { useAppData } from "@/components/app/app-data";
import { Sheet } from "@/components/ui/sheet";
import { BiometricConfirm } from "@/components/app/biometric-confirm";
import { fcfa } from "@/lib/format";
import { useLang, useT } from "@/lib/i18n";
import { phoneDigits } from "@/lib/phone";
import { mobileMoneyFee } from "@/lib/fees";
import { PhoneInput } from "@/components/ui/phone-input";
import { AmountInput } from "@/components/ui/amount-input";

const AMOUNTS = [2000, 5000, 10000, 25000, 50000, 100000];
const OPERATORS = [
  { id: "wave", name: "Wave", color: "#1DC3FF", prefix: null },
  { id: "orange", name: "Orange Money", color: "#FF7900", prefix: "07" },
  { id: "mtn", name: "MTN MoMo", color: "#FFCB05", prefix: "05" },
  { id: "moov", name: "Moov Money", color: "#0066B3", prefix: "01" },
  { id: "djamo", name: "Djamo", color: "#111827", prefix: null },
] as const;

type Wait = { reference: string; ussd: boolean; state: "pending" | "success" | "error"; amount?: number; reason?: string | null };
const digits10 = (p?: string | null) => phoneDigits(p).slice(0, 10);

/**
 * Recharge par Mobile Money (paiement réel via Jèko), pour soi ou pour son enfant (?pour=<id>&nom=<prénom>).
 * Wave / Orange / Djamo : on part vers l'appli de l'opérateur, puis retour ici (?ref=…) ;
 * MTN / Moov : code USSD sur le téléphone, la page attend. Le solde n'est crédité qu'une fois le paiement confirmé.
 */
export default function RechargePage() {
  const router = useRouter();
  const toast = useToast();
  const t = useT();
  const lang = useLang();
  const en = lang === "en";
  const { balance, profile, refresh } = useAppData();
  const [amount, setAmount] = useState(5000);
  const [custom, setCustom] = useState<string | null>(null); // montant tapé à la main (null = une des pastilles)
  const [op, setOp] = useState<(typeof OPERATORS)[number]["id"]>("wave");
  const [phone, setPhone] = useState("");
  const [busy, setBusy] = useState(false);
  const [child, setChild] = useState<{ id: string; name: string } | null>(null);
  const [wait, setWait] = useState<Wait | null>(null);
  const value = custom !== null ? parseInt(custom, 10) || 0 : amount;
  const operator = OPERATORS.find((o) => o.id === op)!;
  const phoneOk = /^(01|05|07)\d{8}$/.test(phone) && (!operator.prefix || phone.startsWith(operator.prefix));
  // Frais Mobile Money payés par l'élève (réglage admin) : affichés avant de payer ; la base recalcule le même montant
  const [mm, setMm] = useState<{ mode?: string; fee_percent?: number } | null>(null);
  useEffect(() => {
    supabase().from("settings").select("value").eq("key", "mobile_money").maybeSingle()
      .then(({ data }) => setMm((data?.value as { mode?: string; fee_percent?: number } | null) ?? {}));
  }, []);
  const fee = mm?.mode === "jeko" ? mobileMoneyFee(value, mm.fee_percent) : 0;
  const total = value + fee;

  // Paramètres d'arrivée : recharge d'un enfant, ou retour de l'appli de paiement
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const pour = q.get("pour");
    if (pour) setChild({ id: pour, name: q.get("nom") ?? "" });
    const m = parseInt(q.get("montant") ?? "", 10);
    if (m > 0) { setAmount(m); }
    const ref = q.get("ref");
    if (ref) setWait({ reference: ref, ussd: false, state: "pending" });
  }, []);
  // Le numéro qui paie n'est JAMAIS rempli d'office (souvent un autre téléphone : celui d'un parent, d'un ami) :
  // on propose seulement « Mon numéro » en un toucher.
  const myPhone = digits10(profile?.phone);

  // Attente de la confirmation : interrogation toutes les 4 s (3 min au plus)
  const tries = useRef(0);
  const check = useCallback(async (reference: string) => {
    const r = await edge<{ status: Wait["state"]; amount: number; reason: string | null; for_child: boolean }>("jeko-pay", { action: "status", reference });
    if (!r.ok) return;
    setWait((w) => (w && w.reference === reference ? { ...w, state: r.status, amount: r.amount, reason: r.reason } : w));
    if (r.status === "success") { await refresh(); sfx.coin(); }
  }, [refresh]);
  useEffect(() => {
    if (!wait || wait.state !== "pending") return;
    tries.current = 0;
    check(wait.reference);
    const id = setInterval(() => {
      tries.current += 1;
      if (tries.current > 45) return clearInterval(id);
      check(wait.reference);
    }, 4000);
    return () => clearInterval(id);
  }, [wait?.reference, wait?.state, check]); // eslint-disable-line react-hooks/exhaustive-deps

  const [confirmOpen, setConfirmOpen] = useState(false);
  const start = () => (profile?.biometric_enabled ? setConfirmOpen(true) : pay());

  async function pay() {
    setConfirmOpen(false);
    setBusy(true);
    const r = await edge<{ reference: string; mode: "redirect" | "ussd"; redirect_url: string | null }>("jeko-pay", {
      action: "create", amount: value, method: op, phone, child_id: child?.id ?? null,
    });
    // Paiement en ligne pas encore activé (clés absentes) ou fonction pas encore déployée : mode démo
    if (!r.ok && (r.code === "NOT_CONFIGURED" || r.code === "NOT_FOUND")) return demo();
    setBusy(false);
    if (!r.ok) return toast("err", r.message);
    if (r.mode === "redirect" && r.redirect_url) { window.location.href = r.redirect_url; return; }
    setWait({ reference: r.reference, ussd: true, state: "pending" });
  }

  // Paiement en ligne pas encore activé : la démo reste utilisable (aucun débit réel)
  async function demo() {
    const r = child
      ? await rpc<{ balance: number }>("parent_recharge_child", { p_child: child.id, p_amount: value })
      : await rpc<{ balance: number }>("simulate_recharge", { p_amount: value });
    setBusy(false);
    if (!r.ok) return toast("err", r.message);
    await refresh();
    sfx.coin();
    toast("ok", en ? `${fcfa(value)} added (demo mode, no real debit).` : `${fcfa(value)} ajoutés (mode démo, aucun débit réel).`);
    router.replace(child ? "/app/famille" : "/app");
  }

  if (wait) {
    const done = wait.state !== "pending";
    return (
      <main>
        <PageHeader title={t("Recharger")} />
        <div className="px-4">
          <div className="mt-4 rounded-[26px] bg-card p-6 text-center shadow-[var(--shadow-card)]">
            {wait.state === "pending" && <Loader2 className="mx-auto size-12 animate-spin text-ink" />}
            {wait.state === "success" && <CheckCircle2 className="mx-auto size-14 text-lime-deep" />}
            {wait.state === "error" && <XCircle className="mx-auto size-14 text-err" />}
            <p className="mt-3 text-lg font-extrabold">
              {wait.state === "pending" && (wait.ussd ? t("Valide le paiement sur ton téléphone") : t("Paiement en cours de vérification…"))}
              {wait.state === "success" && t("Recharge réussie")}
              {wait.state === "error" && t("Le paiement n'a pas abouti")}
            </p>
            <p className="mt-1 text-sm font-semibold text-muted">
              {wait.state === "pending" && (wait.ussd
                ? t("Un message de ton opérateur va s'afficher : entre ton code secret pour confirmer.")
                : t("Ton solde sera crédité dès que l'opérateur confirme."))}
              {wait.state === "success" && (en ? `${fcfa(wait.amount ?? 0)} added. Balance: ${fcfa(balance ?? 0)}` : `${fcfa(wait.amount ?? 0)} ajoutés. Solde : ${fcfa(balance ?? 0)}`)}
              {wait.state === "error" && t("Aucun montant n'a été crédité. Tu peux réessayer.")}
            </p>
          </div>
          {!done && <Button block variant="outline" className="mt-4" onClick={() => check(wait.reference)}>{t("Vérifier maintenant")}</Button>}
          <Button block className="mt-3" onClick={() => { setWait(null); window.history.replaceState(null, "", "/app/recharger"); if (wait.state === "success") router.replace("/app"); }}>
            {wait.state === "success" ? t("Terminé") : done ? t("Réessayer") : t("Fermer")}
          </Button>
        </div>
      </main>
    );
  }

  return (
    <main>
      <PageHeader title={child?.name ? `${t("Recharger")} ${child.name}` : t("Recharger")} />
      <div className="px-4">
        {!child && <p className="text-sm font-semibold text-muted">{t("Solde actuel")} · <b className="text-ink">{fcfa(balance ?? 0)}</b></p>}

        <div className="mt-5 rounded-[26px] bg-card p-5 text-center shadow-[var(--shadow-card)]">
          <p className="text-sm font-bold text-muted">{t("Montant")}</p>
          <AmountInput value={value} onChange={(digits) => setCustom(digits)} onDone={() => { if (!custom || custom === "0" || AMOUNTS.includes(value)) { if (AMOUNTS.includes(value)) setAmount(value); setCustom(null); } }}
            hint={en ? "Tap the amount to change it" : "Touchez le montant pour le modifier"} />
          {custom !== null && value > 0 && (value < 100 || value > 500000) && (
            <p className="mt-1 text-[13px] font-semibold text-err">{en ? "Between 100 and 500,000 FCFA." : "Entre 100 et 500 000 FCFA."}</p>
          )}
          <div className="mt-4 grid grid-cols-3 gap-2">
            {AMOUNTS.map((a) => (
              <button key={a} onClick={() => { setAmount(a); setCustom(null); }}
                className={clsx("h-12 rounded-2xl text-[15px] font-extrabold transition",
                  value === a ? "bg-ink text-lime" : "bg-canvas text-ink active:bg-line")}>
                {fcfa(a, false)}
              </button>
            ))}
          </div>
        </div>

        <h2 className="mb-2.5 mt-6 text-[15px] font-extrabold">{t("Payer avec")}</h2>
        <div className="grid grid-cols-2 gap-2">
          {OPERATORS.map((o) => (
            <button key={o.id} onClick={() => setOp(o.id)}
              className={clsx("flex h-14 items-center gap-2.5 rounded-2xl border-2 bg-card px-3 text-left text-sm font-bold transition",
                op === o.id ? "border-ink" : "border-transparent shadow-[var(--shadow-card)]")}>
              <span className="grid size-8 place-items-center rounded-xl text-white" style={{ background: o.color }}><Smartphone className="size-4" /></span>
              {o.name}
            </button>
          ))}
        </div>

        <label className="mt-5 block">
          <span className="text-[15px] font-extrabold">{t("Numéro qui paie")}</span>
          <PhoneInput className="mt-2" value={phone} onChange={setPhone} invalid={phone.length === 10 && !phoneOk} />
          {myPhone.length === 10 && phone !== myPhone && (
            <button type="button" onClick={() => setPhone(myPhone)} className="mt-2 rounded-full border border-line bg-card px-3 py-1.5 text-xs font-bold text-ink-2 active:scale-95">
              {t("Mon numéro")} · {myPhone.replace(/(\d{2})(?=\d)/g, "$1 ")}
            </button>
          )}
          {phone.length === 10 && !phoneOk && (
            <span className="mt-1 block text-[13px] font-semibold text-err">
              {operator.prefix
                ? (en ? `A ${operator.name} number starts with ${operator.prefix}.` : `Un numéro ${operator.name} commence par ${operator.prefix}.`)
                : t("Numéro mobile à 10 chiffres (01, 05 ou 07…).")}
            </span>
          )}
        </label>

        <p className="mt-4 flex gap-2 rounded-2xl bg-lime-soft p-3 text-[13px] font-semibold text-ink-2">
          <Info className="mt-0.5 size-4 shrink-0" />
          {t("Paiement sécurisé par Jèko : tu confirmes sur ton téléphone, le solde est crédité dès la confirmation.")}
        </p>
        {!child && (
          <p className="mt-2 flex gap-2 rounded-2xl bg-card p-3 text-[13px] font-semibold text-ink-2 shadow-[var(--shadow-card)]">
            <Banknote className="mt-0.5 size-4 shrink-0" />
            <span>{en ? <>Cash: show your ID <b className="whitespace-nowrap">{profile?.short_code}</b> at the till.</> : <>En espèces : présentez votre identifiant <b className="whitespace-nowrap">{profile?.short_code}</b> à la caisse.</>}</span>
          </p>
        )}

        {fee > 0 && value >= 100 && (
          <div className="mt-4 rounded-2xl bg-card p-4 text-[14px] shadow-[var(--shadow-card)]">
            <p className="flex justify-between"><span className="text-muted">{en ? "Credited to the account" : "Crédité sur le compte"}</span><b>{fcfa(value)}</b></p>
            <p className="mt-1 flex justify-between"><span className="text-muted">{en ? "Mobile Money fees" : "Frais Mobile Money"}</span><b>+ {fcfa(fee)}</b></p>
            <p className="mt-2 flex justify-between border-t border-line pt-2 text-[15px]"><span className="font-bold">{en ? "Charged to your phone" : "Débité sur ton téléphone"}</span><b>{fcfa(total)}</b></p>
          </div>
        )}

        <Button size="lg" block className="mt-6" loading={busy || mm === null} disabled={value < 100 || value > 500000 || !phoneOk} onClick={start}>
          {t("Payer")} {fcfa(total)}
        </Button>
      </div>
      <Sheet open={confirmOpen} onClose={() => setConfirmOpen(false)} title={t("Confirmer la recharge")}>
        <p className="-mt-2 mb-5 text-sm text-muted">{t("Recharge de")} <b className="text-ink">{fcfa(value)}</b></p>
        <BiometricConfirm enabled mode="grant" onConfirmed={() => pay()} busy={busy} />
      </Sheet>
    </main>
  );
}
