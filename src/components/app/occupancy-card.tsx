"use client";
import { useEffect, useState } from "react";
import clsx from "clsx";
import { Users, Clock3, Moon } from "lucide-react";
import { rpc, supabase } from "@/lib/supabase/client";
import { SERVICE_LABEL, relativeDay, time, todayISO } from "@/lib/format";
import type { Occupancy } from "@/lib/types";
import { useT, useLang } from "@/lib/i18n";

const LEVEL = {
  low: { color: "#22C55E", soft: "bg-ok-soft", text: "text-[#15803d]", label: "Peu de monde" },
  mid: { color: "#F59E0B", soft: "bg-warn-soft", text: "text-[#b45309]", label: "Il y a du monde" },
  high: { color: "#EF4444", soft: "bg-err-soft", text: "text-err", label: "Très plein" },
};

/** Indicateur d'affluence du réfectoire (plateaux en salle, et caméra si elle tourne). Pas de chiffre de plateaux côté élève. */
export function OccupancyCard() {
  const [o, setO] = useState<Occupancy | null>(null);
  const t = useT();
  const lang = useLang();
  const en = lang === "en";

  useEffect(() => {
    // Hors ligne ou erreur : on garde la dernière valeur (une réponse d'erreur n'est pas une affluence)
    const load = () => rpc<Occupancy>("occupancy_now").then((r) => { if (r.ok !== false && "status" in r) setO(r as unknown as Occupancy); else setO((p) => p ?? { status: "unknown" }); });
    load();
    const id = setInterval(load, 30_000);
    const sb = supabase();
    const ch = sb.channel("occupancy").on("postgres_changes", { event: "INSERT", schema: "public", table: "occupancy_snapshots" }, load).subscribe();
    return () => { clearInterval(id); sb.removeChannel(ch); };
  }, []);

  if (!o) return <div className="h-[92px] animate-pulse rounded-[22px] bg-card" />;
  if (o.status === "unknown" || !(o.status === "closed" || o.level in LEVEL)) {
    return <p className="rounded-[22px] bg-card p-4 text-sm font-semibold text-muted shadow-[var(--shadow-card)]">{t("Affluence indisponible pour le moment.")}</p>;
  }

  if (o.status === "closed") {
    return (
      <div className="flex items-center gap-3 rounded-[22px] bg-card p-4 shadow-[var(--shadow-card)]">
        <span className="grid size-12 place-items-center rounded-2xl bg-canvas"><Moon className="size-5 text-muted" /></span>
        <div>
          <p className="font-bold">{t("Réfectoire fermé")}</p>
          <p className="text-sm text-muted">
            {o.next
              ? en
                ? `${t(SERVICE_LABEL[o.next.service])} ${todayISO(new Date(o.next.starts_at)) === todayISO() ? "" : enDay(todayISO(new Date(o.next.starts_at))) + " "}from ${time(o.next.starts_at).replace("h", ":")}`
                : `${SERVICE_LABEL[o.next.service]} ${todayISO(new Date(o.next.starts_at)) === todayISO() ? "" : relativeDay(todayISO(new Date(o.next.starts_at))).toLowerCase() + " "}à partir de ${time(o.next.starts_at)}`
              : t("Aucun service prévu cette semaine")}
          </p>
        </div>
      </div>
    );
  }

  const L = LEVEL[o.level];
  const r = 26, c = 2 * Math.PI * r;
  return (
    <div className="flex items-center gap-4 rounded-[22px] bg-card p-4 shadow-[var(--shadow-card)]">
      <div className="relative size-[68px] shrink-0">
        <svg viewBox="0 0 64 64" className="size-full -rotate-90">
          <circle cx="32" cy="32" r={r} fill="none" stroke="#EEF0F3" strokeWidth="7" />
          <circle cx="32" cy="32" r={r} fill="none" stroke={L.color} strokeWidth="7" strokeLinecap="round"
            strokeDasharray={c} strokeDashoffset={c * (1 - o.rate / 100)} className="transition-[stroke-dashoffset] duration-700" />
        </svg>
        <span className="absolute inset-0 grid place-items-center text-[15px] font-extrabold">{Math.round(o.rate)}%</span>
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="font-bold">{t("Réfectoire")}</p>
          <span className={clsx("flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-bold", L.soft, L.text)}>
            <span className="relative flex size-1.5"><span className="absolute inline-flex size-full animate-ping rounded-full opacity-75" style={{ background: L.color }} /><span className="relative size-1.5 rounded-full" style={{ background: L.color }} /></span>
            {t(o.trays_full ? "Attente probable" : L.label)}
          </span>
        </div>
        <p className="mt-1 text-sm text-ink-2">
          {o.queue_count != null
            ? <><b>{o.queue_count === 0 ? t("Pas de file") : en ? `${o.queue_count} in line` : `${o.queue_count} dans la file`}</b> · {o.queue_count === 0 ? t("servi tout de suite") : <>~{o.wait_min}&nbsp;{en ? "min wait" : <>min d&apos;attente</>}</>}</>
            : o.trays_full
              ? <><b>{t("plus de plateau libre pour l'instant")}</b> · ~{o.wait_min}&nbsp;{en ? "min wait" : <>min d&apos;attente</>}</>
              : <><b>{Math.round(o.rate)}{en ? "% full" : <>&nbsp;% plein</>}</b> · ~{o.wait_min}&nbsp;{en ? "min wait" : <>min d&apos;attente</>}</>}
        </p>
        <p className="mt-1 flex items-center gap-3 text-xs text-muted">
          <span className="flex items-center gap-1"><Users className="size-3.5" />{o.occupied_tables}/{o.total_tables} tables{o.queue_count != null ? ` · ${Math.round(o.rate)} %` : ""}</span>
          <span className="flex items-center gap-1"><Clock3 className="size-3.5" />{o.source.startsWith("vision") ? t("en direct") : t("estimation")}</span>
        </p>
      </div>
    </div>
  );
}

/** relativeDay en anglais, en minuscules (tomorrow / « Monday 9 November ») */
function enDay(iso: string) {
  const r = relativeDay(iso);
  if (r === "Demain") return "tomorrow";
  if (r === "Hier") return "yesterday";
  return new Date(iso + "T12:00:00Z").toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "Africa/Abidjan" });
}
