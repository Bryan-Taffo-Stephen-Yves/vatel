"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import clsx from "clsx";
import { CheckCircle2, Clock, XCircle, RefreshCw, ChevronDown, Hand, ArrowRight, PhoneCall } from "lucide-react";
import { supabase } from "@/lib/supabase/client";
import { Card, PageTitle, Badge, Kpi, Empty, Segmented } from "@/components/admin/ui";
import { Button } from "@/components/ui/button";
import { fcfa, time } from "@/lib/format";

// Le point achats pour le chef et l'admin : ce qui est PASSÉ, EN COURS, PAS PASSÉ, et pourquoi.
// Lecture seule : les décisions (approuver, refuser) restent sur la page « Agent d'achats ».

type Item = { label: string; qty: number; unit?: string; usual_price?: number };
type Order = {
  id: string; supplier_name: string; items: Item[]; budget: number; status: string; quoted_total: number | null;
  validated_total: number | null; received_total: number | null; delivery_at: string | null; delivery_mode: string | null;
  attempts: number; origin: string; reason: string | null; parent_id: string | null; call_summary: string | null;
  cancelled_by: string | null; approved_by: string | null; unavailable: string[] | null; dropped: { label?: string }[] | null;
  next_call_at: string | null; created_at: string; updated_at: string;
};
type Ev = { order_id: string; at: string; kind: string; message: string };
type Group = "passe" | "en_cours" | "pas_passe";

const GROUP: Record<string, Group> = {
  commande: "passe", coursier: "passe", recu: "passe",
  a_approuver: "en_cours", a_valider: "en_cours", a_appeler: "en_cours", appel_en_cours: "en_cours", valide: "en_cours",
  injoignable: "en_cours", rappeler: "en_cours",
  refuse: "pas_passe", annule: "pas_passe", reporte: "pas_passe",
};
const LABEL: Record<string, [string, "gray" | "ok" | "warn" | "err" | "lime" | "dark"]> = {
  commande: ["Commandé · à recevoir", "ok"], coursier: ["Coursier envoyé", "lime"], recu: ["Reçu", "ok"],
  a_approuver: ["Attend votre accord", "warn"], a_valider: ["Prix à valider", "warn"], a_appeler: ["À appeler", "gray"],
  appel_en_cours: ["Appel en cours", "dark"], valide: ["Prix validé · rappel", "lime"], injoignable: ["Injoignable · nouvel essai", "err"],
  rappeler: ["Rappel prévu", "warn"], refuse: ["Refusé", "err"], annule: ["Annulé", "gray"], reporte: ["Passé au secours", "gray"],
};
const ORIGIN: Record<string, string> = { agent: "🤖 agent", stock: "📦 stock bas", secours: "↪️ secours", equipe: "🛒 équipe", chef: "👨‍🍳 chef" };
const SELECT = "id, supplier_name, items, budget, status, quoted_total, validated_total, received_total, delivery_at, delivery_mode, attempts, origin, reason, parent_id, call_summary, cancelled_by, approved_by, unavailable, dropped, next_call_at, created_at, updated_at";

const amount = (o: Order) => o.received_total ?? o.validated_total ?? o.quoted_total;
// Le libellé contient déjà l'unité (« sacs de farine », « kg de pommes de terre ») ; au singulier pour 1
const sing = (q: number, l: string) => (Number(q) <= 1 ? l.replace(/^(\S+?)eaux(\s|$)/, "$1eau$2").replace(/^(\S+?[^s])s(\s|$)/, "$1$2") : l);
const itemsText = (o: Order) => (o.items ?? []).map((i) => `${Number(i.qty).toLocaleString("fr-FR")} ${sing(i.qty, i.label)}`).join(", ");
const dayStart = (daysBack: number) => {
  const d = new Date(); d.setUTCHours(0, 0, 0, 0); d.setUTCDate(d.getUTCDate() - daysBack); return d.toISOString(); // Abidjan = UTC
};

/** Pourquoi une commande n'est pas passée (ou ce qui bloque), en une phrase. */
function why(o: Order, child: Order | undefined, last: Ev | undefined): string | null {
  const parts: string[] = [];
  if (o.status === "annule") parts.push(o.cancelled_by ? `Annulée par ${o.cancelled_by}` : "Annulée");
  if (o.status === "refuse") parts.push(o.cancelled_by ? `Refusée par ${o.cancelled_by}` : "Refusée (prix ou conditions)");
  if (o.unavailable?.length) parts.push(`Manquant chez ce fournisseur : ${o.unavailable.join(", ")}`);
  if (o.dropped?.length) parts.push(`Retiré : ${o.dropped.map((d) => d.label).filter(Boolean).join(", ")}`);
  if (o.status === "injoignable") parts.push(`Ne répond pas (${o.attempts} essai${o.attempts > 1 ? "s" : ""})${o.next_call_at ? ` · nouvel essai à ${time(o.next_call_at)}` : ""}`);
  if (o.status === "rappeler" && o.next_call_at) parts.push(`Rappel prévu à ${time(o.next_call_at)}`);
  if (child) parts.push(`Relayé chez ${child.supplier_name} (${LABEL[child.status]?.[0] ?? child.status})`);
  if (!parts.length && GROUP[o.status] === "pas_passe" && (o.call_summary || last)) parts.push(o.call_summary ?? last!.message);
  return parts.length ? parts.join(" · ") : null;
}

export default function SupplierOrdersPoint() {
  const [period, setPeriod] = useState<"jour" | "semaine">("jour");
  const [orders, setOrders] = useState<Order[] | null>(null);
  const [events, setEvents] = useState<Ev[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const sb = supabase();
    const { data, error } = await sb.from("supplier_orders").select(SELECT)
      .gte("created_at", dayStart(period === "jour" ? 0 : 6)).order("created_at", { ascending: false }).limit(300);
    if (error) { setErr("Lecture impossible (réservé à la cuisine et à l'administration)."); setLoading(false); return; }
    const list = (data ?? []) as Order[];
    setOrders(list); setErr(null);
    if (list.length) {
      const { data: ev } = await sb.from("supply_events").select("order_id, at, kind, message")
        .in("order_id", list.map((o) => o.id)).order("id", { ascending: false }).limit(1000);
      setEvents((ev ?? []) as Ev[]);
    } else setEvents([]);
    setLoading(false);
  }, [period]);

  useEffect(() => { load(); const id = setInterval(load, 30_000); return () => clearInterval(id); }, [load]);

  const childOf = useMemo(() => new Map((orders ?? []).filter((o) => o.parent_id).map((o) => [o.parent_id!, o])), [orders]);
  const evOf = useMemo(() => {
    const m = new Map<string, Ev[]>();
    for (const e of events) m.set(e.order_id, [...(m.get(e.order_id) ?? []), e]);
    return m;
  }, [events]);
  const by = (g: Group) => (orders ?? []).filter((o) => (GROUP[o.status] ?? "en_cours") === g);
  const passe = by("passe"), enCours = by("en_cours"), pasPasse = by("pas_passe");
  const toDecide = enCours.filter((o) => o.status === "a_approuver" || o.status === "a_valider");
  const totalPasse = passe.reduce((a, o) => a + (amount(o) ?? 0), 0);
  const budgetPasse = passe.reduce((a, o) => a + (o.budget ?? 0), 0);
  const gap = budgetPasse ? Math.round(((totalPasse - budgetPasse) / budgetPasse) * 100) : 0;

  const Row = ({ o }: { o: Order }) => {
    const [label, tone] = LABEL[o.status] ?? [o.status, "gray" as const];
    const evs = evOf.get(o.id) ?? [];
    const reason = why(o, childOf.get(o.id), evs[0]);
    const a = amount(o);
    const isOpen = open === o.id;
    return (
      <li className="border-b border-line last:border-0">
        <button onClick={() => setOpen(isOpen ? null : o.id)} className="flex w-full items-start gap-3 px-5 py-3 text-left hover:bg-canvas/60">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <p className="font-extrabold">{o.supplier_name}</p>
              <Badge tone={tone}>{label}</Badge>
              {ORIGIN[o.origin] && <span className="text-xs font-semibold text-muted">{ORIGIN[o.origin]}</span>}
            </div>
            <p className="mt-0.5 line-clamp-2 text-sm text-ink-2">{itemsText(o)}</p>
            {reason && <p className={clsx("mt-1 text-[13px] font-semibold", GROUP[o.status] === "pas_passe" ? "text-err" : "text-[#b45309]")}>{reason}</p>}
            {GROUP[o.status] === "passe" && (o.delivery_at || o.delivery_mode) && (
              <p className="mt-1 text-[13px] font-semibold text-[#15803d]">
                {o.status === "recu" ? "Livré" : `Livraison ${o.delivery_mode === "coursier" ? "par coursier" : o.delivery_mode === "retrait" ? "à retirer" : "par le fournisseur"}`}
                {o.delivery_at && o.status !== "recu" ? ` · ${o.delivery_at}` : ""}{o.approved_by ? ` · validé par ${o.approved_by}` : ""}
              </p>
            )}
          </div>
          <div className="shrink-0 text-right">
            <p className="font-extrabold">{a != null ? fcfa(a) : "—"}</p>
            {a != null && o.budget > 0 && a !== o.budget && (
              <p className={clsx("text-xs font-bold", a > o.budget ? "text-err" : "text-[#15803d]")}>
                {a > o.budget ? "+" : ""}{Math.round(((a - o.budget) / o.budget) * 100)} % vs habituel
              </p>
            )}
            <p className="text-xs text-muted">{time(o.created_at)}{period === "semaine" ? ` · ${new Date(o.created_at).toLocaleDateString("fr-FR", { day: "numeric", month: "short", timeZone: "Africa/Abidjan" })}` : ""}</p>
          </div>
          <ChevronDown className={clsx("mt-1 size-4 shrink-0 text-muted transition", isOpen && "rotate-180")} />
        </button>
        {isOpen && (
          <div className="px-5 pb-4">
            {o.reason && <p className="mb-2 text-xs text-muted">Pourquoi cette commande : {o.reason}</p>}
            {o.call_summary && <p className="mb-2 rounded-xl bg-canvas px-3 py-2 text-[13px]"><PhoneCall className="mr-1 inline size-3.5" />{o.call_summary}</p>}
            {evs.length === 0 ? <p className="text-xs text-muted">Aucun événement enregistré.</p> : (
              <ol className="space-y-1">
                {[...evs].reverse().map((e, k) => (
                  <li key={k} className="flex gap-2 text-[13px]"><span className="w-11 shrink-0 font-bold text-muted">{time(e.at)}</span><span>{e.message}</span></li>
                ))}
              </ol>
            )}
          </div>
        )}
      </li>
    );
  };

  const Section = ({ title, icon: I, list, tone, empty }: { title: string; icon: typeof Clock; list: Order[]; tone: string; empty: string }) => (
    <Card pad={false} title={`${title} · ${list.length}`} action={<I className={clsx("size-5", tone)} />}>
      {list.length === 0 ? <p className="px-5 pb-5 text-sm text-muted">{empty}</p> : <ul>{list.map((o) => <Row key={o.id} o={o} />)}</ul>}
    </Card>
  );

  return (
    <>
      <PageTitle title="Commandes fournisseurs" subtitle="Le point : ce qui est passé, ce qui est en cours, ce qui n'est pas passé et pourquoi">
        <Segmented value={period} onChange={setPeriod} options={[["jour", "Aujourd'hui"], ["semaine", "7 jours"]]} />
        <Button variant="outline" size="sm" loading={loading} onClick={load}><RefreshCw className="size-4" />Actualiser</Button>
      </PageTitle>

      {err && <p className="mb-4 rounded-2xl bg-err-soft px-4 py-3 text-sm font-bold text-err">{err}</p>}
      {orders === null && !err && <div className="h-64 animate-pulse rounded-[22px] bg-card" />}

      {orders && (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Kpi tone="dark" label="✅ Passé" value={String(passe.length)} hint={`${fcfa(totalPasse)}${gap ? ` · ${gap > 0 ? "+" : ""}${gap} % vs prix habituels` : ""}`} icon={CheckCircle2} />
            <Kpi label="⏳ En cours" value={String(enCours.length)} hint={toDecide.length ? `dont ${toDecide.length} à décider` : "appels, relances, rappels"} icon={Clock} />
            <Kpi label="❌ Pas passé" value={String(pasPasse.length)} hint="refusé, annulé ou relayé au secours" icon={XCircle} />
            <Kpi tone="lime" label="📦 Reçu" value={String(passe.filter((o) => o.status === "recu").length)} hint={`sur ${passe.length} commande${passe.length > 1 ? "s" : ""} passée${passe.length > 1 ? "s" : ""}`} />
          </div>

          {toDecide.length > 0 && (
            <Link href="/admin/approvisionnement" className="mt-4 flex items-center gap-3 rounded-[22px] bg-warn-soft px-5 py-4 font-bold text-ink">
              <Hand className="size-5 shrink-0 text-[#b45309]" />
              <span className="flex-1">{toDecide.length} commande{toDecide.length > 1 ? "s attendent" : " attend"} votre accord ({toDecide.map((o) => o.supplier_name).join(", ")})</span>
              <ArrowRight className="size-4" />
            </Link>
          )}

          {orders.length === 0 ? (
            <div className="mt-4"><Empty>{period === "jour" ? "Aucune commande fournisseur aujourd'hui" : "Aucune commande fournisseur cette semaine"}</Empty></div>
          ) : (
            <div className="mt-4 grid gap-4 xl:grid-cols-3">
              <Section title="✅ Passé" icon={CheckCircle2} list={passe} tone="text-[#15803d]" empty="Rien de commandé pour l'instant." />
              <Section title="⏳ En cours" icon={Clock} list={enCours} tone="text-[#b45309]" empty="Aucun appel en cours." />
              <Section title="❌ Pas passé" icon={XCircle} list={pasPasse} tone="text-err" empty="Tout est passé 👍" />
            </div>
          )}
        </>
      )}
    </>
  );
}
