"use client";
import { useCallback, useEffect, useState } from "react";
import clsx from "clsx";
import { rpc, supabase } from "@/lib/supabase/client";
import { Camera } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PlateScan } from "@/components/plate-scan";
import { Card, PageTitle, Kpi, Segmented, input } from "@/components/admin/ui";
import { Columns, Meter } from "@/components/admin/charts";
import { useToast } from "@/components/ui/toast";
import { addDays, dayNum, dayShort, fcfa, todayISO, SERVICE_LABEL } from "@/lib/format";

type W = {
  prepared: number; served: number; lost: number; cost: number;
  daily: { day: string; prepared: number; served: number; lost: number; cost: number }[];
  dishes: { name: string; lost: number; cost: number; rate: number | null }[];
};
type Plates = { scans: number; avg_left: number; empty_rate: number;
  dishes: { dish: string; scans: number; avg_left: number; worst: { name: string; avg_left: number }[] }[] };
type Row = { id: string; service: "lunch" | "dinner"; prepared_qty: number | null; served_qty: number; sold_qty: number; dish: { name: string } };

export default function WastePage() {
  const toast = useToast();
  const [period, setPeriod] = useState<"7" | "28">("28");
  const [w, setW] = useState<W | null>(null);
  const [day, setDay] = useState(todayISO());
  const [rows, setRows] = useState<Row[]>([]);
  const [plates, setPlates] = useState<Plates | null>(null);
  const [shoot, setShoot] = useState(false);
  const to = todayISO(), from = addDays(to, -(+period - 1));

  const load = useCallback(() => {
    supabase().rpc("admin_waste", { p_from: from, p_to: to }).then(({ data }) => setW(data as W));
  }, [from, to]);
  useEffect(() => { load(); }, [load]);
  const loadPlates = useCallback(() => { rpc<Plates>("plate_waste_stats", { p_from: from, p_to: to }).then((r) => r.ok && setPlates(r as unknown as Plates)); }, [from, to]);
  useEffect(() => { loadPlates(); }, [loadPlates]);
  useEffect(() => {
    supabase().from("menu_items").select("id, service, prepared_qty, served_qty, sold_qty, dish:dishes(name)").eq("service_date", day).order("service")
      .then(({ data }) => setRows((data ?? []) as unknown as Row[]));
  }, [day]);

  async function setPrepared(id: string, v: number | null) {
    const { error } = await supabase().from("menu_items").update({ prepared_qty: v }).eq("id", id);
    if (error) return toast("err", "Enregistrement refusé.");
    setRows((l) => l.map((r) => (r.id === id ? { ...r, prepared_qty: v } : r)));
    load();
  }

  const rate = w && w.prepared ? Math.round((w.lost / w.prepared) * 1000) / 10 : 0;
  const maxLost = Math.max(...(w?.dishes.map((d) => d.lost) ?? [1]), 1);

  return (
    <>
      <PageTitle title="Gaspillage" subtitle="Préparées − servies = portions perdues">
        <Button size="sm" variant="dark" onClick={() => setShoot(true)}><Camera className="size-4" />Analyser une assiette</Button>
        <Segmented value={period} onChange={setPeriod} options={[["7", "7 jours"], ["28", "4 semaines"]]} />
      </PageTitle>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi tone="dark" label="Portions perdues" value={w ? String(w.lost) : "…"} hint={`${rate} % de la production`} />
        <Kpi label="Coût estimé" value={w ? fcfa(w.cost) : "…"} hint="selon les recettes et le coût des ingrédients" />
        <Kpi label="Préparées" value={w ? String(w.prepared) : "…"} />
        <Kpi tone="lime" label="Servies" value={w ? String(w.served) : "…"} />
      </div>

      {/* Gaspillage dans l'assiette : ce que les élèves ne mangent pas (photos analysées par l'IA) */}
      <Card className="mt-4" title="Dans les assiettes" subtitle="Ce que les élèves laissent, mesuré par photo au retour des plateaux">
        {!plates || plates.scans === 0 ? (
          <p className="py-4 text-sm text-muted">Aucune assiette analysée sur la période. Au retour des plateaux, l&apos;agent touche 📷 sur le scanner (ou « Analyser une assiette » ici) et prend l&apos;assiette en photo.</p>
        ) : (
          <>
            <div className="mb-3 flex flex-wrap gap-2 text-sm font-bold">
              <span className="rounded-full bg-canvas px-3 py-1">{plates.scans} assiettes analysées</span>
              <span className="rounded-full bg-canvas px-3 py-1">{plates.avg_left}% laissé en moyenne</span>
              <span className="rounded-full bg-ok-soft px-3 py-1 text-[#15803d]">{plates.empty_rate}% d&apos;assiettes vides</span>
            </div>
            <ul className="space-y-2.5">
              {plates.dishes.map((d) => (
                <li key={d.dish}>
                  <div className="flex items-center justify-between gap-2 text-sm"><span className="truncate font-extrabold">{d.dish}</span>
                    <span className="shrink-0 font-bold">{d.avg_left}% laissé <span className="text-muted">· {d.scans} photo{d.scans > 1 ? "s" : ""}</span></span></div>
                  <div className="mt-1 h-2 overflow-hidden rounded-full bg-canvas"><div className={clsx("h-full rounded-full", d.avg_left <= 10 ? "bg-ok" : d.avg_left <= 35 ? "bg-warn" : "bg-err")} style={{ width: `${Math.max(d.avg_left, 2)}%` }} /></div>
                  {d.worst.length > 0 && <p className="mt-1 text-xs font-semibold text-ink-2">💡 Revient le plus : {d.worst.map((w) => `${w.name} (${w.avg_left}%)`).join(", ")}{d.worst[0].avg_left >= 50 ? " → portion trop grosse ou recette à revoir ?" : ""}</p>}
                </li>
              ))}
            </ul>
          </>
        )}
      </Card>
      <PlateScan open={shoot} onClose={() => { setShoot(false); loadPlates(); }} />

      <div className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <Card title="Portions perdues par jour" subtitle="L'objectif : une courbe qui descend grâce aux précommandes">
          {w ? <Columns data={w.daily.map((d) => ({ label: d.day, value: d.lost }))} format={(n) => `${n} portions`}
            label={(l) => `${dayNum(l)}/${l.slice(5, 7)}`} every={period === "28" ? 3 : 1} /> : <div className="h-44 animate-pulse rounded-xl bg-canvas" />}
        </Card>
        <Card title="Par plat">
          <div className="space-y-3">
            {w?.dishes.map((d) => (
              <div key={d.name}>
                <div className="mb-1 flex text-sm"><span className="flex-1 truncate font-bold">{d.name}</span><span className="text-muted">{d.lost} · {d.rate ?? 0} % · {fcfa(d.cost)}</span></div>
                <Meter value={d.lost} max={maxLost} tone={(d.rate ?? 0) > 15 ? "err" : (d.rate ?? 0) > 8 ? "warn" : "ink"} />
              </div>
            ))}
          </div>
        </Card>
      </div>

      <Card className="mt-4" title="Saisie des portions préparées" subtitle="À remplir par le chef après chaque service">
        <div className="mb-4 flex gap-1.5 overflow-x-auto">
          {Array.from({ length: 7 }, (_, i) => addDays(to, -i)).map((d) => (
            <button key={d} onClick={() => setDay(d)} className={clsx("h-9 shrink-0 rounded-full px-3 text-sm font-bold", d === day ? "bg-ink text-white" : "bg-canvas")}>
              {d === to ? "Aujourd'hui" : `${dayShort(d)} ${dayNum(d)}`}
            </button>
          ))}
        </div>
        <div className="grid gap-2 md:grid-cols-2">
          {rows.map((r) => {
            const lost = r.prepared_qty != null ? Math.max(r.prepared_qty - r.served_qty, 0) : null;
            return (
              <div key={r.id} className="flex items-center gap-3 rounded-xl border border-line px-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-bold">{r.dish.name}</p>
                  <p className="text-xs text-muted">{SERVICE_LABEL[r.service]} · {r.sold_qty} vendus · {r.served_qty} servis</p>
                </div>
                <input type="number" min={0} defaultValue={r.prepared_qty ?? ""} key={`${r.id}-${r.prepared_qty}`} placeholder="Prép."
                  onBlur={(e) => { const v = e.target.value === "" ? null : +e.target.value; if (v !== r.prepared_qty) setPrepared(r.id, v); }}
                  className={clsx(input, "h-9 w-20 text-right font-bold")} />
                <span className={clsx("w-16 text-right text-sm font-extrabold", lost ? "text-err" : "text-muted")}>{lost == null ? "—" : `−${lost}`}</span>
              </div>
            );
          })}
        </div>
      </Card>
    </>
  );
}
