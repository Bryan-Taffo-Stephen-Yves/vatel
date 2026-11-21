"use client";
import { useEffect, useState } from "react";
import clsx from "clsx";
import { BarChart3, Gift, Send } from "lucide-react";
import { rpc } from "@/lib/supabase/client";
import { fcfa } from "@/lib/format";
import { useLang } from "@/lib/i18n";

type Period = "week" | "month" | "since_recharge";
type Stats = {
  period: Period; from: string;
  days: { date: string; ate: boolean; future: boolean }[];
  meals: number; spent: number;
  last_recharge: { amount: number; at: string; left: number } | null;
  gifts: { at: string; to: string; tickets: number; amount: number; meal: string }[];
  transfers: { at: string; to: string | null; amount: number; note: string | null }[];
};

const day = (iso: string, en: boolean, opts: Intl.DateTimeFormatOptions) =>
  new Date(iso.length === 10 ? `${iso}T12:00:00Z` : iso).toLocaleDateString(en ? "en-GB" : "fr-FR", { ...opts, timeZone: "Africa/Abidjan" });

/** Statistiques d'un enfant pour son parent : période au choix, semaine en points, dépenses, reste de la recharge. */
export function ChildStats({ childId, firstName }: { childId: string; firstName: string }) {
  const en = useLang() === "en";
  const [period, setPeriod] = useState<Period>("week");
  const [s, setS] = useState<Stats | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setS(null); setErr(null);
    rpc<Stats>("family_child_stats", { p_child: childId, p_period: period }).then((r) => {
      if (!live) return;
      if (r.ok) setS(r as unknown as Stats); else setErr(r.message);
    });
    return () => { live = false; };
  }, [childId, period]);

  const PERIODS: [Period, string][] = en
    ? [["week", "This week"], ["month", "This month"], ["since_recharge", "Since last top-up"]]
    : [["week", "Cette semaine"], ["month", "Ce mois"], ["since_recharge", "Depuis la recharge"]];
  const LETTERS = en ? ["M", "T", "W", "T", "F", "S"] : ["L", "M", "M", "J", "V", "S"];

  return (
    <div className="border-t border-line px-4 py-3">
      <p className="mb-2 flex items-center gap-1.5 text-xs font-extrabold uppercase tracking-wider text-muted"><BarChart3 className="size-3.5" />{en ? "Stats" : "Statistiques"}</p>
      <div className="-mx-4 flex gap-1.5 overflow-x-auto px-4 pb-1 [scrollbar-width:none]">
        {PERIODS.map(([k, l]) => (
          <button key={k} onClick={() => setPeriod(k)}
            className={clsx("h-8 shrink-0 rounded-full px-3 text-xs font-bold transition", period === k ? "bg-ink text-lime" : "bg-canvas text-ink-2")}>{l}</button>
        ))}
      </div>

      {err && <p className="mt-2 text-sm text-err">{err}</p>}
      {!s && !err && <div className="mt-3 h-28 animate-pulse rounded-2xl bg-canvas" />}
      {s && (
        <>
          {/* Semaine en cours : point plein = a mangé, vide = pas venu */}
          <div className="mt-3 flex justify-between rounded-2xl bg-canvas px-4 py-3">
            {s.days.map((d, i) => (
              <div key={d.date} className="flex flex-col items-center gap-1">
                <span className="text-[11px] font-bold text-muted">{LETTERS[i]}</span>
                <span aria-label={`${day(d.date, en, { weekday: "long" })} : ${d.future ? (en ? "to come" : "à venir") : d.ate ? (en ? "ate" : "a mangé") : (en ? "didn't come" : "pas venu")}`}
                  className={clsx("size-5 rounded-full border-2", d.ate ? "border-lime-deep bg-lime-deep" : d.future ? "border-dashed border-line" : "border-ink/25")} />
              </div>
            ))}
          </div>

          <div className="mt-2 grid grid-cols-2 gap-2">
            <div className="rounded-2xl bg-canvas px-3 py-2.5">
              <p className="text-xl font-extrabold">{s.meals}</p>
              <p className="text-xs font-semibold text-muted">{en ? (s.meals > 1 ? "meals eaten" : "meal eaten") : (s.meals > 1 ? "repas pris" : "repas pris")}</p>
            </div>
            <div className="rounded-2xl bg-canvas px-3 py-2.5">
              <p className="text-xl font-extrabold">{fcfa(s.spent)}</p>
              <p className="text-xs font-semibold text-muted">{en ? "spent" : "dépensés"}</p>
            </div>
          </div>

          {s.last_recharge && (
            <p className="mt-2 rounded-2xl bg-lime-soft px-3 py-2.5 text-[13px] font-semibold text-ink-2">
              {en
                ? <>Of the <b className="text-ink">{fcfa(s.last_recharge.amount)}</b> topped up on {day(s.last_recharge.at, true, { day: "numeric", month: "short" })}, <b className="text-ink">{fcfa(s.last_recharge.left)}</b> {s.last_recharge.left ? "is left" : "— all spent"}.</>
                : <>Sur les <b className="text-ink">{fcfa(s.last_recharge.amount)}</b> du {day(s.last_recharge.at, false, { day: "numeric", month: "short" })}, {s.last_recharge.left ? <>il reste <b className="text-ink">{fcfa(s.last_recharge.left)}</b>.</> : <>tout a été dépensé.</>}</>}
            </p>
          )}

          {(s.gifts.length > 0 || s.transfers.length > 0) && (
            <div className="mt-3">
              <p className="mb-1.5 text-xs font-bold text-muted">{en ? `Given by ${firstName} to classmates` : `Donné par ${firstName} à des camarades`}</p>
              <ul className="space-y-1.5">
                {s.gifts.map((g, k) => (
                  <li key={`g${k}`} className="flex items-center gap-2 text-sm">
                    <Gift className="size-4 shrink-0 text-lime-deep" />
                    <span className="min-w-0 flex-1 truncate"><b>{g.tickets > 1 ? `${g.tickets} ` : ""}{en ? `${g.meal} meal${g.tickets > 1 ? "s" : ""}` : `repas ${g.meal.toLowerCase()}`}</b> → {g.to}</span>
                    <span className="shrink-0 text-xs text-muted">{fcfa(g.amount)} · {day(g.at, en, { day: "numeric", month: "short" })}</span>
                  </li>
                ))}
                {s.transfers.map((x, k) => (
                  <li key={`t${k}`} className="flex items-center gap-2 text-sm">
                    <Send className="size-4 shrink-0 text-muted" />
                    <span className="min-w-0 flex-1 truncate"><b>{fcfa(x.amount)}</b> → {x.to ?? "?"}</span>
                    <span className="shrink-0 text-xs text-muted">{day(x.at, en, { day: "numeric", month: "short" })}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </div>
  );
}
