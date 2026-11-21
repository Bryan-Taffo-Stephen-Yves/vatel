"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { Sparkles, ChevronRight, RefreshCw } from "lucide-react";
import { supabase } from "@/lib/supabase/client";
import { DishImage } from "@/components/app/dish-image";
import { fcfa } from "@/lib/format";
import { useT, useLang } from "@/lib/i18n";
import { useAppData } from "@/components/app/app-data";

type Res = { label: string; intro: string; items: { menu_item_id: string; dish: string; price: number; photo_url: string | null; raison: string }[]; empty?: boolean; message?: string };

/** Accueil : « Pour toi » — 1 à 3 plats du prochain repas choisis par l'IA selon ses goûts, son régime et ses allergies. */
export function MealSuggestions() {
  const [r, setR] = useState<Res | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(false);
  const t = useT();
  const lang = useLang();

  // Gardées 30 min sur le téléphone : l'accueil s'affiche tout de suite, sans rappeler l'IA à chaque ouverture
  const uid = useAppData().profile?.id;
  const KEY = `vatel:suggest:${uid}:${lang}`;
  async function load(refresh = false) {
    if (!refresh && uid) {
      try {
        const c = JSON.parse(localStorage.getItem(KEY) ?? "null") as { at: number; data: Res } | null;
        if (c?.data) { setR(c.data); if (Date.now() - c.at < 30 * 60_000) return; }
      } catch {}
    }
    if (!navigator.onLine) return;
    setBusy(true); setErr(false);
    const { data, error } = await supabase().functions.invoke("meal-suggest", { body: { refresh, lang } });
    setBusy(false);
    if (error || !data?.ok) { setR((cur) => { if (!cur) setErr(true); return cur; }); return; }
    setR(data as Res);
    if (uid) try { localStorage.setItem(KEY, JSON.stringify({ at: Date.now(), data })); } catch {}
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (uid) load(); }, [lang, uid]);

  if (err || r?.empty) return null;
  return (
    <section className="mt-6">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="flex items-center gap-1.5 text-[17px] font-extrabold"><Sparkles className="size-5 text-lime-deep" />{t("Pour toi")}{r ? ` · ${r.label}` : ""}</h2>
        {r && <button onClick={() => load(true)} disabled={busy} className="grid size-8 place-items-center rounded-full bg-card shadow-[var(--shadow-card)] disabled:opacity-40" aria-label={t("Autres suggestions")}>
          <RefreshCw className={busy ? "size-4 animate-spin" : "size-4"} /></button>}
      </div>
      {!r ? <div className="h-28 animate-pulse rounded-[24px] bg-card" /> : (
        <div className="rounded-[24px] bg-ink p-4 text-white">
          <p className="text-sm text-white/80">{r.intro}</p>
          <ul className="mt-3 space-y-2">
            {r.items.map((i) => (
              <li key={i.menu_item_id}>
                <Link href={`/app/menu/${i.menu_item_id}`} className="flex items-center gap-3 rounded-2xl bg-white p-2.5 text-ink active:scale-[0.99]">
                  <DishImage name={i.dish} src={i.photo_url} className="size-14 shrink-0" />
                  <span className="min-w-0 flex-1">
                    <span className="block font-extrabold leading-tight">{i.dish} <span className="text-sm font-bold text-muted">· {fcfa(i.price)}</span></span>
                    <span className="mt-0.5 block text-[13px] leading-snug text-ink-2">{i.raison}</span>
                  </span>
                  <ChevronRight className="size-5 shrink-0 text-off" />
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
