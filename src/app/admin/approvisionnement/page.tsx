"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import clsx from "clsx";
import { Bot, Play, Power, Check, X, PackageCheck, Trash2, Send, Settings2, PhoneCall, Bike, AlertTriangle } from "lucide-react";
import { edge, rpc } from "@/lib/supabase/client";
import { Card, PageTitle, Badge, Kpi, Empty, Segmented, input } from "@/components/admin/ui";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { fcfa, time } from "@/lib/format";

type Cfg = { enabled?: boolean; mode?: "simulation" | "reel"; demo_phone?: string | null; horizon_days?: number; auto_limit?: number;
  daily_budget?: number; sim_scenario?: string; hours_from?: string; hours_to?: string; last_tick_at?: string | null };
type Need = { ingredient_id: string; name: string; unit: string; stock: number; threshold: number; need: number; open_qty: number; to_order: number;
  supplier: string | null; product: string | null; units: number | null; est: number | null; declined: boolean };
type Item = { label: string; qty: number; usual_price: number };
type Order = { id: string; supplier_name: string; items: Item[]; budget: number; status: string; quoted_total: number | null; delivery_at: string | null;
  attempts: number; origin: string; reason: string | null; next_call_at: string | null; parent_id: string | null; run_id: string | null; created_at: string };
type Ev = { id: number; at: string; kind: string; message: string; order_id: string };
type Overview = { settings: Cfg; ready: { functions: boolean; voice: boolean; group: boolean }; spent_today: number; needs: Need[]; orders: Order[]; events: Ev[] };

const STATUS: Record<string, [string, "gray" | "ok" | "warn" | "err" | "lime" | "dark"]> = {
  a_approuver: ["Attend votre accord", "warn"], a_appeler: ["À appeler", "gray"], appel_en_cours: ["Appel en cours", "dark"], commande: ["Commandé · à recevoir", "ok"],
  a_valider: ["Prix à valider", "warn"], valide: ["Prix validé · rappel", "lime"], injoignable: ["Injoignable · nouvel essai", "err"], rappeler: ["Rappel prévu", "warn"],
  coursier: ["Coursier", "lime"], refuse: ["Refusé", "err"], annule: ["Annulé", "gray"], reporte: ["Passé au secours", "gray"], recu: ["Reçu", "ok"],
};
const ORIGIN: Record<string, string> = { agent: "🤖 agent", secours: "↪️ secours", equipe: "🛒 équipe" };
const SCENARIOS: [string, string][] = [["varie", "un peu de tout"], ["ok", "tout se passe bien"], ["cher", "trop cher"], ["coursier", "ne livre pas"],
  ["injoignable", "ne répond pas"], ["manque", "article manquant"], ["refuse", "refuse"]];
const sing = (q: number, l: string) => (Number(q) <= 1 ? l.replace(/^(\S+?)eaux(\s|$)/, "$1eau$2").replace(/^(\S+?[^s])s(\s|$)/, "$1$2") : l);
const qty = (n: number) => Number(n).toLocaleString("fr-FR", { maximumFractionDigits: 2 });
const evTone = (k: string) => k === "a_approuver" || k === "a_valider" || k === "alerte_prix" || k === "alerte" ? "bg-warn-soft"
  : k === "commande" || k === "recu" || k === "approuve" ? "bg-ok-soft" : k === "injoignable" || k === "refuse" || k === "sans_secours" ? "bg-err-soft" : "border border-line";

/** Agent d'achats : il commande tout seul quand le stock va manquer, relance, passe au secours, et attend votre accord au-delà d'un montant. */
export default function SupplyAgentPage() {
  const toast = useToast();
  const [data, setData] = useState<Overview | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [tab, setTab] = useState<"commandes" | "stock">("commandes");
  const [showCfg, setShowCfg] = useState(false);
  const [form, setForm] = useState<{ auto_limit: string; daily_budget: string; horizon_days: string; demo_phone: string }>({ auto_limit: "", daily_budget: "", horizon_days: "", demo_phone: "" });
  const [recv, setRecv] = useState<Record<string, string>>({});
  const [chat, setChat] = useState<{ who: "moi" | "agent"; text: string }[]>([]);
  const [msg, setMsg] = useState("");
  const chatEnd = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    const r = await rpc<Overview>("supply_agent_overview");
    if (r.ok) setData(r);
  }, []);
  useEffect(() => { load(); const t = setInterval(load, 3000); return () => clearInterval(t); }, [load]);
  useEffect(() => {
    if (!data || showCfg) return;
    const c = data.settings;
    setForm({ auto_limit: String(c.auto_limit ?? ""), daily_budget: String(c.daily_budget ?? ""), horizon_days: String(c.horizon_days ?? ""), demo_phone: c.demo_phone ?? "" });
  }, [data, showCfg]);
  useEffect(() => { chatEnd.current?.scrollIntoView({ block: "nearest" }); }, [chat]);

  async function configure(patch: Record<string, unknown>, ok?: string) {
    setBusy(Object.keys(patch)[0]);
    const r = await rpc<{ settings: Cfg }>("supply_agent_configure", { p_cfg: patch });
    setBusy(null);
    if (!r.ok) return toast("err", r.message);
    setData((d) => (d ? { ...d, settings: r.settings } : d));
    if (ok) toast("ok", ok);
  }

  async function saveForm() {
    await configure({ auto_limit: Number(form.auto_limit) || 0, daily_budget: Number(form.daily_budget) || 0, horizon_days: Number(form.horizon_days) || 3, demo_phone: form.demo_phone }, "Réglages enregistrés.");
    setShowCfg(false);
  }

  async function runNow() {
    setBusy("run");
    const r = await rpc<{ planned: number; calls: number; reroutes: number; couriers: number }>("supply_agent_run");
    setBusy(null);
    if (!r.ok) return toast("err", r.message);
    const parts = [r.planned && `${r.planned} commande(s)`, r.calls && `${r.calls} appel(s)`, r.reroutes && `${r.reroutes} secours`, r.couriers && `${r.couriers} coursier(s)`].filter(Boolean);
    toast("ok", parts.length ? `L'agent a lancé : ${parts.join(", ")}.` : "Rien à commander pour l'instant : le stock suffit.");
    load();
  }

  async function act(id: string, fn: string, args: Record<string, unknown>, ok: string) {
    setBusy(id);
    const r = await rpc(fn, args);
    setBusy(null);
    if (!r.ok) return toast("err", r.message);
    toast("ok", ok); load();
  }

  async function send() {
    const text = msg.trim();
    if (!text) return;
    setChat((c) => [...c, { who: "moi", text }]); setMsg(""); setBusy("chat");
    const r = await edge<{ reply: string }>("supply-agent", { action: "chat", text });
    setBusy(null);
    setChat((c) => [...c, { who: "agent", text: r.ok ? r.reply : r.message }]);
    load();
  }

  const cfg = data?.settings ?? {};
  const orders = data?.orders ?? [];
  const waiting = orders.filter((o) => ["a_approuver", "a_valider"].includes(o.status));
  const toReceive = orders.filter((o) => o.status === "commande");
  const calling = orders.filter((o) => ["a_appeler", "appel_en_cours", "injoignable", "rappeler", "valide"].includes(o.status));
  const toOrder = (data?.needs ?? []).filter((n) => n.to_order > 0);

  return (
    <>
      <PageTitle title="Agent d'achats" subtitle="Il commande tout seul quand le stock va manquer, relance les fournisseurs, passe au secours et vous demande votre accord au-delà d'un montant">
        <Button variant={cfg.enabled ? "dark" : "primary"} loading={busy === "enabled"} onClick={() => configure({ enabled: !cfg.enabled }, cfg.enabled ? "Agent arrêté." : "Agent en marche : il vérifie le stock toutes les 30 s.")}>
          <Power className="size-4" />{cfg.enabled ? "Arrêter l'agent" : "Mettre l'agent en marche"}
        </Button>
        <Button variant="outline" loading={busy === "run"} onClick={runNow}><Play className="size-4" />Lancer maintenant</Button>
      </PageTitle>

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <div className="col-span-2 lg:col-span-1"><Kpi label="Engagé aujourd'hui" value={fcfa(data?.spent_today ?? 0)} hint={`budget du jour ${fcfa(cfg.daily_budget ?? 0)}`} tone="dark" /></div>
        <Kpi label="Attend votre accord" value={String(waiting.length)} hint={`au-delà de ${fcfa(cfg.auto_limit ?? 0)}`} tone={waiting.length ? "lime" : undefined} />
        <Kpi label="Appels à passer" value={String(calling.length)} hint={orders.some((o) => o.status === "appel_en_cours") ? "un appel en cours" : "relances comprises"} />
        <Kpi label="À recevoir" value={String(toReceive.length)} hint={toReceive.length ? fcfa(toReceive.reduce((s, o) => s + (o.quoted_total ?? o.budget), 0)) : "rien en route"} />
      </div>

      <Card className="mb-4" title="État de l'agent"
        action={<Button size="sm" variant="outline" onClick={() => setShowCfg((v) => !v)}><Settings2 className="size-4" />Réglages</Button>}>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <Badge tone={cfg.enabled ? "ok" : "gray"}><Bot className="size-3" />{cfg.enabled ? "En marche" : "À l'arrêt"}</Badge>
          <Badge tone={cfg.mode === "reel" ? "dark" : "gray"}>{cfg.mode === "reel" ? "Appels réels (Retell)" : "Appels simulés"}</Badge>
          {cfg.demo_phone && <Badge tone="lime"><PhoneCall className="size-3" />Démo : tous les appels vers {cfg.demo_phone}</Badge>}
          {data && !data.ready.functions && <Badge tone="err"><AlertTriangle className="size-3" />Adresse des fonctions manquante (réglage Jean)</Badge>}
          {cfg.last_tick_at && <span className="text-xs text-muted">Dernier passage : {time(cfg.last_tick_at)}</span>}
        </div>
        {showCfg && (
          <div className="mt-4 grid gap-3 border-t border-line pt-4 sm:grid-cols-2 lg:grid-cols-4">
            <label className="text-sm font-bold">Accord demandé au-delà de (F)
              <input type="number" min={0} value={form.auto_limit} onChange={(e) => setForm({ ...form, auto_limit: e.target.value })} className={clsx(input, "mt-1 w-full")} />
            </label>
            <label className="text-sm font-bold">Budget par jour (F)
              <input type="number" min={0} value={form.daily_budget} onChange={(e) => setForm({ ...form, daily_budget: e.target.value })} className={clsx(input, "mt-1 w-full")} />
            </label>
            <label className="text-sm font-bold">Menus pris en compte (jours)
              <input type="number" min={1} max={7} value={form.horizon_days} onChange={(e) => setForm({ ...form, horizon_days: e.target.value })} className={clsx(input, "mt-1 w-full")} />
            </label>
            <label className="text-sm font-bold">Numéro de démo (vous jouez le fournisseur)
              <input value={form.demo_phone} onChange={(e) => setForm({ ...form, demo_phone: e.target.value })} placeholder="vide = vrais numéros" className={clsx(input, "mt-1 w-full")} />
            </label>
            <div className="sm:col-span-2">
              <p className="mb-1 text-sm font-bold">Appels</p>
              <Segmented value={cfg.mode ?? "simulation"} onChange={(v) => configure({ mode: v }, v === "reel" ? "Appels réels activés." : "Appels simulés.")}
                options={[["simulation", "Simulés"], ["reel", "Réels (Retell)"]]} />
            </div>
            <label className="text-sm font-bold sm:col-span-2">Simulation : comment réagit le fournisseur
              <select value={cfg.sim_scenario ?? "varie"} onChange={(e) => configure({ sim_scenario: e.target.value }, "Scénario changé.")} className={clsx(input, "mt-1 w-full")}>
                {SCENARIOS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </label>
            <div className="flex gap-2 sm:col-span-2 lg:col-span-4">
              <Button loading={busy === "auto_limit"} onClick={saveForm}><Check className="size-4" />Enregistrer</Button>
              <Button variant="ghost" onClick={() => setShowCfg(false)}>Fermer</Button>
            </div>
          </div>
        )}
      </Card>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
        <div className="min-w-0 space-y-4">
          <Card pad={false} title={tab === "commandes" ? "Commandes de l'agent" : "Stock surveillé"}
            subtitle={tab === "commandes" ? "Les plus récentes d'abord · détail de chaque appel dans Appels fournisseurs" : "Stock + déjà en route − menus à venir, comparé au seuil"}
            action={<Segmented value={tab} onChange={setTab} options={[["commandes", "Commandes"], ["stock", `Stock${toOrder.length ? ` · ${toOrder.length}` : ""}`]]} />}>
            {tab === "stock" ? (
              (data?.needs.length ?? 0) === 0 ? <div className="p-5"><Empty>Tout le stock est au-dessus des seuils.</Empty></div> : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead><tr className="border-y border-line bg-canvas text-left text-xs font-bold uppercase tracking-wider text-muted">
                      <th className="px-5 py-2.5">Ingrédient</th><th className="px-2 text-right">Stock</th><th className="px-2 text-right">Menus</th>
                      <th className="px-2 text-right">En route</th><th className="px-5">L&apos;agent prévoit</th></tr></thead>
                    <tbody>
                      {data?.needs.map((n) => (
                        <tr key={n.ingredient_id} className="border-b border-line last:border-0">
                          <td className="px-5 py-2.5"><span className="font-bold">{n.name}</span><span className="block text-xs text-muted">seuil {qty(n.threshold)} {n.unit}</span></td>
                          <td className={clsx("px-2 text-right font-bold", n.stock < n.threshold && "text-err")}>{qty(n.stock)} {n.unit}</td>
                          <td className="px-2 text-right text-muted">{n.need > 0 ? `${qty(n.need)} ${n.unit}` : "—"}</td>
                          <td className="px-2 text-right text-muted">{n.open_qty > 0 ? `${qty(n.open_qty)} ${n.unit}` : "—"}</td>
                          <td className="px-5 text-xs">
                            {n.to_order <= 0 ? <Badge tone="ok">Suffisant</Badge>
                              : n.declined ? <Badge tone="gray">Refusé par l&apos;équipe aujourd&apos;hui</Badge>
                              : n.supplier ? <span><b>{n.units} {n.units != null && n.product ? sing(n.units, n.product) : ""}</b> chez {n.supplier}{n.est != null && ` · ≈ ${fcfa(n.est)}`}</span>
                              : <Badge tone="warn">Pas de fournisseur : fiche de courses</Badge>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )
            ) : orders.length === 0 ? <div className="p-5"><Empty>L&apos;agent n&apos;a encore rien commandé. « Lancer maintenant » vérifie le stock tout de suite.</Empty></div> : (
              <ul>
                {orders.map((o) => {
                  const s = STATUS[o.status] ?? [o.status, "gray"];
                  return (
                    <li key={o.id} className="border-b border-line px-5 py-3.5 last:border-0">
                      <div className="flex items-start gap-3">
                        <div className="min-w-0 flex-1">
                          <p className="font-extrabold">{o.supplier_name} <span className="text-xs font-semibold text-muted">· {ORIGIN[o.origin] ?? o.origin} · {time(o.created_at)}</span></p>
                          <p className="text-sm">{o.items.map((i) => `${qty(i.qty)} ${sing(i.qty, i.label)}`).join(", ")}</p>
                          <p className="text-xs text-muted">
                            Budget {fcfa(o.budget)}{o.quoted_total != null && <> · prix obtenu <b className={o.quoted_total > o.budget * 1.1 ? "text-err" : "text-ink"}>{fcfa(o.quoted_total)}</b></>}
                            {o.delivery_at && <> · livraison {o.delivery_at}</>}
                            {o.attempts > 0 && <> · {o.attempts} appel{o.attempts > 1 ? "s" : ""}</>}
                            {o.next_call_at && ["injoignable", "rappeler"].includes(o.status) && <> · prochain appel {time(o.next_call_at)}</>}
                          </p>
                          {o.reason && o.origin === "agent" && <p className="mt-1 text-xs text-muted">Pourquoi : {o.reason}</p>}
                        </div>
                        <Badge tone={s[1]}>{s[0]}</Badge>
                      </div>
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        {(o.status === "a_approuver" || o.status === "a_valider") && (
                          <>
                            <Button size="sm" loading={busy === o.id} onClick={() => act(o.id, "supplier_order_decide", { p_order: o.id, p_accept: true }, o.status === "a_approuver" ? "Accord donné : l'agent appelle." : "Prix accepté : l'agent rappelle pour confirmer.")}>
                              <Check className="size-4" />{o.status === "a_approuver" ? "Approuver" : `Accepter ${fcfa(o.quoted_total)}`}</Button>
                            <Button size="sm" variant="danger" onClick={() => act(o.id, "supplier_order_decide", { p_order: o.id, p_accept: false }, o.status === "a_approuver" ? "Commande refusée." : "Prix refusé : l'agent passe au secours.")}>
                              <X className="size-4" />Refuser</Button>
                          </>
                        )}
                        {o.status === "commande" && (
                          <>
                            <input type="number" min={0} value={recv[o.id] ?? String(o.quoted_total ?? o.budget)} onChange={(e) => setRecv({ ...recv, [o.id]: e.target.value })}
                              className={clsx(input, "h-9 w-32 text-right")} aria-label="Montant payé" />
                            <Button size="sm" loading={busy === o.id} onClick={() => act(o.id, "supplier_order_receive", { p_order: o.id, p_total: Number(recv[o.id] ?? o.quoted_total ?? o.budget) }, "Reçu : stock mis à jour.")}>
                              <PackageCheck className="size-4" />Reçu</Button>
                          </>
                        )}
                        {["a_approuver", "a_appeler", "injoignable", "rappeler", "valide"].includes(o.status) && (
                          <Button size="sm" variant="ghost" onClick={() => act(o.id, "supply_order_cancel", { p_order: o.id }, "Commande annulée.")}><Trash2 className="size-4" />Annuler</Button>
                        )}
                        {o.run_id && <Link href="/admin/livraisons" className="inline-flex h-9 items-center gap-1.5 rounded-full bg-lime px-3.5 text-sm font-bold"><Bike className="size-4" />Suivre le coursier</Link>}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>
        </div>

        <div className="min-w-0 space-y-4">
          <Card title="Parler à l'agent" subtitle="Écrivez-lui comme à un collègue : « où en est le riz ? », « commande 20 poulets », « annule le marché »">
            <div className="mb-3 max-h-72 space-y-2 overflow-y-auto">
              {chat.length === 0 && <p className="text-sm text-muted">Exemples : « qu&apos;est-ce qu&apos;on a commandé aujourd&apos;hui ? » · « commande 2 sacs de riz » · « oui pour Koné »</p>}
              {chat.map((m, k) => (
                <p key={k} className={clsx("max-w-[90%] whitespace-pre-line rounded-2xl px-3 py-2 text-sm", m.who === "moi" ? "ml-auto bg-ink text-white" : "bg-canvas")}>{m.text}</p>
              ))}
              {busy === "chat" && <p className="w-fit rounded-2xl bg-canvas px-3 py-2 text-sm text-muted">L&apos;agent réfléchit…</p>}
              <div ref={chatEnd} />
            </div>
            <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); send(); }}>
              <input value={msg} onChange={(e) => setMsg(e.target.value)} placeholder="Écrire à l'agent…" className={clsx(input, "min-w-0 flex-1")} aria-label="Message à l'agent" />
              <Button type="submit" variant="dark" loading={busy === "chat"} aria-label="Envoyer"><Send className="size-4" /></Button>
            </form>
          </Card>

          <Card title="Ce que fait l'agent" subtitle="En direct : chaque appel, relance, accord et réception">
            {(data?.events.length ?? 0) === 0 ? <Empty>Rien pour l&apos;instant.</Empty> : (
              <ul className="max-h-[560px] space-y-2 overflow-y-auto">
                {data?.events.map((e) => (
                  <li key={e.id} className={clsx("rounded-2xl px-3 py-2 text-sm", evTone(e.kind))}>
                    <p className="whitespace-pre-line">{e.message}</p>
                    <p className="mt-0.5 text-[11px] text-muted">{time(e.at)}</p>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}
