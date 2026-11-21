"use client";
import { Suspense, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import clsx from "clsx";
import { Flame, Star, ChevronRight } from "lucide-react";
import { supabase } from "@/lib/supabase/client";
import { DishImage } from "@/components/app/dish-image";
import { ServiceIcon } from "@/components/app/service-icon";
import { cachedDishStats, cachedMenu, cachedServices, currentService, fetchDishStats, fetchMenu, fetchServices, serviceEnded, soldOut, tagsFor, TAG_STYLE, type DishStat, type Services } from "@/lib/menu";
import { addDays, dayNum, dayShort, fcfa, todayISO } from "@/lib/format";
import { SERVICES, type MenuItem, type ServiceKind } from "@/lib/types";
import { useAppData } from "@/components/app/app-data";
import { dietConflicts, hasDietPrefs, warnEn } from "@/lib/diet";
import { useT, useLang, type Lang } from "@/lib/i18n";
import { MenuDownload } from "@/components/app/menu-download";

// Mots de dietConflicts (français) rendus en anglais ; les noms d'allergènes restent tels quels (données)
const shortDay = (d: string, lang: Lang) => lang === "en"
  ? new Date(d + "T12:00:00Z").toLocaleDateString("en-GB", { weekday: "short", timeZone: "Africa/Abidjan" }) : dayShort(d);

export default function MenuPage() {
  return <Suspense><Menu /></Suspense>;
}

function Menu() {
  const params = useSearchParams();
  const today = todayISO();
  const [items, setItems] = useState<MenuItem[] | null>(null);
  const [stats, setStats] = useState<Record<string, DishStat>>({});
  const [services, setServices] = useState<Services | null>(null);
  const { profile } = useAppData();
  const [onlyMine, setOnlyMine] = useState(false);
  const t = useT();
  const lang = useLang();
  const prefs = hasDietPrefs(profile);

  const days = useMemo(() => Array.from({ length: 8 }, (_, i) => addDays(today, i)), [today]);
  const available = useMemo(() => days.filter((d) => items?.some((i) => i.service_date === d)), [days, items]);
  const day = params.get("jour") ?? available[0] ?? today;
  const servicesOfDay = SERVICES.filter((s) => items?.some((i) => i.service_date === day && i.service === s));
  const fallback = day === today ? currentService(services) : servicesOfDay[0];
  const service = (params.get("service") as ServiceKind) ?? (servicesOfDay.includes(fallback) ? fallback : servicesOfDay[0] ?? "lunch");
  const cfg = services?.[service];

  const go = (patch: Record<string, string>) => {
    const p = new URLSearchParams(params);
    Object.entries(patch).forEach(([k, v]) => p.set(k, v));
    // Changement instantané (pas d'aller-retour serveur) : l'URL suit, useSearchParams se met à jour
    window.history.replaceState(null, "", `/app/menu?${p}`);
  };

  useEffect(() => {
    // Ce que le téléphone a déjà s'affiche tout de suite, puis la réponse du serveur remplace
    const c = cachedMenu(today, addDays(today, 7));
    if (c.length) setItems((cur) => cur ?? c);
    setStats((cur) => (Object.keys(cur).length ? cur : cachedDishStats()));
    setServices((cur) => cur ?? cachedServices());
    fetchMenu(today, addDays(today, 7)).then(setItems);
    fetchDishStats().then(setStats);
    fetchServices().then(setServices);
    // Ruptures en direct (§4.3, §12 : grisé en < 3 s)
    const sb = supabase();
    const ch = sb.channel("menu-live")
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "menu_items" }, (pl) => {
        const n = pl.new as Partial<MenuItem> & { id: string };
        setItems((l) => l?.map((i) => (i.id === n.id ? { ...i, sold_qty: n.sold_qty ?? i.sold_qty, is_sold_out: n.is_sold_out ?? i.is_sold_out, is_full: n.is_full ?? i.is_full, planned_qty: n.planned_qty ?? i.planned_qty } : i)) ?? l);
      })
      .subscribe();
    return () => { sb.removeChannel(ch); };
  }, [today]);

  const all = (items ?? []).filter((i) => i.service_date === day && i.service === service);
  const list = onlyMine ? all.filter((i) => dietConflicts(profile, i.dish).length === 0) : all;
  const hidden = all.length - list.length;
  list.sort((a, b) => Number(soldOut(a)) - Number(soldOut(b)));
  const ended = serviceEnded(day, service, services);

  return (
    <main className="pb-[calc(10.5rem+env(safe-area-inset-bottom))]">
      <header className="sticky top-0 z-30 bg-canvas/95 px-4 pb-2 pt-[max(1rem,env(safe-area-inset-top))] backdrop-blur">
        <h1 className="py-1 text-[26px] font-extrabold tracking-tight">{t("Au menu")}</h1>

        <div className="-mx-4 mt-2 flex gap-2 overflow-x-auto px-4 pb-1 [scrollbar-width:none]">
          {days.map((d) => {
            const has = available.includes(d);
            const active = d === day;
            return (
              <button key={d} disabled={!has} onClick={() => go({ jour: d })}
                className={clsx("flex w-14 shrink-0 flex-col items-center rounded-2xl py-2 transition",
                  active ? "bg-ink text-white" : "bg-card text-ink shadow-[var(--shadow-card)]", !has && "opacity-35")}>
                <span className={clsx("text-[11px] font-bold uppercase", active ? "text-lime" : "text-muted")}>{d === today ? t("Auj.") : shortDay(d, lang)}</span>
                <span className="text-lg font-extrabold">{dayNum(d)}</span>
              </button>
            );
          })}
        </div>

        <div className="-mx-4 mt-3 flex gap-2 overflow-x-auto px-4 pb-1 [scrollbar-width:none]">
          {SERVICES.map((s) => (
            <button key={s} onClick={() => go({ service: s, jour: day })} disabled={!servicesOfDay.includes(s)}
              className={clsx("flex h-10 shrink-0 items-center gap-1.5 rounded-full px-4 text-sm font-bold transition disabled:opacity-35",
                service === s ? "bg-lime text-ink" : "bg-card text-muted shadow-[var(--shadow-card)]")}>
              <ServiceIcon service={s} className="size-4" />{services?.[s].label ? t(services[s].label) : s}
            </button>
          ))}
        </div>
        {cfg && (
          <p className="mt-2 px-1 text-xs font-semibold text-muted">
            {cfg.start.replace(":", "h")} – {cfg.end.replace(":", "h")} · {t("ticket")} {fcfa(cfg.price)}{cfg.extras ? ` · ${t("entrée ou dessert en option")}` : ""}
            {ended && <span className="ml-1 font-bold text-err">· {t("service terminé")}</span>}
          </p>
        )}
      </header>

      <section className="space-y-4 px-4 pt-3">
        {items !== null && available.length > 0 && <MenuDownload day={day} days={available} items={items} services={services} />}
        {prefs ? (
          <label className="flex items-center justify-between gap-3 rounded-2xl bg-card px-4 py-3 text-sm font-bold shadow-[var(--shadow-card)]">
            <span>{t("Seulement ce qui me convient")}<span className="block text-xs font-semibold text-muted">{onlyMine && hidden > 0 ? (lang === "en" ? `${hidden} dish(es) hidden based on your allergies and diet` : `${hidden} plat(s) masqué(s) selon tes allergies et ton régime`) : t("Selon tes allergies et ton régime")}</span></span>
            <input type="checkbox" checked={onlyMine} onChange={(e) => setOnlyMine(e.target.checked)} className="size-5 accent-[var(--color-ink)]" />
          </label>
        ) : (
          <Link href="/app/profil#regime" className="block rounded-2xl border border-dashed border-line px-4 py-3 text-sm font-semibold text-muted">
            🥜 {t("Allergies ou régime (végétarien, sans porc) ?")} <span className="font-bold text-ink underline">{t("Indique-les")}</span>{t(" : on te signalera les plats à éviter.")}
          </Link>
        )}
        {items === null && [0, 1, 2].map((i) => <div key={i} className="h-72 animate-pulse rounded-[24px] bg-card" />)}
        {items !== null && list.length === 0 && (
          <div className="rounded-[24px] border-2 border-dashed border-line p-8 text-center">
            <p className="font-bold">{lang === "en" ? `No ${cfg ? t(cfg.label).toLowerCase() : "service"} that day` : `Pas de ${cfg?.label.toLowerCase() ?? "service"} ce jour-là`}</p>
          </div>
        )}
        {list.map((i) => <DishCard key={i.id} item={i} stat={stats[i.dish.id]} warn={dietConflicts(profile, i.dish)} canBook={!ended} />)}
        {/* Sans choisir le plat à l'avance : un ticket du repas, plat choisi au comptoir */}
        {cfg && !ended && list.length > 0 && (
          <Link href={`/app/acheter?service=${service}`} className="block pt-1 text-center text-sm font-bold text-muted underline underline-offset-2">
            {lang === "en" ? `or buy a ${t(cfg.label)} ticket (${fcfa(cfg.price)}) and choose at the counter` : `ou acheter un ticket ${cfg.label} (${fcfa(cfg.price)}) et choisir au comptoir`}
          </Link>
        )}
      </section>

    </main>
  );
}

function DishCard({ item, stat, warn = [], canBook = true }: { item: MenuItem; stat?: DishStat; warn?: string[]; canBook?: boolean }) {
  const t = useT();
  const lang = useLang();
  const out = soldOut(item);
  const tags = tagsFor(item, stat);
  // Étiquettes de lib/menu : « Bientôt épuisé · N » porte un nombre
  const tagLabel = (l: string) => (l.startsWith("Bientôt épuisé · ") && lang === "en" ? `Almost gone · ${l.slice("Bientôt épuisé · ".length)}` : t(l));
  return (
    <article className={clsx("overflow-hidden rounded-[24px] bg-card shadow-[var(--shadow-card)]", out && "opacity-60")}>
      <Link href={`/app/menu/${item.id}`} className="block transition active:scale-[0.99]">
        <div className="relative">
          <DishImage name={item.dish.name} src={item.dish.photo_url} rounded="rounded-none" className={clsx("h-44 w-full", out && "grayscale")} />
          <div className="absolute left-3 top-3 flex flex-wrap gap-1.5">
            {tags.map((tg) => <span key={tg.label} className={clsx("rounded-full px-2.5 py-1 text-[11px] font-extrabold shadow-sm", TAG_STYLE[tg.tone])}>{tagLabel(tg.label)}</span>)}
          </div>
          {stat?.avg_stars != null && (
            <span className="absolute bottom-3 left-3 flex items-center gap-1 rounded-full bg-white/95 px-2.5 py-1 text-xs font-extrabold">
              <Star className="size-3.5 fill-warn text-warn" />{stat.avg_stars.toFixed(1)}<span className="font-semibold text-muted">({stat.ratings_count})</span>
            </span>
          )}
        </div>
        <div className="flex items-center gap-3 p-4">
          <div className="min-w-0 flex-1">
            <h3 className="text-[17px] font-extrabold leading-snug">{item.dish.name}</h3>
            <p className="mt-1 line-clamp-2 text-[13px] leading-snug text-muted">{item.dish.composition}</p>
            {item.dish.kcal && <p className="mt-2 flex items-center gap-1 text-xs font-semibold text-muted"><Flame className="size-3.5" />{item.dish.kcal} kcal</p>}
            {warn.length > 0 && <p className="mt-2 inline-flex rounded-full bg-err-soft px-2.5 py-1 text-xs font-extrabold text-err">⚠️ {t("Pour toi :")} {(lang === "en" ? warn.map(warnEn) : warn).join(", ")}</p>}
          </div>
          <ChevronRight className="size-5 shrink-0 text-off" />
        </div>
      </Link>
      {/* Réserver ce plat : heure de retrait puis paiement (écran Commander, plat déjà choisi) */}
      {canBook && !out && (
        <div className="px-4 pb-4">
          <Link href={`/app/commander?item=${item.id}`}
            className="flex h-12 items-center justify-center gap-2 rounded-full bg-ink text-[15px] font-extrabold text-white active:scale-[0.99]">
            {t("Réserver ce plat")} <span className="text-lime">·</span> {fcfa(item.price)}
          </Link>
        </div>
      )}
    </article>
  );
}
