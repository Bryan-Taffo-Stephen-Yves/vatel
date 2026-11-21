"use client";
import { useEffect, useState } from "react";
import clsx from "clsx";
import { Salad } from "lucide-react";
import { rpc } from "@/lib/supabase/client";
import { useAppData } from "@/components/app/app-data";
import { useToast } from "@/components/ui/toast";
import { ALLERGIES, DIETS, allergenLabel } from "@/lib/diet";
import { deny } from "@/lib/deny";
import { useLang, useT } from "@/lib/i18n";

/** Profil : allergies et régime de l'élève (les plats qui ne conviennent pas sont signalés partout). */
export function DietSection() {
  const { profile, refresh } = useAppData();
  const toast = useToast();
  const t = useT();
  const lang = useLang();
  const [all, setAll] = useState<string[]>([]);
  const [diets, setDiets] = useState<string[]>([]);
  const [severe, setSevere] = useState<string[]>([]);
  useEffect(() => { setAll(profile?.allergies ?? []); setDiets(profile?.diets ?? []); setSevere(profile?.severe_allergies ?? []); },
    [profile?.allergies, profile?.diets, profile?.severe_allergies]);

  async function save(a: string[], d: string[]) {
    setAll(a); setDiets(d);
    const r = await rpc("set_my_diet", { p_allergies: a, p_diets: d });
    if (!r.ok) { toast("err", r.message); setAll(profile?.allergies ?? []); setDiets(profile?.diets ?? []); return; }
    setSevere((v) => v.filter((x) => a.includes(x)));
    refresh();
  }
  // Allergie grave : la commande d'un plat qui la contient (même en traces) est bloquée partout
  async function saveSevere(list: string[]) {
    setSevere(list);
    const r = await rpc("set_my_severe_allergies", { p_severe: list });
    if (!r.ok) { toast("err", r.message); setSevere(profile?.severe_allergies ?? []); return; }
    toast("ok", t("Enregistré."));
    refresh();
  }
  const toggle = (list: string[], v: string) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  // Posées par le parent : l'élève ne peut pas les retirer (la base le refuse aussi)
  const byParent = profile?.parent_allergies ?? [];
  const severeByParent = profile?.parent_severe ?? [];
  const locked = (el: Element) => { deny(el); toast("err", t("Ajoutée par ton parent : seul lui peut la retirer.")); };

  return (
    <section id="regime" className="mt-4 scroll-mt-20 rounded-[24px] bg-card p-4 shadow-[var(--shadow-card)]">
      <p className="flex items-center gap-2 font-bold"><Salad className="size-[18px]" />{t("Mes allergies et mon régime")}</p>
      <p className="mt-0.5 text-sm text-muted">{t("Les plats qui ne te conviennent pas sont signalés dans le menu, à la commande et par Jean.")}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        {DIETS.map((d) => (
          <button key={d.id} onClick={() => save(all, toggle(diets, d.id))}
            className={clsx("rounded-full px-3.5 py-1.5 text-sm font-bold transition", diets.includes(d.id) ? "bg-ink text-white" : "bg-canvas")}>
            {diets.includes(d.id) ? "✓ " : ""}{t(d.label)}
          </button>
        ))}
      </div>
      <p className="mt-3 text-xs font-extrabold uppercase tracking-wider text-muted">{t("Allergies")}</p>
      <div className="mt-1.5 flex flex-wrap gap-2">
        {ALLERGIES.map((a) => (
          <button key={a} onClick={(e) => (byParent.includes(a) && all.includes(a) ? locked(e.currentTarget) : save(toggle(all, a), diets))}
            className={clsx("rounded-full px-3 py-1.5 text-sm font-bold capitalize transition", all.includes(a) ? "bg-err text-white" : "bg-canvas")}>
            {all.includes(a) ? (byParent.includes(a) ? "🔒 " : "⚠️ ") : ""}{allergenLabel(a, lang)}
          </button>
        ))}
      </div>
      {all.length > 0 && (
        <div className="mt-3 rounded-2xl bg-err-soft p-3">
          <p className="text-sm font-extrabold text-err">{t("Lesquelles sont graves ?")}</p>
          <p className="mt-0.5 text-xs font-semibold text-ink-2">{t("Allergie grave : impossible de commander un plat qui la contient (même en traces), et l'agent est alerté au comptoir.")}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {all.map((a) => {
              const on = severe.includes(a);
              return (
                <button key={a} onClick={(e) => (on && severeByParent.includes(a) ? locked(e.currentTarget) : saveSevere(on ? severe.filter((x) => x !== a) : [...severe, a]))}
                  className={clsx("rounded-full px-3 py-1.5 text-sm font-bold capitalize transition", on ? "bg-err text-white" : "bg-card text-ink")}>
                  {on ? "⛔ " : ""}{allergenLabel(a, lang)}{on ? ` · ${t("grave")}` : ""}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}
