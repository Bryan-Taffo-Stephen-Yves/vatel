"use client";
import { useEffect, useState } from "react";
import clsx from "clsx";
import { Printer, Download } from "lucide-react";
import { supabase } from "@/lib/supabase/client";
import { PageTitle, Segmented, downloadCsv } from "@/components/admin/ui";
import { Button } from "@/components/ui/button";
import { Logo } from "@/components/logo";
import { addDays, dayShort, dayNum, fcfa, todayISO } from "@/lib/format";

type Sales = { revenue: number; sales: number; recharges: number; tickets: number; served: number; expired: number; cancelled: number; refunded_expired: number;
  by_service: { label: string; n: number }[]; daily: { day: string; revenue: number; tickets: number }[];
  dishes: { name: string; sold: number; revenue: number; stars: number | null }[] };
type Waste = { prepared: number; served: number; lost: number; cost: number; dishes: { name: string; lost: number; cost: number; rate: number | null }[] };
type Ratings = { dishes: { name: string; avg_stars: number | null; n: number; complaints_30d: number }[]; complaints: { label: string; n: number }[] };
type Stock = { name: string; unit: string; stock_qty: number; alert_threshold: number };

const PERIODS = { "7": "7 jours", "30": "30 jours", mois: "Ce mois-ci" } as const;
type P = keyof typeof PERIODS;
const pct = (a: number, b: number) => (b > 0 ? `${Math.round((100 * a) / b)} %` : "—");

/** Rapport d'activité (guide Vatel) : à imprimer ou enregistrer en PDF, ou à télécharger en CSV. */
export default function ReportsPage() {
  const today = todayISO();
  const [p, setP] = useState<P>("7");
  const from = p === "mois" ? today.slice(0, 8) + "01" : addDays(today, -(Number(p) - 1));
  const [s, setS] = useState<Sales | null>(null);
  const [w, setW] = useState<Waste | null>(null);
  const [r, setR] = useState<Ratings | null>(null);
  const [low, setLow] = useState<Stock[]>([]);

  useEffect(() => {
    setS(null); setW(null);
    const sb = supabase();
    sb.rpc("admin_sales", { p_from: from, p_to: today }).then(({ data }) => setS(data as Sales));
    sb.rpc("admin_waste", { p_from: from, p_to: today }).then(({ data }) => setW(data as Waste));
    sb.rpc("admin_ratings").then(({ data }) => setR(data as Ratings));
    sb.from("ingredients").select("name, unit, stock_qty, alert_threshold").order("name")
      .then(({ data }) => setLow(((data ?? []) as Stock[]).filter((i) => Number(i.stock_qty) < Number(i.alert_threshold))));
  }, [from, today]);

  const rated = (r?.dishes ?? []).filter((d) => d.n > 0);
  const best = [...rated].sort((a, b) => (b.avg_stars ?? 0) - (a.avg_stars ?? 0)).slice(0, 3);
  const worst = [...rated].sort((a, b) => (a.avg_stars ?? 5) - (b.avg_stars ?? 5)).slice(0, 3);

  function csv() {
    if (!s || !w) return;
    downloadCsv(`rapport-${from}-${today}.csv`, [
      ["Rapport d'activité", `${from} au ${today}`], [],
      ["Indicateur", "Valeur"],
      ["Chiffre d'affaires (repas servis)", s.revenue], ["Ventes de tickets", s.sales], ["Recharges", s.recharges],
      ["Tickets vendus", s.tickets], ["Repas servis", s.served], ["Tickets expirés", s.expired], ["Annulations", s.cancelled],
      ["Portions préparées", w.prepared], ["Portions jetées", w.lost], ["Coût du gaspillage (F)", w.cost], [],
      ["Jour", "Chiffre d'affaires", "Repas servis"], ...s.daily.map((d) => [d.day, d.revenue, d.tickets]), [],
      ["Plat", "Servis", "Recettes", "Note"], ...s.dishes.map((d) => [d.name, d.sold, d.revenue, d.stars]),
    ]);
  }

  return (
    <>
      <div className="print:hidden">
        <PageTitle title="Rapports d'activité" subtitle="Bilan de la cantine à imprimer, enregistrer en PDF ou télécharger">
          <div className="flex flex-wrap items-center gap-2">
            <Segmented value={p} onChange={setP} options={Object.entries(PERIODS) as [P, string][]} />
            <Button variant="outline" size="sm" onClick={csv}><Download className="size-4" />CSV</Button>
            <Button size="sm" onClick={() => window.print()}><Printer className="size-4" />Imprimer / PDF</Button>
          </div>
        </PageTitle>
      </div>

      <article className="mx-auto max-w-4xl rounded-[22px] border border-line bg-card p-6 print:max-w-none print:rounded-none print:border-0 print:p-0">
        <header className="flex items-start justify-between gap-4 border-b border-line pb-4">
          <div>
            <Logo />
            <h1 className="mt-3 text-2xl font-extrabold">Rapport d&apos;activité de la cantine</h1>
            <p className="text-sm text-muted">Du {dayShort(from)} {dayNum(from)} au {dayShort(today)} {dayNum(today)} · {PERIODS[p]} · édité le {new Date().toLocaleDateString("fr-FR")}</p>
          </div>
        </header>

        {!s || !w ? <div className="mt-6 h-64 animate-pulse rounded-xl bg-canvas" /> : (
          <>
            <section className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
              {[
                ["Chiffre d'affaires", fcfa(s.revenue), "repas servis"],
                ["Repas servis", String(s.served), `${s.tickets} tickets vendus`],
                ["Gaspillage", pct(w.lost, w.prepared), `${w.lost} portions · ${fcfa(w.cost)}`],
                ["Recharges", fcfa(s.recharges), "Mobile Money et caisse"],
              ].map(([k, v, h]) => (
                <div key={k} className="rounded-2xl bg-canvas p-3 print:border print:border-line">
                  <p className="text-[11px] font-bold uppercase tracking-wider text-muted">{k}</p>
                  <p className="mt-1 text-xl font-extrabold">{v}</p>
                  <p className="text-xs text-muted">{h}</p>
                </div>
              ))}
            </section>

            <Section title="Activité par jour">
              <table className="w-full text-sm">
                <thead><tr className="text-left text-xs text-muted"><th className="py-1">Jour</th><th className="text-right">Repas servis</th><th className="text-right">Chiffre d&apos;affaires</th></tr></thead>
                <tbody>{s.daily.map((d) => (
                  <tr key={d.day} className="border-t border-line"><td className="py-1.5">{dayShort(d.day)} {dayNum(d.day)}</td><td className="text-right">{d.tickets}</td><td className="text-right font-bold">{fcfa(d.revenue)}</td></tr>
                ))}</tbody>
              </table>
            </Section>

            <div className="grid gap-x-6 sm:grid-cols-2 print:grid-cols-2">
              <Section title="Plats les plus servis">
                <ol className="space-y-1 text-sm">{s.dishes.slice(0, 8).map((d, i) => (
                  <li key={d.name} className="flex justify-between gap-2"><span>{i + 1}. {d.name}</span><span className="text-muted">{d.sold} · {fcfa(d.revenue)}{d.stars ? ` · ${d.stars}★` : ""}</span></li>
                ))}{s.dishes.length === 0 && <li className="text-muted">Aucun repas servi sur la période.</li>}</ol>
              </Section>
              <Section title="Tickets par service">
                <ul className="space-y-1 text-sm">{s.by_service.map((b) => <li key={b.label} className="flex justify-between"><span>{b.label}</span><span className="font-bold">{b.n}</span></li>)}</ul>
                <p className="mt-2 text-xs text-muted">{s.expired} expirés (remboursés {fcfa(s.refunded_expired)}) · {s.cancelled} annulés</p>
              </Section>
              <Section title="Gaspillage par plat">
                <ul className="space-y-1 text-sm">{w.dishes.slice(0, 6).map((d) => (
                  <li key={d.name} className="flex justify-between gap-2"><span>{d.name}</span><span className={clsx((d.rate ?? 0) > 15 ? "font-bold text-err" : "text-muted")}>{d.lost} portions · {d.rate ?? 0} %</span></li>
                ))}{w.dishes.length === 0 && <li className="text-muted">Pas de production saisie sur la période.</li>}</ul>
              </Section>
              <Section title="Satisfaction">
                <p className="text-xs font-bold text-muted">Les mieux notés</p>
                <ul className="mb-2 text-sm">{best.map((d) => <li key={d.name} className="flex justify-between"><span>{d.name}</span><span>{d.avg_stars}★ ({d.n})</span></li>)}</ul>
                <p className="text-xs font-bold text-muted">À améliorer</p>
                <ul className="text-sm">{worst.map((d) => <li key={d.name} className="flex justify-between"><span>{d.name}</span><span>{d.avg_stars}★ ({d.n})</span></li>)}</ul>
                {(r?.complaints ?? []).length > 0 && <p className="mt-2 text-xs text-muted">Plaintes : {r!.complaints.slice(0, 3).map((c) => `${c.label} (${c.n})`).join(", ")}</p>}
              </Section>
            </div>

            <Section title="Stock à surveiller">
              {low.length === 0 ? <p className="text-sm text-muted">Aucun ingrédient sous son seuil d&apos;alerte.</p> : (
                <ul className="grid gap-1 text-sm sm:grid-cols-2">{low.map((i) => (
                  <li key={i.name} className="flex justify-between gap-2"><span>{i.name}</span><span className="font-bold text-err">{Number(i.stock_qty)} {i.unit} (seuil {Number(i.alert_threshold)})</span></li>
                ))}</ul>
              )}
            </Section>
          </>
        )}
      </article>
    </>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-6 break-inside-avoid">
      <h2 className="mb-2 border-b border-line pb-1 text-sm font-extrabold uppercase tracking-wider">{title}</h2>
      {children}
    </section>
  );
}
