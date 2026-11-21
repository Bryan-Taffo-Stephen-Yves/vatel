"use client";
// Rythme du comptoir : l'affluence lue dans l'écart entre deux scans de l'agent. Un QR scanné toutes les 10 à 30 s,
// c'est beaucoup de monde ; quand l'écart s'allonge, la file diminue. Marche sans caméra (rpc scan_rhythm).
import { useCallback, useEffect, useState } from "react";
import clsx from "clsx";
import { ScanLine, TrendingDown, TrendingUp, MoveRight } from "lucide-react";
import { rpc } from "@/lib/supabase/client";
import { Badge, Card } from "@/components/admin/ui";

export type Rhythm = {
  level: "high" | "mid" | "low" | "none"; scans: number; since_last_s: number | null; interval_s: number | null;
  per_min: number | null; trend: "rising" | "falling" | "stable" | null; gaps: number[]; text: string;
};

const LEVEL = {
  high: { label: "Forte affluence", tone: "err" as const },
  mid: { label: "Affluence moyenne", tone: "warn" as const },
  low: { label: "Calme", tone: "ok" as const },
  none: { label: "Pas de scan", tone: "gray" as const },
};
const TREND = {
  rising: { icon: TrendingUp, label: "La file grossit", cls: "bg-err-soft text-err" },
  falling: { icon: TrendingDown, label: "La file diminue", cls: "bg-ok-soft text-[#15803d]" },
  stable: { icon: MoveRight, label: "Rythme stable", cls: "bg-canvas text-ink-2" },
};
const every = (s: number) => (s < 90 ? `${s} s` : `${Math.round(s / 60)} min`);

/** Contenu (sans carte) : réutilisé par le Pilote du service */
export function ScanRhythmView({ r }: { r: Rhythm }) {
  const lv = LEVEL[r.level];
  const t = r.trend ? TREND[r.trend] : null;
  const max = Math.max(90, ...r.gaps);
  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs font-bold text-muted">Un passage toutes les</p>
          <p className="text-3xl font-extrabold leading-tight">{r.interval_s != null ? every(r.interval_s) : "—"}</p>
          {r.per_min != null && <p className="text-xs font-semibold text-muted">≈ {String(r.per_min).replace(".", ",")} personne{r.per_min >= 2 ? "s" : ""} servie{r.per_min >= 2 ? "s" : ""} par minute</p>}
        </div>
        <div className="flex flex-col items-end gap-1.5">
          <Badge tone={lv.tone}>{lv.label}</Badge>
          {t && <span className={clsx("inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-bold", t.cls)}><t.icon className="size-3.5" />{t.label}</span>}
        </div>
      </div>
      {r.gaps.length > 0 && (
        <div className="mt-4">
          {/* Une barre par écart entre deux scans, le plus récent à droite : barres courtes = beaucoup de monde */}
          <div className="flex h-16 items-end gap-1" role="img" aria-label={`Écarts entre les derniers scans : ${r.gaps.join(", ")} secondes`}>
            {r.gaps.map((g, i) => (
              <span key={i} title={`${g} s`} className={clsx("flex-1 rounded-t-md", g <= 30 ? "bg-err" : g <= 90 ? "bg-warn" : "bg-ok")}
                style={{ height: `${Math.max(8, Math.min(100, (g / max) * 100))}%` }} />
            ))}
          </div>
          <div className="mt-1 flex justify-between text-[11px] font-semibold text-muted"><span>plus ancien</span><span>écart entre deux scans</span><span>maintenant</span></div>
        </div>
      )}
      <p className="mt-3 text-sm text-ink-2">{r.text}</p>
    </div>
  );
}

/** Carte autonome (page Affluence) : se met à jour toutes les 15 s */
export function ScanRhythmCard({ className }: { className?: string }) {
  const [r, setR] = useState<Rhythm | null>(null);
  const [off, setOff] = useState(false);
  const load = useCallback(async () => {
    const res = await rpc<Rhythm>("scan_rhythm");
    if (!res.ok) { setOff(true); return; }
    setOff(false); setR(res as unknown as Rhythm);
  }, []);
  useEffect(() => {
    load();
    const id = setInterval(() => { if (!document.hidden) load(); }, 15_000);
    return () => clearInterval(id);
  }, [load]);
  if (off) return null; // fonction pas encore en ligne, ou pas le droit
  return (
    <Card className={className} title="Rythme du comptoir" subtitle="Calculé avec l'écart entre deux scans de l'agent : écarts courts = beaucoup de monde, écarts qui s'allongent = la file diminue."
      action={<ScanLine className="size-5 text-muted" />}>
      {r ? <ScanRhythmView r={r} /> : <div className="h-28 animate-pulse rounded-2xl bg-canvas" />}
    </Card>
  );
}
