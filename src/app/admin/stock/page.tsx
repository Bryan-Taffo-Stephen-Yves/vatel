"use client";
import { useCallback, useEffect, useState } from "react";
import clsx from "clsx";
import { Plus, ClipboardCheck, PackagePlus, PackageMinus, AlertTriangle } from "lucide-react";
import { rpc, supabase } from "@/lib/supabase/client";
import { Card, PageTitle, Badge, Kpi, input } from "@/components/admin/ui";
import { Meter } from "@/components/admin/charts";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import { useToast } from "@/components/ui/toast";
import { dateTime, fcfa } from "@/lib/format";

type Ing = { id: string; name: string; unit: string; stock_qty: number; alert_threshold: number; unit_cost: number };
// Durée de conservation (jours) ; vide = produit sec. Sert à l'agent d'achats : le frais n'est acheté que pour ses jours.
const SHELF: [string, string][] = [["", "sec"], ["1", "1 jour"], ["2", "2 jours"], ["3", "3 jours"], ["4", "4 jours"], ["5", "5 jours"], ["7", "1 semaine"], ["14", "2 semaines"], ["30", "1 mois"]];
type Mv = { id: string; type: "in" | "out" | "loss" | "adjust"; qty: number; reason: string | null; created_at: string; ingredient: { name: string; unit: string } };

const MV: Record<Mv["type"], { label: string; tone: "ok" | "gray" | "err" | "warn" }> = {
  in: { label: "Entrée", tone: "ok" }, out: { label: "Consommation", tone: "gray" }, loss: { label: "Perte", tone: "err" }, adjust: { label: "Inventaire", tone: "warn" },
};
const num = (n: number) => Number(n).toLocaleString("fr-FR", { maximumFractionDigits: 3 });

export default function StockPage() {
  const toast = useToast();
  const [ings, setIngs] = useState<Ing[]>([]);
  const [mvs, setMvs] = useState<Mv[]>([]);
  const [form, setForm] = useState<{ ing: Ing; mode: "in" | "loss" | "count" } | null>(null);
  const [qty, setQty] = useState("");
  const [reason, setReason] = useState("");
  const [creating, setCreating] = useState(false);
  const [shelf, setShelf] = useState<Record<string, number | null> | null>(null);
  // Risques de rupture : besoin prévu aujourd'hui / demain plus grand que stock + en route
  const [risks, setRisks] = useState<{ name: string; unit: string; day_label: string; missing: number; need: number }[]>([]);
  useEffect(() => {
    supabase().rpc("stock_risks").then(({ data }) => setRisks(((data as { risks?: typeof risks } | null)?.risks) ?? []));
  }, [ings]);
  async function setShelfLife(i: Ing, v: string) {
    const r = await rpc("ingredient_set_shelf_life", { p_ingredient: i.id, p_days: v ? +v : null });
    if (!r.ok) return toast("err", r.message);
    setShelf((x) => ({ ...(x ?? {}), [i.id]: v ? +v : null }));
    toast("ok", v ? `${i.name} : se garde ${SHELF.find((o) => o[0] === v)?.[1]} — l'agent n'en achète que pour ces jours-là.` : `${i.name} : produit sec (réserve gardée).`);
  }
  const [nw, setNw] = useState({ name: "", unit: "kg", alert_threshold: "", unit_cost: "" });

  const load = useCallback(async () => {
    const sb = supabase();
    const [a, sl, b] = await Promise.all([
      sb.from("ingredients").select("id, name, unit, stock_qty, alert_threshold, unit_cost").order("name"),
      sb.from("ingredients").select("id, shelf_life_days"),
      sb.from("stock_movements").select("id, type, qty, reason, created_at, ingredient:ingredients(name, unit)").order("created_at", { ascending: false }).limit(25),
    ]);
    setIngs((a.data ?? []) as Ing[]);
    setShelf(Object.fromEntries(((sl.data ?? []) as { id: string; shelf_life_days: number | null }[]).map((x) => [x.id, x.shelf_life_days])));
    setMvs((b.data ?? []) as unknown as Mv[]);
  }, []);
  useEffect(() => { load(); }, [load]);

  async function save() {
    if (!form) return;
    const v = parseFloat(qty.replace(",", "."));
    if (!(v >= 0)) return toast("err", "Quantité invalide.");
    if (form.mode === "count") {
      const r = await rpc("stock_inventory", { p_ingredient_id: form.ing.id, p_counted: v, p_reason: reason || "Inventaire" });
      if (!r.ok) return toast("err", r.message);
    } else {
      const { error } = await supabase().from("stock_movements").insert({ ingredient_id: form.ing.id, type: form.mode, qty: v, reason: reason || null });
      if (error) return toast("err", "Enregistrement refusé.");
    }
    toast("ok", "Stock mis à jour.");
    setForm(null); setQty(""); setReason(""); load();
  }

  async function create() {
    const { error } = await supabase().from("ingredients").insert({
      name: nw.name.trim(), unit: nw.unit, alert_threshold: +nw.alert_threshold || 0, unit_cost: +nw.unit_cost || 0,
    });
    if (error) return toast("err", "Création impossible (nom déjà utilisé ?).");
    setCreating(false); setNw({ name: "", unit: "kg", alert_threshold: "", unit_cost: "" }); load();
  }

  const low = ings.filter((i) => i.stock_qty < i.alert_threshold);
  const value = ings.reduce((s, i) => s + i.stock_qty * i.unit_cost, 0);

  return (
    <>
      <PageTitle title="Stock" subtitle="Les portions servies sont déduites automatiquement selon les recettes">
        <Button size="sm" variant="dark" onClick={() => setCreating(true)}><Plus className="size-4" />Ingrédient</Button>
      </PageTitle>
      {risks.length > 0 && (
        <div className="mb-4 rounded-2xl bg-err-soft px-4 py-3 text-sm font-semibold text-err">
          <p className="flex items-center gap-2 font-extrabold"><AlertTriangle className="size-4" />Risque de rupture (d&apos;après les prévisions)</p>
          <ul className="mt-1 list-disc pl-6">
            {risks.map((r) => <li key={r.name}>{r.name} : il manque {Number(r.missing).toLocaleString("fr-FR")} {r.unit} pour {r.day_label} (besoin {Number(r.need).toLocaleString("fr-FR")} {r.unit})</li>)}
          </ul>
          <a href="/admin/courses" className="mt-1 inline-block underline">Voir le point des achats</a>
        </div>
      )}
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-3">
        <Kpi label="Ingrédients suivis" value={String(ings.length)} />
        <Kpi tone={low.length ? "dark" : undefined} icon={AlertTriangle} label="Sous le seuil" value={String(low.length)} hint={low.map((i) => i.name).join(", ") || "Aucun"} />
        <Kpi tone="lime" label="Valeur du stock" value={fcfa(value)} />
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <Card pad={false}>
          <div className="divide-y divide-line">
            {ings.map((i) => {
              const ratio = i.alert_threshold > 0 ? i.stock_qty / (i.alert_threshold * 3) : 1;
              const isLow = i.stock_qty < i.alert_threshold;
              return (
                <div key={i.id} className="flex flex-wrap items-center gap-3 px-5 py-3">
                  <div className="w-44 min-w-0">
                    <p className="truncate font-bold">{i.name}</p>
                    <p className="text-xs text-muted">seuil {num(i.alert_threshold)} {i.unit} · {fcfa(i.unit_cost)}/{i.unit}</p>
                    {shelf && i.id in shelf && (
                      <label className="mt-0.5 flex items-center gap-1 text-xs text-muted" title="Pour ne pas gaspiller : un produit frais n'est acheté que pour les repas avant qu'il s'abîme">
                        se garde
                        <select value={shelf[i.id] == null ? "" : String(shelf[i.id])} onChange={(e) => setShelfLife(i, e.target.value)}
                          className="rounded-md border border-line bg-card px-1 py-0.5 text-xs font-bold text-ink">
                          {SHELF.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                        </select>
                      </label>
                    )}
                  </div>
                  <div className="min-w-32 flex-1">
                    <Meter value={Math.min(ratio, 1)} max={1} tone={isLow ? "err" : ratio < 0.6 ? "warn" : "ok"} />
                  </div>
                  <p className={clsx("w-24 text-right font-extrabold", isLow && "text-err")}>{num(i.stock_qty)} {i.unit}</p>
                  <div className="flex gap-1">
                    <button title="Entrée (achat)" onClick={() => setForm({ ing: i, mode: "in" })} className="grid size-8 place-items-center rounded-lg bg-ok-soft text-[#15803d]"><PackagePlus className="size-4" /></button>
                    <button title="Perte" onClick={() => setForm({ ing: i, mode: "loss" })} className="grid size-8 place-items-center rounded-lg bg-err-soft text-err"><PackageMinus className="size-4" /></button>
                    <button title="Inventaire" onClick={() => setForm({ ing: i, mode: "count" })} className="grid size-8 place-items-center rounded-lg bg-canvas"><ClipboardCheck className="size-4" /></button>
                  </div>
                </div>
              );
            })}
          </div>
        </Card>

        <Card title="Derniers mouvements">
          <div className="space-y-2.5">
            {mvs.map((m) => (
              <div key={m.id} className="flex items-center gap-3 text-sm">
                <Badge tone={MV[m.type].tone}>{MV[m.type].label}</Badge>
                <span className="flex-1 truncate"><b>{m.ingredient.name}</b> <span className="text-muted">{m.reason}</span></span>
                <span className="font-bold">{m.type === "in" || (m.type === "adjust" && m.qty > 0) ? "+" : "−"}{num(Math.abs(m.qty))} {m.ingredient.unit}</span>
                <span className="w-24 text-right text-xs text-muted">{dateTime(m.created_at)}</span>
              </div>
            ))}
          </div>
        </Card>
      </div>

      <Sheet open={!!form} onClose={() => setForm(null)} title={form ? `${form.mode === "in" ? "Entrée" : form.mode === "loss" ? "Perte" : "Inventaire"} · ${form.ing.name}` : ""}>
        {form && (
          <div className="space-y-3">
            <p className="text-sm text-muted">Stock actuel : <b className="text-ink">{num(form.ing.stock_qty)} {form.ing.unit}</b></p>
            <input autoFocus inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value)} placeholder={form.mode === "count" ? `Quantité comptée (${form.ing.unit})` : `Quantité (${form.ing.unit})`} className={clsx(input, "h-12 w-full text-lg font-bold")} />
            <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder={form.mode === "in" ? "Fournisseur / marché" : "Motif"} className={clsx(input, "w-full")} />
            <Button block size="lg" onClick={save}>Enregistrer</Button>
          </div>
        )}
      </Sheet>
      <Sheet open={creating} onClose={() => setCreating(false)} title="Nouvel ingrédient">
        <div className="space-y-3">
          <input value={nw.name} onChange={(e) => setNw({ ...nw, name: e.target.value })} placeholder="Nom" className={clsx(input, "w-full")} />
          <div className="grid grid-cols-3 gap-2">
            <select value={nw.unit} onChange={(e) => setNw({ ...nw, unit: e.target.value })} className={input}>{["kg", "L", "pièce", "botte"].map((u) => <option key={u}>{u}</option>)}</select>
            <input value={nw.alert_threshold} onChange={(e) => setNw({ ...nw, alert_threshold: e.target.value })} placeholder="Seuil" inputMode="decimal" className={input} />
            <input value={nw.unit_cost} onChange={(e) => setNw({ ...nw, unit_cost: e.target.value })} placeholder="Coût/unité" inputMode="numeric" className={input} />
          </div>
          <Button block size="lg" disabled={nw.name.trim().length < 2} onClick={create}>Créer</Button>
        </div>
      </Sheet>
    </>
  );
}
