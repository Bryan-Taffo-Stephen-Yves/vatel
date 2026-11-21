"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import clsx from "clsx";
import { Phone, PhoneCall, Plus, Settings2, Check, X, Bike, Bot, BookOpen, Boxes } from "lucide-react";
import { rpc, supabase } from "@/lib/supabase/client";
import { Card, PageTitle, Badge, Empty, Segmented, input } from "@/components/admin/ui";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { useStaff } from "@/components/admin/admin-shell";
import { dateTime, fcfa, time } from "@/lib/format";

type Supplier = { id: string; name: string; district: string | null; phone: string | null };
type Product = { id: string; supplier_id: string; label: string; unit: string; usual_price: number; default_qty: number; last_price: number | null; is_preferred: boolean };
type Item = { label: string; qty: number; usual_price: number; last_price?: number | null };
type Order = { id: string; supplier_name: string; call_phone: string; items: Item[]; budget: number; status: string; quoted_total: number | null;
  delivery_at: string | null; attempts: number; call_mode: string | null; recording_url: string | null; run_id: string | null; created_at: string };
type Ev = { id: number; at: string; kind: string; message: string };

const STATUS: Record<string, [string, "gray" | "ok" | "warn" | "err" | "lime" | "dark"]> = {
  a_appeler: ["À appeler", "gray"], appel_en_cours: ["Appel en cours", "dark"], commande: ["Commandé", "ok"], a_valider: ["Prix à valider", "warn"],
  valide: ["Prix validé · à rappeler", "lime"], injoignable: ["Injoignable", "err"], rappeler: ["À rappeler", "warn"], coursier: ["Coursier à envoyer", "warn"],
  refuse: ["Refusé", "err"], annule: ["Annulé", "gray"],
};
const sing = (q: number, l: string) => (Number(q) <= 1 ? l.replace(/^(\S+?)eaux(\s|$)/, "$1eau$2").replace(/^(\S+?[^s])s(\s|$)/, "$1$2") : l);
const qty = (n: number) => Number(n).toLocaleString("fr-FR", { maximumFractionDigits: 2 });

/** Appels fournisseurs : l'agent vocal (accent ivoirien) appelle, négocie avec nos prix habituels, l'appli décide. */
export default function CallsPage() {
  const toast = useToast();
  const me = useStaff();
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [orders, setOrders] = useState<Order[] | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [events, setEvents] = useState<Ev[]>([]);
  const [cfg, setCfg] = useState<{ agent_id?: string | null; from_number?: string | null; voice_used?: string | null }>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [tab, setTab] = useState<"commandes" | "carnet">("commandes");
  // Nouvelle commande
  const [sup, setSup] = useState<string>("");
  const [lines, setLines] = useState<Record<string, string>>({});
  const [phone, setPhone] = useState("");
  const [scenario, setScenario] = useState<"ok" | "cher" | "coursier">("ok");
  const [number, setNumber] = useState("");

  const loadOrders = useCallback(() => supabase().from("supplier_orders")
    .select("id, supplier_name, call_phone, items, budget, status, quoted_total, delivery_at, attempts, call_mode, recording_url, run_id, created_at")
    .order("created_at", { ascending: false }).limit(25).then(({ data }) => {
      const l = (data ?? []) as Order[]; setOrders(l); setSel((s) => s ?? l[0]?.id ?? null);
    }), []);

  useEffect(() => {
    supabase().from("suppliers").select("id, name, district, phone").eq("is_active", true).order("name").then(({ data }) => {
      setSuppliers((data ?? []) as Supplier[]); setSup((s) => s || (data?.[0]?.id ?? ""));
    });
    supabase().from("supplier_products").select("id, supplier_id, label, unit, usual_price, default_qty, last_price, is_preferred").order("label")
      .then(({ data }) => setProducts((data ?? []) as Product[]));
    supabase().from("settings").select("value").eq("key", "supplier_calls").maybeSingle().then(({ data }) => {
      const v = (data?.value ?? {}) as typeof cfg; setCfg(v); setNumber(v.from_number ?? "");
    });
    loadOrders();
  }, [loadOrders]);

  // Fil de la commande choisie + statut, toutes les 3 s (la conversation simulée arrive phrase par phrase)
  useEffect(() => {
    if (!sel) return;
    let alive = true;
    const load = () => {
      supabase().from("supply_events").select("id, at, kind, message").eq("order_id", sel).order("id", { ascending: false }).limit(80)
        .then(({ data }) => alive && setEvents((data ?? []) as Ev[]));
      supabase().from("supplier_orders").select("id, supplier_name, call_phone, items, budget, status, quoted_total, delivery_at, attempts, call_mode, recording_url, run_id, created_at")
        .eq("id", sel).maybeSingle().then(({ data }) => alive && data && setOrders((l) => (l ?? []).map((o) => (o.id === sel ? (data as Order) : o))));
    };
    load(); const t = setInterval(load, 3000);
    return () => { alive = false; clearInterval(t); };
  }, [sel]);

  // Quantités par défaut quand on change de fournisseur
  const supProducts = useMemo(() => products.filter((p) => p.supplier_id === sup), [products, sup]);
  useEffect(() => {
    setLines(Object.fromEntries(supProducts.map((p, i) => [p.id, i < 3 ? String(p.default_qty) : ""])));
    setPhone(suppliers.find((s) => s.id === sup)?.phone ?? "");
  }, [sup, supProducts, suppliers]);
  const draftTotal = supProducts.reduce((s, p) => s + (Number(lines[p.id]) || 0) * p.usual_price, 0);

  const order = orders?.find((o) => o.id === sel) ?? null;

  async function fn(body: Record<string, unknown>) {
    const { data, error } = await supabase().functions.invoke("supplier-call", { body });
    if (error || !data?.ok) {
      let m = data?.message ?? data?.erreur;
      if (!m && error && "context" in error) m = (await (error as { context: Response }).context.json().catch(() => null))?.message;
      throw new Error(m ?? "Action impossible.");
    }
    return data;
  }

  async function create() {
    const l = supProducts.filter((p) => Number(lines[p.id]) > 0).map((p) => ({ product_id: p.id, qty: Number(lines[p.id]) }));
    if (!l.length) return toast("err", "Choisis au moins un produit.");
    setBusy("create");
    const r = await rpc<{ order_id: string }>("supplier_order_create", { p_supplier: sup, p_lines: l, p_phone: phone || null });
    setBusy(null);
    if (!r.ok) return toast("err", r.message);
    setSel(r.order_id); toast("ok", "Commande prête : il reste à appeler."); loadOrders();
  }

  async function fromStock() {
    setBusy("stock");
    const r = await rpc<{ count: number }>("supplier_orders_from_stock", { p_phone: phone || null });
    setBusy(null);
    if (!r.ok) return toast("err", r.message);
    toast("ok", r.count ? `${r.count} commande(s) préparée(s) depuis le stock bas.` : "Aucun ingrédient sous le seuil."); setSel(null); loadOrders();
  }

  async function call(simulate: boolean) {
    if (!order) return;
    setBusy(simulate ? "sim" : "call");
    try { await fn({ action: "call", order_id: order.id, simulate, scenario }); toast("ok", simulate ? "Appel simulé lancé 📞" : "L'agent appelle le fournisseur 📞"); }
    catch (e) { toast("err", (e as Error).message); }
    setBusy(null);
  }

  async function setupAgent() {
    setBusy("setup");
    try {
      const d = await fn({ action: "setup" });
      setCfg((c) => ({ ...c, agent_id: d.agent_id, voice_used: d.voix }));
      toast("ok", `Agent prêt · voix ${typeof d.voix_choisie === "string" ? d.voix_choisie : `${d.voix_choisie.nom} (${d.voix_choisie.accent})`}`);
    } catch (e) { toast("err", (e as Error).message); }
    setBusy(null);
  }

  async function saveNumber() {
    const r = await rpc<{ from_number: string | null }>("supplier_calls_set_number", { p_number: number });
    if (!r.ok) return toast("err", r.message);
    setCfg((c) => ({ ...c, from_number: r.from_number })); toast("ok", "Numéro enregistré.");
  }

  async function decide(accept: boolean) {
    const r = await rpc("supplier_order_decide", { p_order: sel, p_accept: accept });
    if (!r.ok) return toast("err", r.message);
    toast("ok", accept ? "Prix accepté : rappelle le fournisseur pour confirmer." : "Prix refusé."); loadOrders();
  }

  async function courier() {
    const r = await rpc<{ run_id: string }>("supplier_order_send_courier", { p_order: sel });
    if (!r.ok) return toast("err", r.message);
    toast("ok", "Tournée créée : va dans Livraisons pour faire partir le coursier."); loadOrders();
  }

  async function setPrice(p: Product, v: string) {
    const n = Number(v);
    if (!n || n === p.usual_price) return;
    const r = await rpc("supplier_product_set_price", { p_id: p.id, p_price: n });
    if (!r.ok) return toast("err", r.message);
    setProducts((l) => l.map((x) => (x.id === p.id ? { ...x, usual_price: n } : x))); toast("ok", "Prix habituel mis à jour.");
  }

  const st = order ? STATUS[order.status] ?? [order.status, "gray"] : null;

  return (
    <>
      <PageTitle title="Appels fournisseurs" subtitle="L'agent vocal appelle avec nos prix habituels, négocie, et l'appli décide">
        <Segmented value={tab} onChange={setTab} options={[["commandes", "Commandes"], ["carnet", "Carnet de prix"]]} />
      </PageTitle>

      <Card className="mb-4" title="Agent vocal" subtitle="Accent et façon de parler ivoiriens · règles de prix dans l'appli"
        action={<Button size="sm" variant="outline" loading={busy === "setup"} onClick={setupAgent}><Settings2 className="size-4" />{cfg.agent_id ? "Mettre à jour l'agent" : "Configurer l'agent"}</Button>}>
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <Badge tone={cfg.agent_id ? "ok" : "warn"}><Bot className="size-3" />{cfg.agent_id ? "Agent prêt" : "Agent à configurer"}</Badge>
          {cfg.voice_used && <span className="text-muted">Voix : {cfg.voice_used}</span>}
          <Badge tone={cfg.from_number ? "ok" : "gray"}><Phone className="size-3" />{cfg.from_number ? `Appelle depuis ${cfg.from_number}` : "Pas de numéro : simulation seulement"}</Badge>
          {me?.role === "admin" && (
            <span className="ml-auto flex items-center gap-2">
              <input value={number} onChange={(e) => setNumber(e.target.value)} placeholder="Numéro Retell, ex. +14155550123" className={clsx(input, "w-60")} aria-label="Numéro Retell" />
              <Button size="sm" variant="dark" onClick={saveNumber}>Enregistrer</Button>
            </span>
          )}
        </div>
      </Card>

      {tab === "carnet" ? (
        <Card title="Carnet de prix" subtitle="Ce qu'on achète chez chaque fournisseur et à quel prix d'habitude : l'agent s'en sert pour négocier" pad={false}>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="border-y border-line bg-canvas text-left text-xs font-bold uppercase tracking-wider text-muted">
                <th className="px-5 py-2.5">Produit</th><th className="px-2">Vendu par</th><th className="px-2 text-right">Prix habituel</th><th className="px-5 text-right">Dernier achat</th></tr></thead>
              <tbody>
                {suppliers.map((s) => {
                  const rows = products.filter((p) => p.supplier_id === s.id);
                  if (!rows.length) return null;
                  return [
                    <tr key={s.id}><td colSpan={4} className="px-5 pb-1 pt-4 text-xs font-extrabold uppercase tracking-wider text-muted">{s.name}{s.district && ` · ${s.district}`}</td></tr>,
                    ...rows.map((p) => (
                      <tr key={p.id} className="border-b border-line last:border-0">
                        <td className="px-5 py-2.5 font-bold">{p.label}</td>
                        <td className="px-2 text-muted">{p.unit}</td>
                        <td className="px-2 text-right">
                          <input type="number" min={1} defaultValue={p.usual_price} onBlur={(e) => setPrice(p, e.target.value)} className={clsx(input, "h-9 w-28 text-right font-bold")} aria-label={`Prix habituel ${p.label}`} />
                        </td>
                        <td className={clsx("px-5 text-right", p.last_price && p.last_price > p.usual_price * 1.1 ? "font-bold text-err" : "text-muted")}>{p.last_price ? fcfa(p.last_price) : "—"}</td>
                      </tr>
                    )),
                  ];
                })}
              </tbody>
            </table>
          </div>
        </Card>
      ) : (
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]">
          <div className="space-y-4">
            <Card title="Nouvelle commande" subtitle="Quantités et prix habituels du carnet">
              <div className="space-y-3">
                <select value={sup} onChange={(e) => setSup(e.target.value)} className={clsx(input, "w-full")} aria-label="Fournisseur">
                  {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}{s.district ? ` · ${s.district}` : ""}</option>)}
                </select>
                <ul className="space-y-1.5">
                  {supProducts.map((p) => (
                    <li key={p.id} className="flex items-center gap-2 text-sm">
                      <input type="number" min={0} step="any" value={lines[p.id] ?? ""} placeholder="0" onChange={(e) => setLines((l) => ({ ...l, [p.id]: e.target.value }))}
                        className={clsx(input, "h-9 w-16 text-right")} aria-label={`Quantité ${p.label}`} />
                      <span className="flex-1">{p.label}</span>
                      <span className="text-xs text-muted">{fcfa(p.usual_price)} / {p.unit}</span>
                    </li>
                  ))}
                </ul>
                <label className="block text-sm font-bold">Numéro à appeler
                  <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+2250700000000" className={clsx(input, "mt-1 w-full")} />
                  <span className="mt-1 block text-xs font-normal text-muted">Pour la démo, mets ton propre numéro : tu joueras le fournisseur.</span>
                </label>
                <div className="flex flex-wrap items-center gap-2">
                  <Button loading={busy === "create"} onClick={create}><Plus className="size-4" />Créer · {fcfa(draftTotal)}</Button>
                  <Button variant="outline" loading={busy === "stock"} onClick={fromStock}><Boxes className="size-4" />Depuis le stock bas</Button>
                </div>
              </div>
            </Card>

            <Card title="Commandes" pad={false}>
              {orders?.length === 0 && <div className="p-5"><Empty>Aucune commande fournisseur</Empty></div>}
              <ul>
                {orders?.map((o) => {
                  const s = STATUS[o.status] ?? [o.status, "gray"];
                  return (
                    <li key={o.id}>
                      <button onClick={() => setSel(o.id)} className={clsx("flex w-full items-center gap-3 border-b border-line px-5 py-3 text-left last:border-0", o.id === sel && "bg-lime-soft")}>
                        <span className="min-w-0 flex-1">
                          <span className="block font-extrabold">{o.supplier_name}</span>
                          <span className="block truncate text-xs text-muted">{o.items.map((i) => `${qty(i.qty)} ${sing(i.qty, i.label)}`).join(", ")}</span>
                        </span>
                        <span className="text-right">
                          <Badge tone={s[1]}>{s[0]}</Badge>
                          <span className="mt-1 block text-[11px] text-muted">{dateTime(o.created_at)}</span>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </Card>
          </div>

          {order && st && (
            <Card title={order.supplier_name} subtitle={`${order.call_phone} · essai ${order.attempts}`} action={<Badge tone={st[1]}>{st[0]}</Badge>}>
              <ul className="mb-3 space-y-1 text-sm">
                {order.items.map((i, k) => (
                  <li key={k} className="flex justify-between gap-2"><span>{qty(i.qty)} {sing(i.qty, i.label)}</span>
                    <span className="text-muted">{fcfa(i.qty * i.usual_price)}</span></li>
                ))}
                <li className="flex justify-between border-t border-line pt-1.5 font-extrabold"><span>Budget (prix habituels)</span><span>{fcfa(order.budget)}</span></li>
                {order.quoted_total != null && (
                  <li className={clsx("flex justify-between font-extrabold", order.quoted_total > order.budget * 1.1 ? "text-err" : "text-lime-deep")}>
                    <span>Prix du fournisseur</span><span>{fcfa(order.quoted_total)}</span></li>
                )}
                {order.delivery_at && <li className="text-muted">Livraison : {order.delivery_at}</li>}
              </ul>

              <div className="mb-4 flex flex-wrap items-center gap-2">
                {["a_appeler", "injoignable", "rappeler", "valide"].includes(order.status) && (
                  <>
                    <Button loading={busy === "call"} disabled={!cfg.from_number || !cfg.agent_id} onClick={() => call(false)}
                      title={!cfg.from_number ? "Ajoute d'abord un numéro Retell" : undefined}><PhoneCall className="size-4" />Appeler</Button>
                    <span className="flex items-center gap-1">
                      <Button variant="outline" loading={busy === "sim"} onClick={() => call(true)}><Bot className="size-4" />Simuler</Button>
                      <select value={scenario} onChange={(e) => setScenario(e.target.value as typeof scenario)} className={clsx(input, "h-11")} aria-label="Scénario de simulation">
                        <option value="ok">prix correct</option><option value="cher">trop cher</option><option value="coursier">ne livre pas</option>
                      </select>
                    </span>
                  </>
                )}
                {order.status === "a_valider" && (
                  <>
                    <Button onClick={() => decide(true)}><Check className="size-4" />Accepter {order.quoted_total != null && fcfa(order.quoted_total)}</Button>
                    <Button variant="danger" onClick={() => decide(false)}><X className="size-4" />Refuser</Button>
                  </>
                )}
                {order.status === "coursier" && (order.run_id
                  ? <Link href="/admin/livraisons" className="flex h-11 items-center gap-2 rounded-full bg-lime px-5 text-sm font-bold"><Bike className="size-4" />Voir la tournée</Link>
                  : <Button onClick={courier}><Bike className="size-4" />Envoyer le coursier</Button>)}
                {order.recording_url && <a href={order.recording_url} target="_blank" rel="noreferrer" className="text-sm font-bold underline">Écouter l&apos;appel</a>}
              </div>

              <p className="mb-2 flex items-center gap-1.5 text-xs font-extrabold uppercase tracking-wider text-muted"><BookOpen className="size-3.5" />Journal de l&apos;appel</p>
              <ul className="max-h-[520px] space-y-2 overflow-y-auto">
                {events.map((e) => {
                  const bot = e.kind === "dialogue" && e.message.startsWith("🤖");
                  const sup = e.kind === "dialogue" && !bot;
                  return (
                    <li key={e.id} className={clsx("max-w-[92%] rounded-2xl px-3 py-2 text-sm",
                      bot ? "ml-auto bg-ink text-white" : sup ? "bg-canvas" : e.kind === "a_valider" || e.kind === "alerte_prix" ? "bg-warn-soft" :
                      e.kind === "commande" ? "bg-ok-soft" : e.kind === "injoignable" || e.kind === "refuse" ? "bg-err-soft" : "border border-line")}>
                      <p className="whitespace-pre-line">{e.message}</p>
                      <p className={clsx("mt-0.5 text-[11px]", bot ? "text-white/60" : "text-muted")}>{time(e.at)}</p>
                    </li>
                  );
                })}
              </ul>
            </Card>
          )}
        </div>
      )}
    </>
  );
}
