"use client";
import { useEffect, useState } from "react";
import clsx from "clsx";
import { Trophy, ThumbsDown, Lightbulb, Star } from "lucide-react";
import { rpc } from "@/lib/supabase/client";
import { Card } from "@/components/admin/ui";
import { DishImage } from "@/components/app/dish-image";

type Row = { id: string; name: string; photo_url: string | null; ratings: number; avg_stars: number; meals: number; left_pct: number | null; scans: number };
type Board = { month: string; mean: number; best: Row[]; worst: Row[]; advice: string };

const stars = (n: number) => n.toLocaleString("fr-FR", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

/** Palmarès du mois : plats les plus et les moins aimés (note, repas servis, % laissé dans l'assiette) + conseil au chef. */
export function DishLeaderboard() {
  const [b, setB] = useState<Board | null>(null);
  useEffect(() => { rpc<Board>("dish_leaderboard").then((r) => r.ok && setB(r)); }, []);
  if (!b) return <div className="mb-4 h-48 animate-pulse rounded-[22px] bg-card" />;
  const month = new Date(b.month + "T12:00:00Z").toLocaleDateString("fr-FR", { month: "long", year: "numeric", timeZone: "UTC" });

  return (
    <Card className="mb-4" title={`Palmarès de ${month}`} subtitle="Note des élèves (pondérée par le nombre d'avis), repas servis et part laissée dans l'assiette (photos d'assiettes rendues)">
      <p className="mb-4 flex gap-2 rounded-2xl bg-lime-soft px-4 py-3 text-sm font-semibold"><Lightbulb className="size-4 shrink-0 translate-y-0.5" />{b.advice}</p>
      {b.best.length > 0 && (
        <div className="grid gap-4 md:grid-cols-2">
          <List title="Les plus aimés" icon={<Trophy className="size-4 text-[#b45309]" />} rows={b.best} />
          <List title="Les moins aimés" icon={<ThumbsDown className="size-4 text-err" />} rows={b.worst} bad />
        </div>
      )}
    </Card>
  );
}

function List({ title, icon, rows, bad }: { title: string; icon: React.ReactNode; rows: Row[]; bad?: boolean }) {
  return (
    <div className="min-w-0">
      <p className="mb-2 flex items-center gap-1.5 text-xs font-extrabold uppercase tracking-wider text-muted">{icon}{title}</p>
      {rows.length === 0 ? <p className="text-sm text-muted">Pas assez de plats notés.</p> : (
        <ol className="space-y-2">
          {rows.map((d, i) => (
            <li key={d.id} className="flex items-center gap-3">
              <span className="w-4 text-sm font-extrabold text-muted">{i + 1}</span>
              <DishImage name={d.name} src={d.photo_url} className="size-10" rounded="rounded-xl" />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-bold">{d.name}</span>
                <span className="block text-xs text-muted">{d.meals} repas · {d.ratings} avis</span>
              </span>
              <span className="text-right">
                <span className={clsx("flex items-center justify-end gap-1 text-sm font-extrabold", bad && d.avg_stars < 3 && "text-err")}>
                  <Star className="size-3.5 fill-warn text-warn" />{stars(d.avg_stars)}
                </span>
                {d.left_pct != null && (
                  <span className={clsx("block text-[11px] font-bold", d.left_pct >= 30 ? "text-err" : d.left_pct >= 15 ? "text-[#b45309]" : "text-[#15803d]")}>
                    {d.left_pct} % laissé
                  </span>
                )}
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
