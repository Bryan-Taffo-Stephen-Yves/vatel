"use client";
// Bilan de caisse du jour (caisse, admin) : espèces encaissées (par caissier, montant à remettre), Mobile Money reçu
// (Jèko : montant crédité, frais payés par les élèves, paiements échoués), dernières opérations, export CSV.
// Lecture seule, avec les droits existants (transactions et payments lisibles par la caisse).
import { useCallback, useEffect, useMemo, useState } from "react";
import clsx from "clsx";
import { Banknote, Smartphone, Download, RefreshCw } from "lucide-react";
import { supabase, myId } from "@/lib/supabase/client";
import { Card, Kpi, Segmented, downloadCsv } from "@/components/admin/ui";
import { Button } from "@/components/ui/button";
import { addDays, fcfa, time, todayISO } from "@/lib/format";

type Who = { full_name: string; short_code?: string } | null;
type Cash = { id: string; amount: number; note: string | null; created_at: string; performed_by: string | null; client: Who; staff: Who };
type Pay = { reference: string; amount: number; fee: number | null; method: string; status: "pending" | "success" | "error"; created_at: string;
  error_reason: string | null; payer: Who; beneficiary: Who };
const METHOD: Record<string, string> = { wave: "Wave", orange: "Orange Money", mtn: "MTN MoMo", moov: "Moov Money", djamo: "Djamo" };

/** `version` : à changer après une recharge pour rafraîchir tout de suite. */
export function CashDay({ version = 0 }: { version?: number }) {
  const [day, setDay] = useState<"today" | "yesterday">("today");
  const [cash, setCash] = useState<Cash[] | null>(null);
  const [pays, setPays] = useState<Pay[]>([]);
  const [me, setMe] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const date = day === "today" ? todayISO() : addDays(todayISO(), -1);

  const load = useCallback(async () => {
    setLoading(true);
    const sb = supabase();
    const from = `${date}T00:00:00Z`, to = `${addDays(date, 1)}T00:00:00Z`; // Abidjan = UTC
    const [c, p, id] = await Promise.all([
      sb.from("transactions").select("id, amount, note, created_at, performed_by, client:profiles!transactions_user_id_fkey(full_name, short_code), staff:profiles!transactions_performed_by_fkey(full_name)")
        .eq("type", "recharge_cash").gte("created_at", from).lt("created_at", to).order("created_at", { ascending: false }).limit(500),
      sb.from("payments").select("reference, amount, fee, method, status, created_at, error_reason, payer:profiles!payments_payer_id_fkey(full_name), beneficiary:profiles!payments_beneficiary_id_fkey(full_name)")
        .gte("created_at", from).lt("created_at", to).order("created_at", { ascending: false }).limit(500),
      myId(),
    ]);
    setCash((c.data ?? []) as unknown as Cash[]);
    setPays((p.data ?? []) as unknown as Pay[]);
    setMe(id);
    setLoading(false);
  }, [date, version]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { load(); const t = setInterval(load, 60_000); return () => clearInterval(t); }, [load]);

  const s = useMemo(() => {
    const all = cash ?? [];
    const mine = all.filter((x) => x.performed_by === me);
    const byStaff = new Map<string, { name: string; n: number; total: number }>();
    for (const x of all) {
      const k = x.performed_by ?? "?"; const e = byStaff.get(k) ?? { name: x.staff?.full_name ?? "—", n: 0, total: 0 };
      e.n++; e.total += x.amount; byStaff.set(k, e);
    }
    const ok = pays.filter((p) => p.status === "success");
    return {
      cashTotal: all.reduce((a, x) => a + x.amount, 0), cashN: all.length,
      mineTotal: mine.reduce((a, x) => a + x.amount, 0), mineN: mine.length,
      byStaff: [...byStaff.values()].sort((a, b) => b.total - a.total),
      mmTotal: ok.reduce((a, p) => a + p.amount, 0), mmFees: ok.reduce((a, p) => a + (p.fee ?? 0), 0), mmN: ok.length,
      mmFailed: pays.filter((p) => p.status === "error").length, mmPending: pays.filter((p) => p.status === "pending").length,
    };
  }, [cash, pays, me]);

  // Dernières opérations : espèces et Mobile Money mélangées, les plus récentes d'abord
  const ops = useMemo(() => [
    ...(cash ?? []).map((x) => ({ at: x.created_at, kind: "Espèces", who: x.client?.full_name ?? "—", code: x.client?.short_code ?? "", amount: x.amount, by: x.staff?.full_name ?? "", status: "ok" as const, extra: "" })),
    ...pays.map((p) => ({ at: p.created_at, kind: METHOD[p.method] ?? p.method, who: p.beneficiary?.full_name ?? "—", code: "", amount: p.amount,
      by: p.payer && p.beneficiary && p.payer.full_name !== p.beneficiary.full_name ? `payé par ${p.payer.full_name}` : "",
      status: p.status === "success" ? ("ok" as const) : p.status === "error" ? ("err" as const) : ("wait" as const),
      extra: p.status === "success" && p.fee ? `+ ${fcfa(p.fee)} de frais` : p.status === "error" ? (p.error_reason ?? "échec") : p.status === "pending" ? "en attente" : "" })),
  ].sort((a, b) => b.at.localeCompare(a.at)), [cash, pays]);

  const exportCsv = () => downloadCsv(`caisse-${date}.csv`, [
    ["Date", "Heure", "Type", "Client", "Identifiant", "Montant crédité (FCFA)", "Détail", "Statut"],
    ...ops.map((o) => [date, time(o.at), o.kind, o.who, o.code, o.amount, [o.by, o.extra].filter(Boolean).join(" · "), o.status === "ok" ? "encaissé" : o.status === "err" ? "échoué" : "en attente"]),
  ]);

  return (
    <Card title="Bilan de caisse" subtitle="Recharges du jour : espèces à la caisse et Mobile Money (Jèko). Mis à jour chaque minute."
      action={<div className="flex flex-wrap items-center gap-2">
        <Segmented value={day} onChange={setDay} options={[["today", "Aujourd'hui"], ["yesterday", "Hier"]]} />
        <Button size="sm" variant="outline" loading={loading} onClick={load}><RefreshCw className="size-4" /></Button>
        <Button size="sm" variant="outline" disabled={!ops.length} onClick={exportCsv}><Download className="size-4" />CSV</Button>
      </div>}>
      {cash === null ? <div className="h-28 animate-pulse rounded-2xl bg-canvas" /> : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Kpi tone="dark" label="À remettre (mes espèces)" value={fcfa(s.mineTotal)} hint={`${s.mineN} recharge${s.mineN > 1 ? "s" : ""} faite${s.mineN > 1 ? "s" : ""} par moi`} icon={Banknote} />
            <Kpi label="Espèces · toute la caisse" value={fcfa(s.cashTotal)} hint={`${s.cashN} recharge${s.cashN > 1 ? "s" : ""}`} icon={Banknote} />
            <Kpi tone="lime" label="Mobile Money reçu" value={fcfa(s.mmTotal)} hint={`${s.mmN} paiement${s.mmN > 1 ? "s" : ""}${s.mmFees ? ` · ${fcfa(s.mmFees)} de frais payés par les élèves` : ""}`} icon={Smartphone} />
            <Kpi label="Mobile Money non abouti" value={String(s.mmFailed)} hint={s.mmPending ? `+ ${s.mmPending} en attente de confirmation` : "aucun en attente"} icon={Smartphone} />
          </div>

          {s.byStaff.length > 1 && (
            <div className="mt-4">
              <p className="mb-1.5 text-xs font-extrabold uppercase tracking-wider text-muted">Espèces par caissier</p>
              <div className="flex flex-wrap gap-2">
                {s.byStaff.map((b) => <span key={b.name} className="rounded-full bg-canvas px-3 py-1.5 text-sm font-bold">{b.name} · {fcfa(b.total)} <span className="font-semibold text-muted">({b.n})</span></span>)}
              </div>
            </div>
          )}

          <p className="mb-1.5 mt-4 text-xs font-extrabold uppercase tracking-wider text-muted">Opérations</p>
          {ops.length === 0 ? <p className="text-sm text-muted">Aucune recharge {day === "today" ? "aujourd'hui" : "hier"}.</p> : (
            <ul className="max-h-80 divide-y divide-line overflow-y-auto rounded-2xl border border-line">
              {ops.slice(0, 100).map((o, k) => (
                <li key={k} className="flex items-center gap-3 px-3 py-2 text-sm">
                  <span className="w-11 shrink-0 font-bold text-muted">{time(o.at)}</span>
                  <span className={clsx("shrink-0 rounded-full px-2 py-0.5 text-xs font-bold", o.kind === "Espèces" ? "bg-canvas" : "bg-lime-soft")}>{o.kind}</span>
                  <span className="min-w-0 flex-1 truncate"><b>{o.who}</b>{o.code && <span className="text-muted"> · {o.code}</span>}{(o.by || o.extra) && <span className="text-muted"> · {[o.by, o.extra].filter(Boolean).join(" · ")}</span>}</span>
                  <span className={clsx("shrink-0 font-extrabold", o.status === "ok" ? "text-[#15803d]" : o.status === "err" ? "text-err line-through" : "text-[#b45309]")}>{fcfa(o.amount)}</span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </Card>
  );
}
