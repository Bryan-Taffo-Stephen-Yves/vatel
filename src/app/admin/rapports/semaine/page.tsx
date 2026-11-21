"use client";
// Rapport du lundi : bilan de la semaine passée pour la cuisine et l'admin (envoyé en notification chaque lundi à 8h).
// Plats à garder / à revoir avec la tendance, plaintes par type, assiettes laissées (photos), commentaires marquants,
// puis un bouton pour préparer le menu de la semaine prochaine avec l'assistant, qui tient compte de tout ça.
import { useEffect, useState } from "react";
import Link from "next/link";
import clsx from "clsx";
import { ChevronLeft, ChevronRight, MessageSquareQuote, Printer, Sparkles, TrendingDown, TrendingUp } from "lucide-react";
import { supabase } from "@/lib/supabase/client";
import { Badge, Card, Kpi, PageTitle } from "@/components/admin/ui";
import { Button } from "@/components/ui/button";
import { DishImage } from "@/components/app/dish-image";
import { ChefArt, CloudBubble } from "@/components/chef";
import { useStaff } from "@/components/admin/admin-shell";
import { COMPLAINTS, moodEmoji, reviewPhotoUrl } from "@/lib/reviews";
import { addDays, todayISO, TZ } from "@/lib/format";

type Dish = { id: string; name: string; photo_url: string | null; ratings: number; avg_stars: number; prev_stars: number | null;
  trend: "hausse" | "baisse" | "stable" | null; meals: number; left_pct: number | null; scans: number; top_complaint: string | null };
type Report = {
  ok: boolean; week_start: string; week_end: string; served: number; served_prev: number; ratings: number;
  avg_stars: number | null; avg_stars_prev: number | null; left_pct: number | null;
  best: Dish[]; worst: Dish[]; most_left: Dish[];
  complaints: { code: string; n: number }[];
  comments: { dish: string; stars: number; comment: string; at: string }[];
  photos: { photo_path: string; dish: string; stars: number; left_pct: number | null }[];
  advice: string[];
};

const day = (iso: string, opts: Intl.DateTimeFormatOptions) => new Date(`${iso}T12:00:00Z`).toLocaleDateString("fr-FR", { ...opts, timeZone: TZ });
const stars = (n: number | null) => (n == null ? "—" : `${moodEmoji(n)} ${String(n).replace(".", ",")}`);

export default function WeeklyReportPage() {
  const me = useStaff();
  const [week, setWeek] = useState<string | null>(null);
  const [r, setR] = useState<Report | null>(null);

  // Semaine demandée (lien de la notification du lundi) ou semaine passée
  useEffect(() => {
    const q = new URLSearchParams(window.location.search).get("semaine");
    setWeek(q && /^\d{4}-\d{2}-\d{2}$/.test(q) ? q : addDays(todayISO(), -7));
  }, []);
  useEffect(() => {
    if (!week) return;
    setR(null);
    supabase().rpc("weekly_report", { p_week_start: week }).then(({ data }) => setR(data as Report));
  }, [week]);

  const go = (n: number) => {
    const w = addDays(r?.week_start ?? week!, n * 7);
    window.history.replaceState(null, "", `?semaine=${w}`);
    setWeek(w);
  };
  const isLast = r ? addDays(r.week_start, 7) > addDays(todayISO(), -7) : true;
  const canPlan = me?.role === "chef" || me?.role === "admin";
  const maxComplaint = Math.max(1, ...(r?.complaints ?? []).map((c) => c.n));
  const servedDelta = r && r.served_prev ? Math.round(((r.served - r.served_prev) / r.served_prev) * 100) : null;

  return (
    <>
      <PageTitle title="Rapport de la semaine"
        subtitle={r ? `Du ${day(r.week_start, { weekday: "long", day: "numeric", month: "long" })} au ${day(r.week_end, { weekday: "long", day: "numeric", month: "long" })}` : "…"}>
        <div className="flex items-center gap-1 print:hidden">
          <Button variant="outline" size="sm" onClick={() => go(-1)} aria-label="Semaine précédente"><ChevronLeft className="size-4" /></Button>
          <Button variant="outline" size="sm" onClick={() => go(1)} disabled={isLast} aria-label="Semaine suivante"><ChevronRight className="size-4" /></Button>
          <Button size="sm" onClick={() => window.print()}><Printer className="size-4" />Imprimer</Button>
        </div>
      </PageTitle>

      {!r ? <div className="h-96 animate-pulse rounded-[22px] bg-card" /> : !r.ok ? <Card><p className="text-sm text-muted">Rapport indisponible.</p></Card> : (
        <div className="space-y-4">
          {/* Ce qu'il faut retenir : le chef le dit dans sa bulle */}
          <section className="flex items-end gap-3 overflow-hidden rounded-[22px] bg-ink px-4 pt-6 text-white">
            <span className="hidden h-[150px] shrink-0 sm:block"><ChefArt who="chef" mood={r.worst.length ? "happy" : "laugh"} /></span>
            <div className="mb-6 min-w-0 flex-1">
              <CloudBubble tail="left" className="max-w-2xl text-left">
                <p className="text-xs font-extrabold uppercase tracking-wider text-muted">Ce qu&apos;il faut retenir</p>
                {r.advice.length ? r.advice.map((a) => <p key={a} className="mt-1.5 text-[15px] font-bold leading-snug">{a}</p>)
                  : <p className="mt-1.5 text-[15px] font-bold">Pas encore d&apos;avis cette semaine : le rapport se remplira avec les notes des élèves.</p>}
              </CloudBubble>
            </div>
          </section>

          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Kpi tone="dark" label="Repas servis" value={String(r.served)} hint={servedDelta == null ? undefined : `${servedDelta >= 0 ? "+" : ""}${servedDelta} % par rapport à la semaine d'avant`} />
            <Kpi tone="lime" label="Satisfaction" value={stars(r.avg_stars)} hint={r.avg_stars_prev != null ? `semaine d'avant : ${stars(r.avg_stars_prev)}` : undefined} />
            <Kpi label="Avis reçus" value={String(r.ratings)} />
            <Kpi label="Laissé dans l'assiette" value={r.left_pct == null ? "—" : `${r.left_pct} %`} hint="d'après les photos des assiettes rendues" />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <DishList title="À garder" subtitle="Les plats les plus aimés" dishes={r.best} />
            <DishList title="À revoir" subtitle="Les plats les moins aimés" dishes={r.worst} bad />
          </div>

          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]">
            <Card title="Plaintes de la semaine" subtitle="Les élèves les signalent en un clic dans leur avis">
              {r.complaints.length === 0 ? <p className="text-sm text-muted">Aucune plainte cette semaine 🎉</p> : (
                <ul className="space-y-2.5">
                  {r.complaints.map((c) => {
                    const meta = COMPLAINTS.find((x) => x.code === c.code);
                    return (
                      <li key={c.code} className="text-sm">
                        <div className="flex justify-between font-bold"><span>{meta?.emoji} {meta?.label ?? c.code}</span><span>{c.n}</span></div>
                        <div className="mt-1 h-2 overflow-hidden rounded-full bg-canvas">
                          <div className={clsx("h-full rounded-full", c.code === "corps_etranger" ? "bg-err" : "bg-warn")} style={{ width: `${(c.n / maxComplaint) * 100}%` }} />
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </Card>
            <Card title="Assiettes rendues" subtitle="Photos envoyées avec les avis, les plus laissées d'abord">
              {r.photos.length === 0 ? <p className="text-sm text-muted">Pas de photo d&apos;assiette cette semaine.</p> : (
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  {r.photos.map((p) => (
                    <figure key={p.photo_path} className="overflow-hidden rounded-2xl bg-canvas">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={reviewPhotoUrl(p.photo_path) ?? ""} alt={`Assiette : ${p.dish}`} loading="lazy" className="aspect-square w-full object-cover" />
                      <figcaption className="p-2 text-xs font-bold">
                        <span className="line-clamp-1">{p.dish}</span>
                        <span className="text-muted">{moodEmoji(p.stars)}{p.left_pct != null ? ` · ${p.left_pct} % laissé` : ""}</span>
                      </figcaption>
                    </figure>
                  ))}
                </div>
              )}
            </Card>
          </div>

          <Card title="Ce que disent les élèves" subtitle="Commentaires marquants de la semaine (anonymes)">
            {r.comments.length === 0 ? <p className="text-sm text-muted">Pas de commentaire cette semaine.</p> : (
              <ul className="grid gap-3 md:grid-cols-2">
                {r.comments.map((c, i) => (
                  <li key={i} className={clsx("flex gap-3 rounded-2xl p-3", c.stars >= 4 ? "bg-ok-soft" : "bg-err-soft")}>
                    <span className="text-2xl leading-none">{moodEmoji(c.stars)}</span>
                    <div className="min-w-0 text-sm">
                      <p className="font-semibold">« {c.comment} »</p>
                      <p className="mt-1 flex items-center gap-1 text-xs font-bold text-muted"><MessageSquareQuote className="size-3.5" />{c.dish}</p>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {canPlan && (
            <section className="flex flex-wrap items-center justify-between gap-4 rounded-[22px] bg-lime p-5 print:hidden">
              <div className="min-w-0">
                <p className="text-lg font-extrabold">Préparer le menu de la semaine prochaine</p>
                <p className="text-sm font-semibold text-ink/70">L&apos;assistant tient compte de ce rapport : notes, plaintes, assiettes laissées et commentaires.</p>
              </div>
              <Link href="/admin/menu?ia=1" className="flex h-12 items-center gap-2 rounded-full bg-ink px-5 font-extrabold text-white transition active:scale-[0.98]">
                <Sparkles className="size-5 text-lime" />Proposer le menu avec ces résultats
              </Link>
            </section>
          )}
        </div>
      )}
    </>
  );
}

function DishList({ title, subtitle, dishes, bad }: { title: string; subtitle: string; dishes: Dish[]; bad?: boolean }) {
  return (
    <Card title={title} subtitle={subtitle}>
      {dishes.length === 0 ? <p className="text-sm text-muted">Pas assez d&apos;avis cette semaine.</p> : (
        <ul className="space-y-2">
          {dishes.map((d) => (
            <li key={d.id} className={clsx("flex items-center gap-3 rounded-2xl p-2.5", bad ? "bg-err-soft/50" : "bg-ok-soft/50")}>
              <DishImage name={d.name} src={d.photo_url} className="size-12 shrink-0" />
              <div className="min-w-0 flex-1">
                <p className="truncate font-extrabold">{d.name}</p>
                <p className="text-xs font-semibold text-muted">
                  {d.ratings} avis · {d.meals} repas{d.left_pct != null ? ` · ${d.left_pct} % laissé` : ""}{d.top_complaint ? ` · surtout « ${d.top_complaint} »` : ""}
                </p>
              </div>
              <div className="text-right">
                <p className="text-lg font-extrabold">{stars(d.avg_stars)}</p>
                {d.trend === "hausse" && <Badge tone="ok"><TrendingUp className="size-3.5" />en hausse</Badge>}
                {d.trend === "baisse" && <Badge tone="err"><TrendingDown className="size-3.5" />en baisse</Badge>}
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
