"use client";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import clsx from "clsx";
import { Clock, Info, Minus, Plus, WifiOff } from "lucide-react";
import { rpc, supabase } from "@/lib/supabase/client";
import { PageHeader } from "@/components/app/page-header";
import { ServiceIcon } from "@/components/app/service-icon";
import { DishImage } from "@/components/app/dish-image";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import { BiometricConfirm } from "@/components/app/biometric-confirm";
import { useToast } from "@/components/ui/toast";
import { useAppData } from "@/components/app/app-data";
import { sfx } from "@/lib/sfx";
import { ChefPopup } from "@/components/chef";
import { fetchMenu, fetchServices, serviceEnded, soldOut, type Services } from "@/lib/menu";
import { syncTokens } from "@/lib/tickets";
import { addDays, dayNum, dayShort, fcfa, time, todayISO } from "@/lib/format";
import { SERVICES, type Extra, type MenuItem, type ServiceKind } from "@/lib/types";
import { dietConflicts, severeHits, warnEn } from "@/lib/diet";
import { deny } from "@/lib/deny";
import { useT, useLang, type Lang } from "@/lib/i18n";
import { myId } from "@/lib/supabase/client";
import { readCache, writeCache } from "@/lib/offline";
import { queueOrder, queuedOrders } from "@/lib/offline-orders";

// Mots de dietConflicts (français) rendus en anglais ; les noms d'allergènes restent tels quels (données)

type Slot = { at: string; left: number };
type Win = { open: string | null; close: string | null; paused?: boolean };
type OrderCfg = { windows?: Partial<Record<ServiceKind, Win>>; slot_minutes?: number; min_lead_minutes?: number; same_day_only?: boolean; max_days_ahead?: number };

/** État des commandes du jour pour un repas (plage fixée par la cuisine, pause) */
function windowState(win: Win | undefined, isToday: boolean, lang: Lang, now = new Date()) {
  const en = lang === "en";
  if (win?.paused) return { ok: false, text: en ? "The kitchen has paused orders. Try again a bit later." : "La cuisine a mis les commandes en pause. Réessaie un peu plus tard." };
  if (!isToday || !win?.open || !win?.close) return { ok: true, text: null };
  const hm = now.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", timeZone: "Africa/Abidjan" });
  if (en) {
    const range = `${win.open} to ${win.close}`;
    if (hm < win.open) return { ok: false, text: `Today's orders open at ${win.open} (${range}).` };
    if (hm >= win.close) return { ok: false, text: `Today's orders are closed (${range}). Come back tomorrow.` };
    return { ok: true, text: `Today's orders are open from ${range}.` };
  }
  const range = `${win.open.replace(":", "h")} à ${win.close.replace(":", "h")}`;
  if (hm < win.open) return { ok: false, text: `Les commandes du jour ouvrent à ${win.open.replace(":", "h")} (de ${range}).` };
  if (hm >= win.close) return { ok: false, text: `Les commandes du jour sont fermées (de ${range}). Reviens demain.` };
  return { ok: true, text: `Commandes du jour ouvertes de ${range}.` };
}

/** Jour en anglais : « Mon » (short) ou « Monday 9 » (long) */
function enShort(d: string, style: "short" | "long") {
  const dt = new Date(d + "T12:00:00Z");
  const wd = dt.toLocaleDateString("en-GB", { weekday: style, timeZone: "Africa/Abidjan" });
  return style === "short" ? wd : `${wd} ${dt.toLocaleDateString("en-GB", { day: "numeric", timeZone: "Africa/Abidjan" })}`;
}

/** Commande à heure de retrait : je choisis mon plat et l'heure, la cuisine prépare, je passe le prendre. */
export default function OrderPage() {
  return <Suspense><Order /></Suspense>;
}

function Order() {
  const router = useRouter();
  const params = useSearchParams();
  const toast = useToast();
  const { balance, refresh, profile } = useAppData();
  const t = useT();
  const lang = useLang();
  const en = lang === "en";
  // Heure « 14h05 » en français, « 14:05 » en anglais
  const hm = (ts: string) => (en ? time(ts).replace("h", ":") : time(ts));
  const today = todayISO();
  const [items, setItems] = useState<MenuItem[] | null>(null);
  const [services, setServices] = useState<Services | null>(null);
  const [extras, setExtras] = useState<Extra[]>([]);
  const [day, setDay] = useState<string | null>(null);
  const [service, setService] = useState<ServiceKind | null>(null);
  const itemId = params.get("item");
  // Panier : plats et suppléments en quantité (comme sur WhatsApp)
  const [cart, setCart] = useState<Record<string, number>>(() => (params.get("item") ? { [params.get("item")!]: 1 } : {}));
  const [extraQty, setExtraQty] = useState<Record<string, number>>({});
  const [slots, setSlots] = useState<Slot[] | null>(null);
  const [slot, setSlot] = useState<string | null>(null);
  const [pinOpen, setPinOpen] = useState(false);
  const [pinError, setPinError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ no: number; dish: string; at: string } | null>(null);
  const [queued, setQueued] = useState<{ summary: string; at: string | null } | null>(null);
  // Hors ligne : la commande est gardée sur le téléphone et part au retour du réseau (revérifiée par le serveur)
  const [online, setOnline] = useState(true);
  useEffect(() => {
    const f = () => setOnline(navigator.onLine);
    f(); window.addEventListener("online", f); window.addEventListener("offline", f);
    return () => { window.removeEventListener("online", f); window.removeEventListener("offline", f); };
  }, []);
  const [pendingTotal, setPendingTotal] = useState(0);
  useEffect(() => {
    const q = () => myId().then((id) => setPendingTotal(queuedOrders(id).reduce((a, o) => a + o.total, 0)));
    q(); window.addEventListener("vatel:order-queue", q);
    return () => window.removeEventListener("vatel:order-queue", q);
  }, []);
  const [orderCfg, setOrderCfg] = useState<OrderCfg>({});

  useEffect(() => {
    fetchServices().then(setServices);
    // Suppléments et règles de commande gardés sur le téléphone pour commander hors ligne
    setExtras(readCache<Extra[]>("vatel:extras") ?? []);
    setOrderCfg(readCache<OrderCfg>("vatel:orders-cfg") ?? {});
    if (!navigator.onLine) return;
    supabase().from("extras").select("id, name, price, kind").eq("is_active", true).in("kind", ["starter", "dessert"]).order("sort")
      .then(({ data }) => { if (data) { setExtras(data as Extra[]); writeCache("vatel:extras", data); } });
    supabase().from("settings").select("value").eq("key", "orders").maybeSingle()
      .then(({ data }) => { if (data?.value) { setOrderCfg(data.value as OrderCfg); writeCache("vatel:orders-cfg", data.value); } });
  }, [today]);
  // Réservation à l'avance : les jours ouverts par la cuisine (réglage « orders » : same_day_only / max_days_ahead)
  const ahead = orderCfg.same_day_only === false ? Math.min(orderCfg.max_days_ahead ?? 7, 14) : 0;
  useEffect(() => { fetchMenu(today, addDays(today, ahead)).then(setItems); }, [today, ahead]);

  // Repas encore commandables (service pas terminé)
  const open = useMemo(() => (items ?? []).filter((i) => !serviceEnded(i.service_date, i.service, services)), [items, services]);
  const days = useMemo(() => [...new Set(open.map((i) => i.service_date))].sort(), [open]);

  // Sélection initiale : le plat passé en paramètre, sinon le premier jour / repas disponible
  // (le menu arrive en deux temps : aujourd'hui, puis les jours suivants ; le plat de « Réserver » est appliqué dès qu'il apparaît)
  const paramDone = useRef(false);
  useEffect(() => {
    if (!items) return;
    const fromParam = itemId ? open.find((i) => i.id === itemId) : undefined;
    if (fromParam && !paramDone.current) {
      paramDone.current = true;
      setDay(fromParam.service_date); setService(fromParam.service);
      setCart((c) => (c[fromParam.id] ? c : { [fromParam.id]: 1 }));
      return;
    }
    if (day) return;
    const d = days[0] ?? null;
    setDay(d);
    setService(open.find((i) => i.service_date === d)?.service ?? null);
  }, [items, open, days, day, itemId]);

  const servicesOfDay = SERVICES.filter((s) => open.some((i) => i.service_date === day && i.service === s));
  const list = open.filter((i) => i.service_date === day && i.service === service);
  const lines = list.filter((i) => (cart[i.id] ?? 0) > 0).map((i) => ({ item: i, qty: cart[i.id] }));
  const n = lines.reduce((a, l) => a + l.qty, 0);
  const item = lines[0]?.item ?? null; // au moins un plat choisi
  const resetCart = () => { setCart({}); setExtraQty({}); };
  const setQty = (id: string, d: number) => setCart((c) => {
    if (d > 0 && n >= 10) return c; // 10 plats au plus
    return { ...c, [id]: Math.max(0, (c[id] ?? 0) + d) };
  });
  const kindCount = (k: string) => extras.filter((e) => e.kind === k).reduce((a, e) => a + (extraQty[e.id] ?? 0), 0);
  const setExtra = (e: Extra, d: number) => setExtraQty((x) => {
    if (d > 0 && kindCount(e.kind) >= n) return x; // au plus 1 entrée et 1 dessert par plat
    return { ...x, [e.id]: Math.max(0, (x[e.id] ?? 0) + d) };
  });
  // Moins de plats : on retire les suppléments en trop (au plus 1 entrée et 1 dessert par plat), les derniers d'abord
  useEffect(() => {
    setExtraQty((x) => {
      const y = { ...x }; let changed = false;
      for (const k of ["starter", "dessert"]) {
        let over = extras.filter((e) => e.kind === k).reduce((a, e) => a + (y[e.id] ?? 0), 0) - n;
        for (const e of [...extras].reverse()) {
          if (over <= 0) break;
          if (e.kind !== k || !y[e.id]) continue;
          const take = Math.min(y[e.id], over); y[e.id] -= take; over -= take; changed = true;
        }
      }
      return changed ? y : x;
    });
  }, [n, extras]);
  // Plat épuisé, interdit (allergie grave) ou hors du menu du jour : il ne reste pas dans le panier (ex. lien ?item=)
  useEffect(() => {
    if (!items) return;
    setCart((c) => {
      const bad = Object.keys(c).filter((id) => { const i = items.find((x) => x.id === id); return !!i && (soldOut(i) || severeHits(profile, i.dish).length > 0); });
      if (!bad.length) return c;
      const y = { ...c }; bad.forEach((id) => delete y[id]); return y;
    });
  }, [items, profile]);
  const cfg = service && services ? services[service] : null;
  const withExtras = !!cfg?.extras;
  const chosenExtras = useMemo(() => (withExtras ? extras.filter((e) => (extraQty[e.id] ?? 0) > 0).map((e) => ({ ...e, qty: Math.min(extraQty[e.id], n) })) : []), [withExtras, extras, extraQty, n]);
  const total = lines.reduce((a, l) => a + l.item.price * l.qty, 0) + chosenExtras.reduce((s, e) => s + e.price * e.qty, 0);
  const needsPin = true; // chaque commande est confirmée par le titulaire (PIN)
  const win = windowState(service ? orderCfg.windows?.[service] : undefined, day === today, lang);
  const insufficient = balance !== null && item !== null && balance - pendingTotal < total; // commandes en attente déjà comptées

  // Heure limite d'annulation : 1 h 30 avant le début du service
  const cancelUntil = cfg && day ? (() => {
    const [h, m] = cfg.start.split(":").map(Number);
    const mins = h * 60 + m - 90;
    return `${String(Math.floor(mins / 60)).padStart(2, "0")}${en ? ":" : "h"}${String(mins % 60).padStart(2, "0")}`;
  })() : null;

  // Créneaux du repas choisi
  useEffect(() => {
    if (!day || !service) return;
    setSlots(null); setSlot(null);
    if (!online) {
      // Hors ligne : heures du service (sans le nombre de places) ; c'est une heure SOUHAITÉE,
      // le serveur prendra la plus proche libre au retour du réseau
      const c = (services ?? undefined)?.[service];
      if (!c) { setSlots([]); return; }
      const step = orderCfg.slot_minutes ?? 15, lead = orderCfg.min_lead_minutes ?? 20;
      const l: Slot[] = [];
      for (let t = new Date(`${day}T${c.start}:00Z`).getTime(); t < new Date(`${day}T${c.end}:00Z`).getTime(); t += step * 60_000) {
        if (t >= Date.now() + lead * 60_000) l.push({ at: new Date(t).toISOString(), left: 99 });
      }
      setSlots(l); setSlot(l[0]?.at ?? null);
      return;
    }
    rpc<Slot[]>("order_slots", { p_date: day, p_service: service }).then((r) => {
      const l = (Array.isArray(r) ? r : []) as Slot[];
      setSlots(l);
      setSlot(l.find((s) => s.left > 0)?.at ?? null);
    });
  }, [day, service, online, services, orderCfg.slot_minutes, orderCfg.min_lead_minutes]);

  const summary = [...lines.map((l) => `${l.qty > 1 ? `${l.qty} × ` : ""}${l.item.dish.name}`), ...chosenExtras.map((e) => `${e.qty > 1 ? `${e.qty} × ` : ""}${e.name}`)].join(" + ");

  // Sans réseau : la commande attend sur le téléphone (PIN chiffré) et part toute seule au retour du réseau
  const queue = useCallback(async (pin: string) => {
    if (!item || !day) return;
    const uid = await myId();
    if (!uid) return toast("err", t("Connexion requise."));
    setBusy(true);
    const r = await queueOrder({
      user_id: uid, date: day, summary, total, pickup_pref: slot,
      items: lines.map((l) => ({ menu_item_id: l.item.id, qty: l.qty })),
      extras: chosenExtras.map((e) => ({ extra_id: e.id, qty: e.qty })),
    }, pin);
    setBusy(false);
    setPinOpen(false);
    if (!r.ok) return toast("err", r.message);
    sfx.success();
    setQueued({ summary, at: slot });
    setTimeout(() => router.replace("/app"), 3200);
  }, [item, day, summary, total, slot, lines, chosenExtras, toast, router, t]);

  const order = useCallback(async (pin?: string) => {
    if (!item || !slot) return;
    if (!navigator.onLine) {
      // Face ID demande le serveur : sans réseau, seul le code PIN peut accompagner la commande
      if (!pin || pin === "BIOMETRIC") { setPinError(en ? "No connection: use your PIN code." : "Pas de connexion : utilise ton code PIN."); setPinOpen(true); return; }
      return queue(pin);
    }
    setBusy(true);
    const r = await rpc<{ ticket_id: string; order_no: number; dish: string; pickup_at: string }>("place_order_cart", {
      p_items: lines.map((l) => ({ menu_item_id: l.item.id, qty: l.qty })), p_pickup_at: slot,
      p_extras: chosenExtras.map((e) => ({ extra_id: e.id, qty: e.qty })), p_pin: pin ?? null,
    });
    setBusy(false);
    if (!r.ok) {
      if (r.code === "PIN_NOT_SET") { setPinOpen(false); toast("err", t("Crée d'abord ton code PIN.")); router.push("/app/profil?pin=new&back=/app/commander"); return; }
      if (r.code.startsWith("PIN")) { setPinError(r.message); setPinOpen(true); return; }
      if (r.code === "ALLERGY_SEVERE") deny(document.getElementById("order-btn"));
      setPinOpen(false); toast("err", r.message);
      if (r.code === "SLOT_FULL" || r.code === "SLOT_TOO_SOON") rpc<Slot[]>("order_slots", { p_date: day, p_service: service }).then((s) => setSlots(Array.isArray(s) ? s as Slot[] : []));
      return;
    }
    setPinOpen(false);
    refresh();
    sfx.success();
    try { localStorage.setItem(`dabali:chef:${r.ticket_id}`, "received"); } catch {} // la mascotte « reçue » vient d'être vue ici
    setDone({ no: r.order_no, dish: r.dish, at: r.pickup_at });
    await Promise.all([syncTokens(), new Promise((ok) => setTimeout(ok, 2200))]);
    router.replace(`/app/tickets/${r.ticket_id}`);
  }, [item, lines, slot, chosenExtras, day, service, refresh, router, toast, t, queue, en]);

  const dayLabel = (d: string) => (d === today ? t("aujourd'hui") : d === addDays(today, 1) ? t("demain") : en ? enShort(d, "long") : `${dayShort(d).toLowerCase()} ${dayNum(d)}`);

  return (
    <main className="pb-44">
      <PageHeader title={t("Commander")} />
      <div className="px-4">
        <p className="text-sm font-semibold text-muted">{t("Choisis tes plats (en quantité) et ton heure : la cuisine prépare, tu n'as plus qu'à passer le prendre.")}</p>
        {!online && (
          <p className="mt-3 flex gap-2 rounded-2xl bg-warn-soft px-3.5 py-3 text-[13px] font-semibold text-ink">
            <WifiOff className="mt-0.5 size-4 shrink-0" />
            <span>{en
              ? "No connection: your order is kept on this phone and sent as soon as the network is back. Stock, balance and allergies are checked then."
              : "Pas de connexion : ta commande est gardée sur ce téléphone et part dès le retour du réseau. Stock, solde et allergies sont vérifiés à ce moment-là."}</span>
          </p>
        )}

        {/* Jour */}
        <div className="-mx-4 mt-4 flex gap-2 overflow-x-auto px-4 pb-1 [scrollbar-width:none]">
          {items === null && [0, 1, 2, 3].map((i) => <div key={i} className="h-[60px] w-14 shrink-0 animate-pulse rounded-2xl bg-card" />)}
          {days.map((d) => (
            <button key={d} onClick={() => { setDay(d); const s = open.find((i) => i.service_date === d)?.service ?? null; setService(s); resetCart(); }}
              className={clsx("flex w-14 shrink-0 flex-col items-center rounded-2xl py-2 transition",
                d === day ? "bg-ink text-white" : "bg-card text-ink shadow-[var(--shadow-card)]")}>
              <span className={clsx("text-[11px] font-bold uppercase", d === day ? "text-lime" : "text-muted")}>{d === today ? t("Auj.") : en ? enShort(d, "short") : dayShort(d)}</span>
              <span className="text-lg font-extrabold">{dayNum(d)}</span>
            </button>
          ))}
        </div>

        {/* Repas */}
        {servicesOfDay.length > 0 && (
          <div className="-mx-4 mt-3 flex gap-2 overflow-x-auto px-4 pb-1 [scrollbar-width:none]">
            {servicesOfDay.map((s) => (
              <button key={s} onClick={() => { setService(s); resetCart(); }}
                className={clsx("flex h-10 shrink-0 items-center gap-1.5 rounded-full px-4 text-sm font-bold transition",
                  service === s ? "bg-lime text-ink" : "bg-card text-muted shadow-[var(--shadow-card)]")}>
                <ServiceIcon service={s} className="size-4" />{services?.[s].label ? t(services[s].label) : s}
              </button>
            ))}
          </div>
        )}

        {items !== null && days.length === 0 && (
          <div className="mt-6 rounded-[24px] border-2 border-dashed border-line p-8 text-center">
            <p className="font-bold">{t("Pas encore de menu à commander")}</p>
            <p className="mt-1 text-sm text-muted">{t("Le menu de la semaine n'est pas encore publié.")}</p>
          </div>
        )}

        {win.text && (
          <p className={clsx("mt-4 rounded-2xl px-3.5 py-3 text-[13px] font-bold", win.ok ? "bg-ok-soft text-[#15803d]" : "bg-warn-soft text-ink")}>
            <Clock className="mr-1.5 inline size-4 align-[-3px]" />{win.text}
          </p>
        )}

        {/* Plat */}
        {list.length > 0 && (
          <section className="mt-5">
            <h2 className="text-[15px] font-extrabold">{t("Tes plats")} <span className="text-sm font-semibold text-muted">{t("plusieurs possibles, 10 au plus")}</span></h2>
            <div className="mt-2 space-y-2.5">
              {list.map((i) => {
                const banned = severeHits(profile, i.dish); // allergie grave : plat interdit
                const out = soldOut(i) || banned.length > 0;
                const q = cart[i.id] ?? 0;
                return (
                  <div key={i.id} onClick={banned.length ? (e) => { deny(e.currentTarget); toast("err", en ? `${i.dish.name} contains ${banned.join(", ")}: severe allergy, can't be ordered.` : `${i.dish.name} contient ${banned.join(", ")} : allergie grave, commande impossible.`); } : undefined}
                    className={clsx("flex w-full items-center gap-3 rounded-[22px] border-2 bg-card p-2.5 pr-3 transition",
                      q > 0 ? "border-ink" : "border-transparent shadow-[var(--shadow-card)]", soldOut(i) && "opacity-45", banned.length > 0 && "cursor-not-allowed border-err/40 bg-err-soft/40")}>
                    <DishImage name={i.dish.name} src={i.dish.photo_url} className={clsx("size-16 shrink-0", out && "grayscale")} />
                    <div className="min-w-0 flex-1">
                      <p className="font-extrabold leading-tight">{i.dish.name}</p>
                      <p className="mt-0.5 text-sm font-bold text-ink-2">{soldOut(i) ? t("Épuisé") : severeHits(profile, i.dish).length ? t("Interdit pour toi") : fcfa(i.price)}</p>
                      {dietConflicts(profile, i.dish).length > 0 && <p className="mt-0.5 text-xs font-extrabold text-err">{banned.length ? "" : "⚠️ "}{(en ? dietConflicts(profile, i.dish).map(warnEn) : dietConflicts(profile, i.dish)).join(", ")}</p>}
                    </div>
                    {banned.length > 0 && <span className="grid size-9 shrink-0 place-items-center rounded-full bg-err text-lg text-white" aria-label={t("Interdit")}>⛔</span>}
                    {!out && <Stepper value={q} onMinus={() => setQty(i.id, -1)} onPlus={() => setQty(i.id, 1)} label={i.dish.name} />}
                  </div>
              );
              })}
            </div>
          </section>
        )}

        {/* Entrée / dessert : un de chaque au plus */}
        {item && withExtras && extras.length > 0 && (
          <section className="mt-5">
            <h2 className="text-[15px] font-extrabold">{t("En plus")} <span className="text-sm font-semibold text-muted">{t("facultatif")} · {n > 1 ? (en ? `up to ${n} starters and ${n} desserts` : `${n} entrées et ${n} desserts au plus`) : t("1 entrée et 1 dessert au plus")}</span></h2>
            {([["starter", "Entrée"], ["dessert", "Dessert"]] as const).map(([kind, title]) => (
              <div key={kind} className="mt-2">
                <p className="mb-1.5 text-xs font-bold uppercase tracking-wider text-muted">{t(title)}</p>
                <div className="flex flex-wrap gap-2">
                  {extras.filter((e) => e.kind === kind).map((e) => {
                    const q = extraQty[e.id] ?? 0;
                    return (
                      <div key={e.id} className={clsx("flex items-center gap-2 rounded-full py-1 pl-3.5 pr-1 text-sm font-bold", q > 0 ? "bg-ink text-white" : "bg-card shadow-[var(--shadow-card)]")}>
                        <span>{e.name} <span className={q > 0 ? "text-lime" : "text-muted"}>+{fcfa(e.price)}</span></span>
                        <Stepper small dark={q > 0} value={q} onMinus={() => setExtra(e, -1)} onPlus={() => setExtra(e, 1)} label={e.name} />
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </section>
        )}

        {/* Heure de retrait */}
        {item && (
          <section className="mt-5">
            <h2 className="flex items-center gap-1.5 text-[15px] font-extrabold"><Clock className="size-4" />{en ? `I'll pick it up ${day ? dayLabel(day) : ""} ${online ? "at" : "around"}…` : `Je passe le prendre ${day ? dayLabel(day) : ""} ${online ? "à" : "vers"}…`}</h2>
            {!online && <p className="mt-0.5 text-xs font-semibold text-muted">{en ? "Preferred time: if it's full when the order is sent, the nearest free time is taken." : "Heure souhaitée : si elle est complète à l'envoi, la plus proche libre est prise."}</p>}
            <div className="mt-2 grid grid-cols-4 gap-2">
              {slots === null && [0, 1, 2, 3].map((i) => <div key={i} className="h-12 animate-pulse rounded-2xl bg-card" />)}
              {slots?.map((s) => (
                <button key={s.at} disabled={s.left < Math.max(1, n)} onClick={() => setSlot(s.at)}
                  className={clsx("flex h-12 flex-col items-center justify-center rounded-2xl text-sm font-extrabold transition active:scale-95 disabled:opacity-35",
                    slot === s.at ? "bg-lime text-ink ring-2 ring-ink" : "bg-card shadow-[var(--shadow-card)]")}>
                  {hm(s.at)}
                  {s.left < Math.max(1, n) ? <span className="text-[10px] font-bold text-err">{s.left === 0 ? t("complet") : en ? `${s.left} left` : `${s.left} places`}</span>
                    : s.left <= 5 ? <span className="text-[10px] font-bold text-warn">{en ? `${s.left} left` : `${s.left} places`}</span> : null}
                </button>
              ))}
            </div>
            {slots?.length === 0 && <p className="mt-2 rounded-xl bg-warn-soft px-3 py-2 text-sm font-bold text-ink">{t("Plus de créneau pour ce repas : choisis un autre jour.")}</p>}
            <p className="mt-3 flex gap-2 rounded-2xl bg-lime-soft px-3.5 py-3 text-[13px] font-semibold text-ink-2">
              <Info className="mt-0.5 size-4 shrink-0" />
              <span>{en
                ? `Pick it up between the chosen time and ${cfg?.end ?? ""}. Refunded if cancelled until ${cancelUntil ?? ""} ${day ? dayLabel(day) : ""}.`
                : `À récupérer entre l'heure choisie et ${cfg?.end.replace(":", "h") ?? ""}. Annulation remboursée jusqu'à ${cancelUntil ?? ""} ${day ? dayLabel(day) : ""}.`}
                <b className="text-ink"> {t("Non récupérée à temps : le plat est perdu.")}</b></span>
            </p>
          </section>
        )}
      </div>

      <div className="fixed inset-x-0 bottom-0 z-50 mx-auto max-w-md bg-gradient-to-t from-canvas via-canvas to-transparent px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-6">
        {insufficient && (
          <p className="mb-2 rounded-xl bg-err-soft px-3 py-2 text-center text-[13px] font-bold text-err">
            {t("Solde insuffisant")} ({fcfa(balance ?? 0)}). <a href="/app/recharger" className="underline">{t("Recharger")}</a>
          </p>
        )}
        <Button id="order-btn" size="lg" block variant="dark" disabled={!item || !slot || insufficient || !win.ok} loading={busy}
          onClick={() => (needsPin ? (setPinError(null), setPinOpen(true)) : order())}>
          <span className="whitespace-nowrap">{item ? <>{online ? t("Commander") : (en ? "Order offline" : "Commander hors ligne")}{n > 1 ? (en ? ` ${n} dishes` : ` ${n} plats`) : ""}{slot ? ` · ${hm(slot)}` : ""} <span className="text-lime">·</span> {fcfa(total)}</> : t("Choisis tes plats")}</span>
        </Button>
      </div>

      <Sheet open={pinOpen} onClose={() => setPinOpen(false)} title={t("Confirmer la commande")}>
        <p className="-mt-2 mb-4 text-sm text-muted">{summary} · {t("retrait")} {online ? "" : (en ? "around " : "vers ")}{slot ? hm(slot) : ""} · <b className="text-ink">{fcfa(total)}</b></p>
        {/* Hors ligne : Face ID a besoin du serveur, on confirme avec le code PIN (vérifié à l'envoi) */}
        <BiometricConfirm enabled={online && !!profile?.biometric_enabled} mode="send" onConfirmed={(p) => order(p)} pinError={pinError} busy={busy} />
      </Sheet>

      {queued && (
        <div className="fixed inset-0 z-[60] flex flex-col items-center justify-center bg-ink px-8 text-center text-white" role="status">
          <span className="animate-pop grid size-24 place-items-center rounded-full bg-lime text-ink"><WifiOff className="size-12" /></span>
          <p className="mt-6 text-sm font-bold uppercase tracking-wider text-lime">{en ? "Kept on your phone" : "Gardée sur ton téléphone"}</p>
          <p className="mt-1 text-3xl font-extrabold">{en ? "Sent when the network is back" : "Envoyée au retour du réseau"}</p>
          <p className="mt-3 text-lg font-semibold text-white/80">{queued.summary}{queued.at ? <><br />{en ? `around ${hm(queued.at)}` : `vers ${time(queued.at)}`}</> : null}</p>
          <p className="mt-6 text-sm text-white/60">{en ? "You'll get a message when it reaches the kitchen. Nothing is charged until then." : "Un message te prévient quand elle arrive en cuisine. Rien n'est débité avant."}</p>
        </div>
      )}
      {done && (
        <ChefPopup scene="received" message={t("Envoyée en cuisine !")}
          sub={<>
            <p className="font-extrabold text-ink">{en ? `Order #${done.no}` : `Commande n° ${done.no}`} · {done.dish}</p>
            <p>{en ? `ready for pickup at ${hm(done.at)}` : `à récupérer à ${time(done.at)}`}</p>
            <p className="mt-1 text-xs text-muted">{t("On te prévient dès qu'elle est prête.")}</p>
          </>} />
      )}
    </main>
  );
}

/** − 0 + : quantité d'un plat ou d'un supplément */
function Stepper({ value, onMinus, onPlus, label, small, dark }: { value: number; onMinus: () => void; onPlus: () => void; label: string; small?: boolean; dark?: boolean }) {
  const t = useT();
  const b = clsx("grid place-items-center rounded-full transition active:scale-90", small ? "size-7" : "size-9",
    dark ? "bg-white/15 text-white" : "bg-canvas text-ink");
  return (
    <div className="flex shrink-0 items-center gap-1.5">
      {value > 0 && <>
        <button type="button" className={b} onClick={onMinus} aria-label={`${t("Retirer :")} ${label}`}><Minus className="size-4" /></button>
        <span className={clsx("min-w-5 text-center font-extrabold", small ? "text-sm" : "text-base")}>{value}</span>
      </>}
      <button type="button" className={clsx(b, value === 0 && !dark && "!bg-ink !text-lime")} onClick={onPlus} aria-label={`${t("Ajouter :")} ${label}`}><Plus className="size-4" /></button>
    </div>
  );
}
