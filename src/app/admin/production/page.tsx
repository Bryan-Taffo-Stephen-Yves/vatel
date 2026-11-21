"use client";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import clsx from "clsx";
import { Check, ChevronDown, Clock, Info, RefreshCw, Repeat, ShoppingCart, Sparkles, AlertTriangle, Trash2 } from "lucide-react";
import { rpc, supabase } from "@/lib/supabase/client";
import { Card, PageTitle, Badge, Empty, Kpi, input } from "@/components/admin/ui";
import { ServiceBadge } from "@/components/app/service-icon";
import { DishImage } from "@/components/app/dish-image";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { addDays, dayShort, dayNum, dayLong, time, todayISO } from "@/lib/format";
import type { ServiceKind } from "@/lib/types";

type Item = {
  id: string; service: ServiceKind; dish: string; photo_url: string | null;
  expected: number; share: number; popularity: number;
  seconds_rate: number; seconds_basis: "observed" | "prior"; seconds_days: number; seconds_portions: number; margin: number;
  proposed: number; portions: number; validated: boolean; validated_at: string | null;
  planned: number | null; sold: number; prepared: number | null; served: number; leftover: number | null;
  start_at: string; prep_minutes: number; ingredients: { name: string; unit: string; qty: number }[];
};
type Plan = {
  services: { service: ServiceKind; label: string; expected: number }[];
  items: Item[];
  ingredients: { name: string; unit: string; need: number; stock: number; missing: number }[];
  validated_all: boolean;
};
type Brief = { titre: string; resume: string; plats: { plat: string; conseil: string; niveau: "ok" | "attention" | "risque" }[]; ordre: string; vigilance: string[] };

const num = (n: number) => n.toLocaleString("fr-FR", { maximumFractionDigits: 2 });
const LEVEL = { ok: "bg-ok/10 text-ok", attention: "bg-warn-soft text-[#92400e]", risque: "bg-err-soft text-err" };

/** Guide de production du chef : portions par plat (reprises comprises), ingrédients à sortir, validation, restes. */
export default function ProductionPage() {
  return <Suspense><Production /></Suspense>;
}

function Production() {
  const params = useSearchParams();
  const toast = useToast();
  const today = todayISO();
  const [date, setDate] = useState(params.get("date") && params.get("date")! >= today ? params.get("date")! : today);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [qty, setQty] = useState<Record<string, string>>({});
  const [left, setLeft] = useState<Record<string, string>>({});
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // Groupes d'élèves (allergie, régime) sans aucun plat compatible à un repas
  const [gaps, setGaps] = useState<{ service: string; label: string; who: string; students: number }[]>([]);

  const load = useCallback(() => {
    supabase().rpc("production_plan", { p_date: date }).then(({ data }) => {
      const p = data as Plan;
      setPlan(p);
      setQty(Object.fromEntries((p?.items ?? []).map((i) => [i.id, String(i.portions)])));
      setLeft(Object.fromEntries((p?.items ?? []).map((i) => [i.id, i.leftover != null ? String(i.leftover) : ""])));
    });
  }, [date]);
  useEffect(() => { setPlan(null); load(); }, [load]);
  useEffect(() => { rpc<{ gaps: typeof gaps }>("production_diet_gaps", { p_date: date }).then((r) => setGaps(r.ok ? r.gaps ?? [] : [])); }, [date]);

  const total = plan?.items.reduce((s, i) => s + (Number(qty[i.id]) || 0), 0) ?? 0;
  const validated = plan?.items.filter((i) => i.validated).length ?? 0;
  const missing = plan?.ingredients.filter((i) => i.missing > 0) ?? [];
  const past = date <= today;

  async function validate(service: ServiceKind) {
    const items = plan!.items.filter((i) => i.service === service).map((i) => ({ id: i.id, qty: Number(qty[i.id]) }));
    if (items.some((i) => !Number.isFinite(i.qty) || i.qty < 0)) return toast("err", "Quantité invalide.");
    setBusy(service);
    const r = await rpc("validate_production", { p_date: date, p_items: items });
    setBusy(null);
    if (!r.ok) return toast("err", r.message);
    toast("ok", "Quantités validées ✅ Les plats passeront « complet » une fois épuisés.");
    load();
  }

  async function saveLeftovers(service: ServiceKind) {
    const items = plan!.items.filter((i) => i.service === service && left[i.id] !== "").map((i) => ({ id: i.id, leftover: Number(left[i.id]) }));
    if (!items.length) return toast("err", "Indique les restes d'au moins un plat.");
    setBusy(`left-${service}`);
    const r = await rpc("record_leftovers", { p_items: items });
    setBusy(null);
    if (!r.ok) return toast("err", r.message);
    toast("ok", "Restes enregistrés : les prochaines propositions en tiendront compte.");
    load();
  }

  return (
    <>
      <PageTitle title="Production" subtitle="Combien préparer par plat, reprises comprises, et quoi sortir du stock">
        <div className="flex gap-1.5 overflow-x-auto">
          {Array.from({ length: 7 }, (_, i) => addDays(today, i - 1)).map((d) => (
            <button key={d} onClick={() => setDate(d)}
              className={clsx("flex w-12 shrink-0 flex-col items-center rounded-xl py-1.5 text-xs font-bold", d === date ? "bg-ink text-white" : "border border-line bg-card")}>
              <span className={d === date ? "text-lime" : "text-muted"}>{dayShort(d)}</span><span className="text-base">{dayNum(d)}</span>
            </button>
          ))}
        </div>
      </PageTitle>

      <ProductionBrief date={date} hasMenu={!!plan?.items.length} />

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi tone="dark" label="Portions à préparer" value={plan ? String(total) : "…"} hint={dayLong(date)} />
        <Kpi label="Clients attendus" value={plan ? String(plan.services.reduce((s, x) => s + x.expected, 0)) : "…"} hint="tickets + historique" />
        <Kpi tone="lime" label="Plats validés" value={plan ? `${validated}/${plan.items.length}` : "…"} hint={plan?.validated_all ? "tout est validé" : "à valider par le chef"} />
        <Kpi label="Ingrédients manquants" value={plan ? String(missing.length) : "…"} hint={missing.length ? "voir la liste" : "stock suffisant"} />
      </div>

      {gaps.length > 0 && (
        <div className="mb-4 rounded-[22px] border-2 border-err/40 bg-err-soft p-4">
          <p className="font-extrabold text-err">⚠️ Des élèves n&apos;ont aucun plat compatible</p>
          <ul className="mt-1.5 space-y-1 text-sm font-semibold text-ink-2">
            {gaps.map((g) => <li key={g.service + g.who}><b className="text-ink">{g.label}</b> : {g.students} élève{g.students > 1 ? "s" : ""} ({g.who}). Prévoyez une alternative.</li>)}
          </ul>
        </div>
      )}

      {plan && plan.items.length === 0 && <Card><Empty>Pas de menu publié ce jour-là</Empty></Card>}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <div className="space-y-4">
          {plan?.services.map((s) => {
            const rows = plan.items.filter((i) => i.service === s.service);
            if (!rows.length) return null;
            const allOk = rows.every((i) => i.validated);
            return (
              <Card key={s.service} pad={false}>
                <div className="flex flex-wrap items-center gap-3 border-b border-line px-5 py-4">
                  <ServiceBadge service={s.service} size="size-10" />
                  <div className="flex-1">
                    <p className="font-extrabold">{s.label}</p>
                    <p className="text-xs text-muted">{s.expected} clients attendus · {rows.reduce((a, i) => a + (Number(qty[i.id]) || 0), 0)} portions</p>
                  </div>
                  {allOk ? <Badge tone="ok"><Check className="size-3" />Validé</Badge> : <Badge tone="warn">À valider</Badge>}
                </div>
                <ul>
                  {rows.map((i) => {
                    const v = Number(qty[i.id]);
                    const changed = Number.isFinite(v) && v !== i.proposed;
                    return (
                      <li key={i.id} className="border-b border-line last:border-0">
                        <div className="flex flex-wrap items-center gap-3 px-5 py-3">
                          <DishImage name={i.dish} src={i.photo_url} className="size-12 shrink-0" />
                          <div className="min-w-0 flex-1">
                            <p className="font-extrabold leading-tight">{i.dish}</p>
                            <p className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted">
                              <span title="Part des clients qui choisissent ce plat">{i.expected} clients ({i.share} %)</span>
                              <span className="flex items-center gap-1" title={i.seconds_basis === "observed" ? `Appris des restes sur ${i.seconds_days} services` : "Estimation de départ (pas encore assez de restes saisis)"}>
                                <Repeat className="size-3" />+{i.seconds_rate} % reprises (+{i.seconds_portions}){i.seconds_basis === "prior" && " · estimé"}
                              </span>
                              <span>+{i.margin} % marge</span>
                              <span className="flex items-center gap-1"><Clock className="size-3" />lancer à {time(i.start_at)}</span>
                            </p>
                          </div>
                          <div className="flex items-center gap-2">
                            <span className="text-right text-[11px] font-bold leading-tight text-muted">proposé<br /><span className="text-sm text-ink">{i.proposed}</span></span>
                            <input type="number" min={0} inputMode="numeric" value={qty[i.id] ?? ""} onChange={(e) => setQty((q) => ({ ...q, [i.id]: e.target.value }))}
                              className={clsx(input, "w-20 text-right font-extrabold", changed && "border-[#b45309]")} aria-label={`Portions de ${i.dish}`} />
                            <button onClick={() => setOpen(open === i.id ? null : i.id)} className="grid size-9 place-items-center rounded-xl border border-line" aria-label="Ingrédients">
                              <ChevronDown className={clsx("size-4 transition", open === i.id && "rotate-180")} />
                            </button>
                          </div>
                        </div>
                        {open === i.id && (
                          <div className="mx-5 mb-3 rounded-xl bg-canvas p-3">
                            <p className="mb-2 text-xs font-extrabold uppercase tracking-wider text-muted">À sortir pour {qty[i.id] || 0} portions</p>
                            {i.ingredients.length === 0 ? <p className="text-sm text-muted">Pas de recette enregistrée pour ce plat (page Plats).</p> : (
                              <ul className="grid gap-1 sm:grid-cols-2">
                                {i.ingredients.map((g) => (
                                  <li key={g.name} className="flex justify-between gap-2 rounded-lg bg-card px-3 py-1.5 text-sm">
                                    <span>{g.name}</span>
                                    <span className="font-extrabold">{num(i.portions ? (g.qty / i.portions) * (Number(qty[i.id]) || 0) : 0)} {g.unit}</span>
                                  </li>
                                ))}
                              </ul>
                            )}
                          </div>
                        )}
                        {past && (
                          <div className="mx-5 mb-3 flex flex-wrap items-center gap-3 rounded-xl border border-dashed border-line px-3 py-2 text-sm">
                            <Trash2 className="size-4 text-muted" />
                            <span className="text-muted">Préparé {i.prepared ?? "—"} · servi {i.served}</span>
                            <label className="ml-auto flex items-center gap-2 font-bold">Restes
                              <input type="number" min={0} inputMode="numeric" value={left[i.id] ?? ""} placeholder="0"
                                onChange={(e) => setLeft((l) => ({ ...l, [i.id]: e.target.value }))} className={clsx(input, "h-9 w-20 text-right")} />
                            </label>
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
                <div className="flex flex-wrap justify-end gap-2 px-5 py-4">
                  {past && <Button variant="ghost" loading={busy === `left-${s.service}`} onClick={() => saveLeftovers(s.service)}><Trash2 className="size-4" />Enregistrer les restes</Button>}
                  <Button loading={busy === s.service} onClick={() => validate(s.service)}><Check className="size-4" />{allOk ? "Mettre à jour" : `Valider le ${s.label.toLowerCase()}`}</Button>
                </div>
              </Card>
            );
          })}
          <p className="flex gap-2 px-1 text-xs text-muted"><Info className="size-4 shrink-0" />
            Portions = clients attendus pour le plat × (1 + reprises) × (1 + marge), arrondi à 5. Les reprises partent d&apos;une estimation par plat
            puis s&apos;apprennent avec les restes saisis en fin de service (préparé − restes − servis). La quantité validée devient la limite du plat.</p>
        </div>

        <Card title="Ingrédients à sortir" subtitle="Toutes les portions du jour vs le stock"
          action={missing.length > 0 && <Link href="/admin/courses" className="flex items-center gap-1.5 text-sm font-bold text-muted hover:text-ink"><ShoppingCart className="size-4" />Courses</Link>}>
          <div className="space-y-2">
            {plan?.ingredients.length === 0 && <Empty>Aucune recette pour ces plats</Empty>}
            {plan?.ingredients.map((g) => (
              <div key={g.name} className={clsx("flex items-center gap-3 rounded-xl px-3 py-2.5", g.missing > 0 ? "bg-warn-soft" : "bg-canvas")}>
                {g.missing > 0 ? <AlertTriangle className="size-4 text-[#b45309]" /> : <span className="size-4 rounded-full bg-ok/80" />}
                <span className="flex-1 text-sm font-bold">{g.name}</span>
                <span className="text-right text-xs text-muted">besoin {num(g.need)} {g.unit} · stock {num(g.stock)}</span>
                {g.missing > 0 && <span className="w-24 text-right text-sm font-extrabold">manque {num(g.missing)}</span>}
              </div>
            ))}
          </div>
        </Card>
      </div>
    </>
  );
}

/** Commentaire IA du plan (Claude explique les chiffres calculés, n'en invente aucun) */
function ProductionBrief({ date, hasMenu }: { date: string; hasMenu: boolean }) {
  const [brief, setBrief] = useState<Brief | null>(null);
  const [at, setAt] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setBrief(null); setAt(null); setErr(null);
    supabase().from("ai_production_briefs").select("brief, created_at").eq("service_date", date).maybeSingle()
      .then(({ data }) => { if (data) { setBrief(data.brief as Brief); setAt(data.created_at); } });
  }, [date]);

  async function run(refresh: boolean) {
    setBusy(true); setErr(null);
    const { data, error } = await supabase().functions.invoke("production-assistant", { body: { date, refresh } });
    setBusy(false);
    if (error || !data?.ok) {
      let msg = data?.message as string | undefined;
      if (!msg && error && "context" in error) msg = (await (error as { context: Response }).context.json().catch(() => null))?.message;
      return setErr(msg ?? "L'assistant est indisponible.");
    }
    setBrief(data.brief); setAt(data.created_at);
  }

  const tips = useMemo(() => brief?.plats ?? [], [brief]);
  if (!hasMenu && !brief) return null;
  return (
    <div className="mb-4 overflow-hidden rounded-[22px] bg-ink text-white">
      <div className="flex flex-wrap items-center gap-3 px-5 py-4">
        <span className="grid size-10 place-items-center rounded-xl bg-lime text-ink"><Sparkles className="size-5" /></span>
        <div className="min-w-0 flex-1">
          <p className="text-xs font-bold uppercase tracking-wider text-lime">Assistant IA · guide de production</p>
          <p className="truncate font-extrabold">{brief ? brief.titre : busy ? "Analyse du plan…" : "L'assistant explique les quantités et l'ordre de cuisson."}</p>
        </div>
        {brief ? (
          <button onClick={() => run(true)} disabled={busy} className="flex items-center gap-1.5 rounded-full bg-white/10 px-3 py-1.5 text-xs font-bold hover:bg-white/20 disabled:opacity-50">
            <RefreshCw className={clsx("size-3.5", busy && "animate-spin")} />{at ? `Généré à ${time(at)}` : "Actualiser"}
          </button>
        ) : (
          <Button size="sm" loading={busy} onClick={() => run(false)}><Sparkles className="size-4" />Analyser</Button>
        )}
      </div>
      {err && <p className="px-5 pb-4 text-sm font-semibold text-[#fca5a5]">{err}</p>}
      {busy && !brief && <div className="mx-5 mb-5 h-24 animate-pulse rounded-xl bg-white/10" />}
      {brief && (
        <div className="grid gap-4 border-t border-white/10 px-5 py-4 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
          <div>
            <p className="mb-3 text-sm leading-relaxed text-white/80">{brief.resume}</p>
            <ul className="space-y-2">
              {tips.map((t) => (
                <li key={t.plat} className="rounded-xl bg-white p-3 text-ink">
                  <p className="flex items-center gap-2 text-sm font-extrabold"><span className={clsx("rounded-full px-2 py-0.5 text-[10px] uppercase", LEVEL[t.niveau])}>{t.niveau}</span>{t.plat}</p>
                  <p className="mt-1 text-[13px] text-ink-2">{t.conseil}</p>
                </li>
              ))}
            </ul>
          </div>
          <div className="space-y-3">
            <div className="rounded-xl bg-lime p-3 text-ink">
              <p className="mb-1 flex items-center gap-1.5 text-xs font-extrabold uppercase tracking-wider"><Clock className="size-3.5" />Ordre de cuisson</p>
              <p className="text-sm font-semibold">{brief.ordre}</p>
            </div>
            {brief.vigilance.length > 0 && (
              <div className="rounded-xl bg-white/10 p-3">
                <p className="mb-1 flex items-center gap-1.5 text-xs font-extrabold uppercase tracking-wider text-[#fcd34d]"><AlertTriangle className="size-3.5" />À surveiller</p>
                <ul className="list-disc space-y-1 pl-4 text-sm text-white/85">{brief.vigilance.map((v, k) => <li key={k}>{v}</li>)}</ul>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
