"use client";
import { useEffect, useState } from "react";
import clsx from "clsx";
import { Check, Copy, Clock, XCircle, CheckCircle2 } from "lucide-react";
import { supabase } from "@/lib/supabase/client";
import { Sheet } from "@/components/ui/sheet";
import { fcfa, signedFcfa, todayISO, dayLong, TZ } from "@/lib/format";
import { useLang, useT } from "@/lib/i18n";
import { useAppData } from "@/components/app/app-data";

/** Opération du porte-monnaie (table transactions) */
export type Tx = { id: string; type: string; amount: number; balance_after: number; note: string | null; created_at: string; counterpart_name: string | null };
/** Paiement Mobile Money (table payments) : recharge par soi-même ou par un parent */
export type Payment = {
  id: string; reference: string; payer_id: string; beneficiary_id: string; amount: number; method: string; payer_phone: string | null;
  provider_tx_id: string | null; status: "pending" | "success" | "error"; error_reason: string | null; fee: number | null;
  transaction_id: string | null; created_at: string; completed_at: string | null;
};
export const PAYMENT_COLUMNS = "id, reference, payer_id, beneficiary_id, amount, method, payer_phone, provider_tx_id, status, error_reason, fee, transaction_id, created_at, completed_at";

export const METHOD_LABEL: Record<string, string> = { wave: "Wave", orange: "Orange Money", mtn: "MTN MoMo", moov: "Moov Money", djamo: "Djamo" };

const TYPE_LABEL: Record<string, string> = {
  recharge: "Recharge Mobile Money", recharge_cash: "Recharge en caisse", purchase: "Achat de ticket", transfer_in: "Transfert reçu",
  transfer_out: "Transfert envoyé", refund: "Remboursement", bonus: "Bonus",
};

/** Numéro masqué : +225 07 •• •• 12 34 */
const maskPhone = (p: string) => {
  const d = p.replace(/\D/g, "");
  if (d.length < 8) return p;
  const local = d.startsWith("225") ? d.slice(3) : d;
  return `+225 ${local.slice(0, 2)} •• •• ${local.slice(-4, -2)} ${local.slice(-2)}`;
};

/**
 * Détail d'une opération (touchée dans l'historique) : montant, statut, date et heure exactes, objet, moyen de paiement,
 * numéro débité (masqué), frais, solde après, référence (copiable). Pour une recharge Mobile Money, le paiement lié est chargé.
 */
export function TxDetail({ tx, payment: given, childName, onClose }: {
  tx?: Tx | null; payment?: Payment | null; childName?: string | null; onClose: () => void;
}) {
  const t = useT();
  const en = useLang() === "en";
  const { profile } = useAppData();
  const [loaded, setLoaded] = useState<Payment | null>(null);
  const pay = given ?? loaded;
  const [copied, setCopied] = useState(false);
  const open = !!(tx || given);

  useEffect(() => {
    setLoaded(null); setCopied(false);
    if (!tx || given || !tx.type.startsWith("recharge")) return;
    supabase().from("payments").select(PAYMENT_COLUMNS).eq("transaction_id", tx.id).maybeSingle()
      .then(({ data }) => data && setLoaded(data as Payment));
  }, [tx, given]);

  if (!open) return null;
  const at = tx?.created_at ?? pay!.completed_at ?? pay!.created_at;
  const amount = tx?.amount ?? pay!.amount;
  const status = pay?.status ?? "success";
  const ref = pay?.reference ?? `OP-${tx!.id.slice(0, 8).toUpperCase()}`;
  const d = new Date(at);
  const hour = d.toLocaleTimeString(en ? "en-GB" : "fr-FR", { hour: "2-digit", minute: "2-digit", second: "2-digit", timeZone: TZ });
  const day = en ? d.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: TZ })
                 : `${dayLong(todayISO(d))} ${d.toLocaleDateString("fr-FR", { year: "numeric", timeZone: TZ })}`;
  const type = tx ? t(TYPE_LABEL[tx.type] ?? "Opération") : childName ? `${t("Recharge pour")} ${childName}` : t("Recharge Mobile Money");
  const object = tx?.note ?? (childName ? `${t("Compte cantine de")} ${childName}` : null);
  const who = tx?.counterpart_name?.split(" · ")[0];

  const rows: [string, React.ReactNode][] = [
    [t("Date"), day],
    [t("Heure"), hour],
    [t("Type"), type],
  ];
  if (object) rows.push([t("Objet"), object]);
  if (who && tx) rows.push([tx.type === "transfer_in" ? t("Expéditeur") : t("Bénéficiaire"), tx.counterpart_name!]);
  if (pay) {
    rows.push([t("Moyen de paiement"), METHOD_LABEL[pay.method] ?? pay.method]);
    // Numéro débité : seulement pour celui qui a payé (l'élève ne voit pas le numéro de son parent)
    if (pay.payer_phone && pay.payer_id === profile?.id) rows.push([t("Numéro débité"), maskPhone(pay.payer_phone)]);
    if (pay.fee) rows.push([t("Frais"), fcfa(pay.fee)]);
    if (pay.provider_tx_id) rows.push([t("Réf. opérateur"), <span key="p" className="font-mono text-xs">{pay.provider_tx_id}</span>]);
    if (pay.status === "error" && pay.error_reason) rows.push([t("Motif de l'échec"), pay.error_reason]);
  }
  if (tx) rows.push([t("Solde après"), fcfa(tx.balance_after)]);

  const copy = async () => {
    try { await navigator.clipboard.writeText(ref); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch {}
  };
  const S = status === "success" ? { icon: CheckCircle2, label: t("Réussie"), cls: "bg-ok-soft text-[#15803d]" }
    : status === "pending" ? { icon: Clock, label: t("En attente"), cls: "bg-warn-soft text-[#92400e]" }
    : { icon: XCircle, label: t("Échouée"), cls: "bg-err/10 text-err" };

  return (
    <Sheet open onClose={onClose} title={t("Détail de l'opération")}>
      <div className="text-center">
        <p className={clsx("text-[34px] font-extrabold tracking-tight", amount > 0 && status === "success" ? "text-[#15803d]" : "text-ink")}>
          {tx ? signedFcfa(amount) : fcfa(amount)}
        </p>
        <span className={clsx("mt-1 inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-extrabold", S.cls)}>
          <S.icon className="size-3.5" />{S.label}
        </span>
      </div>
      <dl className="mt-5 divide-y divide-line rounded-[20px] bg-canvas px-4">
        {rows.map(([k, v]) => (
          <div key={k} className="flex items-start justify-between gap-4 py-3 text-sm">
            <dt className="shrink-0 font-semibold text-muted">{k}</dt>
            <dd className="text-right font-bold">{v}</dd>
          </div>
        ))}
        <div className="flex items-center justify-between gap-4 py-3 text-sm">
          <dt className="shrink-0 font-semibold text-muted">{t("Référence")}</dt>
          <dd><button onClick={copy} className="flex items-center gap-1.5 font-mono text-xs font-bold active:opacity-60">
            {ref}{copied ? <Check className="size-4 text-[#15803d]" /> : <Copy className="size-4 text-muted" />}
          </button></dd>
        </div>
      </dl>
      <p className="mt-3 text-center text-xs text-muted">{t("Donnez cette référence à la caisse en cas de question.")}</p>
    </Sheet>
  );
}
