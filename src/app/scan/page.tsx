"use client";
import { Bitmoji } from "@/components/bitmoji";
import { ChefPopup } from "@/components/chef";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import clsx from "clsx";
import { Check, X, AlertTriangle, Camera, Video, LogOut, CameraOff, PhoneOff, HardHat, ShoppingCart, History, Volume2, VolumeX, Volume1 } from "lucide-react";
import Link from "next/link";
import { edge, rpc, supabase } from "@/lib/supabase/client";
import { Logo } from "@/components/logo";
import { ServiceIcon } from "@/components/app/service-icon";
import { DishImage } from "@/components/app/dish-image";
import { NoPhoneSheet } from "@/components/scan/no-phone-sheet";
import { StaffSheet } from "@/components/scan/staff-sheet";
import { PlateScan } from "@/components/plate-scan";
import { currentService, fetchServices, type Services } from "@/lib/menu";
import { todayISO, SERVICE_LABEL } from "@/lib/format";
import { SERVICES, type Extra, type ServiceKind } from "@/lib/types";
import { deny } from "@/lib/deny";
import { audioPref, say, setAudioPref, soundError, soundOk, soundServed, type AudioPref } from "@/lib/scan-sounds";

type Dish = { menu_item_id: string; name: string; photo_url: string | null; available: boolean; left: number | null };
type Scan = { ticket_id: string; client: string; ticket: string; extras: Extra[]; dishes: Dish[]; batch_size?: number; remaining?: number; gift_from?: string | null; is_reward?: boolean; method?: "pin"; secured?: boolean; avatar?: string | null; user_id?: string;
  order?: { no: number; dish: string; pickup_at: string; ready: boolean };
  guest?: { event: string; seq: number; guests: number; left: number; dishes: { menu_item_id: string; name: string; qty: number }[] } };
type Fail = { code: string; message: string };
// Allergies du client (après le scan) : plats à ne pas servir / à signaler
type Risk = { severe: string[]; reasons: string[] };
type Alert = { allergies: string[]; severe: string[]; diets: string[]; order_risks: (Risk & { dish: string })[]; dish_risks: Record<string, Risk> };
type Counters = { served: number; outstanding: number };

const SPOKEN: Record<string, string> = {
  ALREADY_USED: "Ticket déjà utilisé", EXPIRED: "Ticket expiré", INVALID_QR: "QR invalide", CANCELLED: "Ticket annulé",
  WRONG_SERVICE: "Mauvais service", SOLD_OUT: "Plat épuisé", WRONG_DAY: "Commande pour un autre jour", TOO_EARLY: "Commande pas encore prête",
  ALLERGY_SEVERE: "Allergie grave, plat refusé",
};

export default function ScanPage() {
  const router = useRouter();
  const video = useRef<HTMLVideoElement>(null);
  const [services, setServices] = useState<Services | null>(null);

  // Fiche de courses attribuée à cet agent : pastille sur le panier (temps réel)
  const [shopping, setShopping] = useState(0);
  useEffect(() => {
    const sb = supabase();
    const count = async () => {
      const { data: { user } } = await sb.auth.getUser();
      if (!user) return;
      const { data: l } = await sb.from("shopping_lists").select("id").eq("assigned_to", user.id).in("status", ["assigned", "shopping"]);
      if (!l?.length) return setShopping(0);
      const { count: n } = await sb.from("shopping_items").select("id", { count: "exact", head: true }).in("list_id", l.map((x) => x.id)).eq("status", "todo");
      setShopping(n ?? 0);
    };
    count();
    const ch = sb.channel("scan-shopping")
      .on("postgres_changes", { event: "*", schema: "public", table: "shopping_lists" }, count)
      .on("postgres_changes", { event: "*", schema: "public", table: "shopping_items" }, count).subscribe();
    return () => { sb.removeChannel(ch); };
  }, []);
  const [service, setService] = useState<ServiceKind>(() => currentService(null));
  const [scan, setScan] = useState<Scan | null>(null);
  const [fail, setFail] = useState<Fail | null>(null);
  const [served, setServed] = useState<string | null>(null);
  const [alert, setAlert] = useState<Alert | null>(null);
  const [counters, setCounters] = useState<Counters | null>(null);
  const [camErr, setCamErr] = useState<string | null>(null);
  const [agent, setAgent] = useState("");
  const [role, setRole] = useState("");
  const [manual, setManual] = useState(false);
  const [staffQ, setStaffQ] = useState<string | null>(null); // repas du personnel (carte QR scannée ou recherche)
  const [plate, setPlate] = useState(false); // photo d'une assiette rendue (gaspillage)
  const manualRef = useRef(false); // caméra en pause pendant la recherche « sans téléphone »
  useEffect(() => { manualRef.current = manual || staffQ !== null; }, [manual, staffQ]);
  const [audioMode, setAudioMode] = useState<AudioPref>("on");
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    setAudioMode(audioPref());
    setNow(new Date());
    const id = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(id);
  }, []);
  const cycleAudio = () => {
    const next: AudioPref = audioMode === "on" ? "sound" : audioMode === "sound" ? "off" : "on";
    setAudioPref(next); setAudioMode(next);
    if (next !== "off") soundServed();
    if (next === "on") say("Voix activée");
  };
  const busy = useRef(false);
  const lastToken = useRef<{ t: string; at: number } | null>(null);
  const date = todayISO();

  const loadCounters = useCallback(() => {
    rpc<Counters>("service_counters", { p_date: date, p_service: service })
      .then((r) => r.ok !== false && setCounters(r as unknown as Counters));
  }, [date, service]);

  useEffect(() => { fetchServices().then((s) => { setServices(s); setService(currentService(s)); }); }, []);
  useEffect(() => { loadCounters(); const id = setInterval(loadCounters, 20_000); return () => clearInterval(id); }, [loadCounters]);
  useEffect(() => {
    supabase().auth.getUser().then(async ({ data: { user } }) => {
      if (!user) return;
      const { data } = await supabase().from("profiles").select("full_name, role").eq("id", user.id).single();
      setAgent(data?.full_name ?? "");
      setRole(data?.role ?? "");
    });
  }, []);

  const alertFor = useRef<string | null>(null); // ticket dont on attend l'alerte (une réponse en retard ne s'affiche pas sur le client suivant)
  const reset = useCallback(() => { setScan(null); setFail(null); setServed(null); setAlert(null); alertFor.current = null; busy.current = false; }, []);

  // Après chaque ticket validé : allergies du client et plats à risque (annonce vocale si allergie)
  const loadAlert = useCallback(async (ticketId: string) => {
    alertFor.current = ticketId;
    const r = await rpc<Alert>("counter_allergy_alert", { p_ticket_id: ticketId });
    if (!r.ok || alertFor.current !== ticketId) return;
    const a = r as unknown as Alert;
    if (!a.allergies?.length && !a.diets?.length) return;
    setAlert(a);
    const danger = a.order_risks?.some((x) => x.severe.length);
    if (danger) { soundError(); say("Attention ! Allergie grave. Ne pas remettre cette commande sans vérifier."); }
    else if (a.severe?.length) say(`Attention, allergie grave : ${a.severe.join(", ")}.`);
    else if (a.allergies?.length) say(`Allergie : ${a.allergies.join(", ")}.`);
  }, []);

  const redeem = useCallback(async (token: string) => {
    const now = Date.now();
    if (busy.current || manualRef.current) return;
    if (lastToken.current && lastToken.current.t === token && now - lastToken.current.at < 4000) return;
    busy.current = true;
    lastToken.current = { t: token, at: now };
    if (/^DABALI:/i.test(token.trim())) {
      // Carte du personnel : repas subventionné
      const st = await rpc<{ results: unknown[] }>("staff_lookup", { p_query: token.trim() });
      if (st.ok && st.results.length === 1) { busy.current = false; setStaffQ(token.trim()); return; }
      // Sinon : QR de profil (transferts) présenté par erreur à la place du ticket
      soundError(); say("QR de profil, pas un ticket");
      setFail({ code: "PROFILE_QR", message: "C'est le QR de profil du client, pas un ticket. Il doit ouvrir « Mes tickets » et toucher son ticket." });
      setTimeout(reset, 3500);
      return;
    }
    // Bon invité (délégation) : QR imprimé « VATEL-INVITE:… », vérifié par la base
    const r = /^VATEL-INVITE:/i.test(token.trim())
      ? await rpc<Scan>("guest_redeem", { p_code: token.trim(), p_service_date: date, p_service: service })
      : await edge<Scan>("redeem-ticket", { token, service_date: date, service });
    if (r.ok) {
      const sc = r as unknown as Scan;
      soundOk();
      const extras = sc.extras?.length ? `Avec ${sc.extras.map((e) => e.name).join(" et ")}.` : "Sans supplément.";
      say(sc.guest ? `Invité. ${sc.guest.event}.`
        : sc.order ? `${sc.client.split(" ")[0]}. Commande numéro ${sc.order.no}. ${sc.order.dish}. ${sc.extras?.length ? extras : ""}`
        : `${sc.client.split(" ")[0]}. ${sc.ticket} valide. ${extras}`);
      setScan(sc); loadCounters();
      if (sc.guest) return; // compte système « Réceptions » : pas d'allergies ni d'avatar à charger
      loadAlert(sc.ticket_id);
      // Bitmoji du client (aide à le reconnaître) : chargé juste après, sans retarder la validation
      supabase().from("tickets").select("user_id, user:profiles!tickets_user_id_fkey(avatar)").eq("id", sc.ticket_id).single()
        .then(({ data }) => { if (data) setScan((s) => s && s.ticket_id === sc.ticket_id ? { ...s, user_id: data.user_id, avatar: (data.user as unknown as { avatar: string | null } | null)?.avatar ?? null } : s); });
    } else {
      soundError((r as Fail).code);
      say(SPOKEN[(r as Fail).code] ?? "Refusé");
      setFail(r as Fail); setTimeout(reset, 2800);
    }
  }, [date, service, loadCounters, reset, loadAlert]);

  async function serve(d: Dish) {
    if (!scan) return;
    const r = await rpc<{ dish: string }>("serve_dish", { p_ticket_id: scan.ticket_id, p_menu_item_id: d.menu_item_id });
    if (!r.ok) { setFail(r as Fail); soundError((r as Fail).code); say(SPOKEN[(r as Fail).code] ?? "Refusé"); setScan(null); setTimeout(reset, 2500); return; }
    soundServed();
    setServed(r.dish);
    setScan(null);
    loadCounters();
    setTimeout(reset, 1300);
  }

  useEffect(() => {
    let stop: (() => void) | undefined;
    let cancelled = false;
    (async () => {
      try {
        const { BrowserQRCodeReader } = await import("@zxing/browser");
        const reader = new BrowserQRCodeReader(undefined, { delayBetweenScanAttempts: 150 });
        const controls = await reader.decodeFromConstraints(
          { video: { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 720 } } },
          video.current!,
          (res) => { if (res && !cancelled) redeem(res.getText()); },
        );
        stop = () => controls.stop();
        if (cancelled) stop();
      } catch {
        setCamErr("Caméra inaccessible. Autorisez la caméra dans le navigateur (HTTPS requis).");
      }
    })();
    return () => { cancelled = true; stop?.(); };
  }, [redeem]);

  async function logout() {
    await supabase().auth.signOut();
    router.replace("/connexion");
  }

  return (
    <main className="no-overscroll fixed inset-0 flex flex-col bg-ink text-white">
      <header className="flex items-center justify-between gap-2 px-4 pb-2 pt-[max(0.8rem,env(safe-area-inset-top))]">
        <div className="flex min-w-0 items-center gap-2"><Logo mark /><div className="min-w-0">
          <p className="text-sm font-extrabold leading-tight">Scanner</p>
          <p className="truncate text-[11px] text-white/60">{agent}{now ? ` · ${now.toLocaleDateString("fr-FR", { weekday: "short", day: "numeric", month: "short", timeZone: "Africa/Abidjan" })} · ${now.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", timeZone: "Africa/Abidjan" }).replace(":", "h")}` : ""}</p>
        </div></div>
        <span className="flex shrink-0 items-center gap-1.5">
          <button onClick={cycleAudio} aria-label={audioMode === "on" ? "Sons et voix activés" : audioMode === "sound" ? "Sons seuls" : "Muet"}
            title={audioMode === "on" ? "Sons + voix" : audioMode === "sound" ? "Sons seuls" : "Muet"}
            className={clsx("grid size-9 place-items-center rounded-full", audioMode === "off" ? "bg-white/10 text-white/50" : "bg-white/10")}>
            {audioMode === "on" ? <Volume2 className="size-4" /> : audioMode === "sound" ? <Volume1 className="size-4" /> : <VolumeX className="size-4" />}
          </button>
          <button onClick={() => { setPlate(true); manualRef.current = true; }} aria-label="Analyser une assiette" title="Assiette rendue : mesurer le gaspillage"
            className="grid size-9 place-items-center rounded-full bg-white/10"><Camera className="size-4" /></button>
          <Link href="/scan/camera" aria-label="Caméra d'affluence" title="Caméra d'affluence (file et places libres)" className="grid size-9 place-items-center rounded-full bg-white/10"><Video className="size-4" /></Link>
          <Link href="/scan/historique" aria-label="Historique des scans" className="grid size-9 place-items-center rounded-full bg-white/10"><History className="size-4" /></Link>
          <Link href="/courses" aria-label="Mes courses" className={clsx("relative grid size-9 place-items-center rounded-full", shopping ? "bg-lime text-ink" : "bg-white/10")}>
            <ShoppingCart className="size-4" />
            {shopping ? <span className="absolute -right-1 -top-1 grid size-5 place-items-center rounded-full bg-err text-[10px] font-extrabold text-white">{shopping}</span> : null}
          </Link>
          {role === "agent"
            ? <button onClick={logout} aria-label="Déconnexion" className="grid size-9 place-items-center rounded-full bg-white/10"><LogOut className="size-4" /></button>
            : <Link href="/app/profil" aria-label="Fermer le scanner" className="grid size-9 place-items-center rounded-full bg-white text-ink"><X className="size-5" /></Link>}
        </span>
      </header>
      <div className="flex gap-1.5 overflow-x-auto px-4 pb-3 [scrollbar-width:none]">
        {SERVICES.map((s) => (
          <button key={s} onClick={() => setService(s)}
            className={clsx("flex h-9 shrink-0 items-center gap-1.5 rounded-full px-3 text-xs font-bold transition", service === s ? "bg-lime text-ink" : "bg-white/10 text-white/70")}>
            <ServiceIcon service={s} className="size-3.5" />{services?.[s].label ?? SERVICE_LABEL[s]}
          </button>
        ))}
      </div>

      <div className="relative mx-4 flex-1 overflow-hidden rounded-[28px] bg-black">
        <video ref={video} className="size-full object-cover" muted playsInline />
        {!camErr && (
          <div className="pointer-events-none absolute inset-0 grid place-items-center">
            <div className="relative size-[68vmin] max-h-[340px] max-w-[340px]">
              {["left-0 top-0 border-l-[6px] border-t-[6px] rounded-tl-3xl", "right-0 top-0 border-r-[6px] border-t-[6px] rounded-tr-3xl",
                "left-0 bottom-0 border-l-[6px] border-b-[6px] rounded-bl-3xl", "right-0 bottom-0 border-r-[6px] border-b-[6px] rounded-br-3xl"].map((c) => (
                <span key={c} className={clsx("absolute size-14 border-lime", c)} />
              ))}
              <span className="absolute inset-x-4 top-1/2 h-0.5 animate-pulse bg-lime/80 shadow-[0_0_16px_#C8F135]" />
            </div>
          </div>
        )}
        {camErr && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-8 text-center">
            <CameraOff className="size-10 text-white/50" /><p className="font-semibold text-white/80">{camErr}</p>
          </div>
        )}
        <p className="absolute inset-x-0 bottom-4 text-center text-sm font-semibold text-white/80">Ticket {SERVICE_LABEL[service]} · placez le QR dans le cadre</p>
      </div>

      <footer className="flex items-center gap-3 px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-4">
        <div className="flex-1 rounded-2xl bg-white/10 px-4 py-3">
          <p className="text-[11px] font-bold uppercase tracking-wider text-white/60">{SERVICE_LABEL[service]} · servis aujourd&apos;hui</p>
          <p className="text-2xl font-extrabold"><span className="text-lime">{counters?.served ?? "–"}</span>
            <span className="text-base font-bold text-white/50"> · {counters?.outstanding ?? "–"} tickets en circulation</span></p>
        </div>
        <button onClick={() => setStaffQ("")} className="flex h-[68px] w-20 shrink-0 flex-col items-center justify-center gap-1 rounded-2xl bg-white/10 text-[11px] font-bold leading-tight" aria-label="Repas du personnel">
          <HardHat className="size-5" />Personnel
        </button>
        <button onClick={() => setManual(true)} className="flex h-[68px] w-20 shrink-0 flex-col items-center justify-center gap-1 rounded-2xl bg-white/10 text-[11px] font-bold leading-tight" aria-label="Client sans téléphone">
          <PhoneOff className="size-5" />Sans<br />téléphone
        </button>
      </footer>

      <PlateScan open={plate} onClose={() => { setPlate(false); manualRef.current = false; }} />

      {staffQ !== null && <StaffSheet initial={staffQ || undefined} onClose={() => setStaffQ(null)} onServed={(msg) => {
        setStaffQ(null); soundOk(); say("Repas du personnel servi"); setServed(msg);
        setTimeout(() => setServed(null), 4000);
      }} />}

      {manual && <NoPhoneSheet service={service} date={date} onClose={() => setManual(false)} onSuccess={(r) => {
        const sc = r as unknown as Scan;
        setManual(false); busy.current = true; soundOk();
        const extras = sc.extras?.length ? `Avec ${sc.extras.map((e) => e.name).join(" et ")}.` : "Sans supplément.";
        say(sc.order ? `${sc.client.split(" ")[0]}. Commande numéro ${sc.order.no}. ${sc.order.dish}.`
          : `${sc.client.split(" ")[0]}. ${sc.ticket} valide. ${extras}`);
        setScan(sc); loadCounters(); loadAlert(sc.ticket_id);
      }} />}

      {/* Ticket validé : choix du plat servi */}
      {scan && (
        <div className="fixed inset-0 z-50 flex flex-col bg-ok" role="dialog" aria-label="Ticket validé">
          <div className="flex items-center gap-4 px-5 pb-4 pt-[max(1.2rem,env(safe-area-inset-top))]">
            <span className="relative shrink-0">
              {scan.user_id ? <Bitmoji avatar={scan.avatar} seed={scan.user_id} mood="laugh" bounce className="size-20 ring-4 ring-white" />
                : <span className="block size-20 animate-pulse rounded-full bg-white/30 ring-4 ring-white" />}
              <span className="animate-pop absolute -bottom-1 -right-1 grid size-8 place-items-center rounded-full bg-white"><Check className="size-5 text-ok" strokeWidth={3} /></span>
            </span>
            <div className="min-w-0">
              <p className="truncate text-2xl font-extrabold">{scan.client}</p>
              <p className="text-lg font-bold opacity-90">{scan.order ? `Commande n° ${scan.order.no}` : `Ticket ${scan.ticket} valide`}</p>
            </div>
          </div>
          {/* Allergies du client : alerte bien visible */}
          {alert && (
            <div className={clsx("mx-5 mb-3 rounded-2xl px-4 py-3 shadow-lg", alert.severe.length || alert.order_risks.some((x) => x.severe.length) ? "bg-err text-white" : "bg-warn text-ink")} role="alert">
              <p className="flex items-center gap-2 text-lg font-extrabold"><AlertTriangle className="size-5 shrink-0" />
                {alert.severe.length ? `Allergie grave : ${alert.severe.join(", ")}` : `Allergie : ${alert.allergies.join(", ") || "—"}`}</p>
              {alert.severe.length > 0 && alert.allergies.length > alert.severe.length &&
                <p className="text-sm font-bold opacity-90">Autres : {alert.allergies.filter((a) => !alert.severe.includes(a)).join(", ")}</p>}
              {alert.diets.length > 0 && <p className="text-sm font-bold opacity-90">Régime : {alert.diets.map((d) => ({ vegetarien: "végétarien", sans_porc: "sans porc", sans_piment: "pas pimenté" }[d] ?? d)).join(", ")}</p>}
              {alert.order_risks.map((x) => (
                <p key={x.dish} className="mt-1 rounded-xl bg-white/90 px-3 py-1.5 text-sm font-extrabold text-err">
                  {x.severe.length ? "⛔ NE PAS REMETTRE sans vérifier : " : "⚠️ "}{x.dish} — {[...x.severe.map((a) => `contient ${a}`), ...x.reasons].join(", ")}
                </p>
              ))}
            </div>
          )}
          {/* Commande : le plat est déjà choisi, l'agent le remet */}
          {scan.order && (
            <div className="mx-5 mb-3 rounded-2xl bg-white px-4 py-3 text-ink shadow-lg">
              <p className="text-xs font-extrabold uppercase tracking-wider text-[#15803d]">Commande · à remettre{scan.order.ready ? " (prête en cuisine)" : ""}</p>
              <p className="text-2xl font-extrabold">{scan.order.dish}</p>
            </div>
          )}
          {/* Supplément : à servir en plus du plat (ou rien) */}
          {scan.extras?.length > 0 ? (
            <div className="mx-5 mb-3 rounded-2xl bg-white px-4 py-3 text-ink shadow-lg">
              <p className="text-xs font-extrabold uppercase tracking-wider text-[#15803d]">Supplément payé · à servir</p>
              {scan.extras.map((e) => (
                <p key={e.id} className="text-xl font-extrabold">+ {e.kind === "starter" ? "Entrée" : e.kind === "dessert" ? "Dessert" : "Extra"} : {e.name}</p>
              ))}
            </div>
          ) : !scan.order && (
            <p className="mx-5 mb-3 rounded-2xl bg-white/15 px-4 py-2.5 text-base font-bold">Sans supplément : plat seul</p>
          )}
          <div className="mx-5 mb-3 flex flex-wrap gap-2 text-sm font-bold">
            {scan.batch_size != null && scan.batch_size > 1 && <span className="rounded-full bg-white/20 px-3 py-1">Acheté avec {scan.batch_size - 1} autre{scan.batch_size > 2 ? "s" : ""} ticket{scan.batch_size > 2 ? "s" : ""}</span>}
            {scan.remaining != null && (
              <span className="rounded-full bg-white/20 px-3 py-1">
                {scan.remaining === 0 ? `Plus aucun ticket ${scan.ticket}` : `Il lui reste ${scan.remaining} ticket${scan.remaining > 1 ? "s" : ""} ${scan.ticket}`}
              </span>
            )}
            {scan.gift_from && <span className="rounded-full bg-white/20 px-3 py-1">🎁 Offert par {scan.gift_from}</span>}
            {scan.guest && <span className="rounded-full bg-white px-3 py-1 text-ink">🎫 Invité {scan.guest.seq}/{scan.guest.guests} · encore {scan.guest.left} à servir</span>}
            {scan.guest && scan.guest.dishes.length > 0 && (
              <span className="rounded-full bg-white/20 px-3 py-1">Prévu : {scan.guest.dishes.map((d) => `${d.qty} ${d.name}`).join(", ")}</span>
            )}
            {scan.is_reward && <span className="rounded-full bg-white/20 px-3 py-1">⭐ Ticket fidélité</span>}
            {scan.method === "pin" && <span className="rounded-full bg-white px-3 py-1 text-ink">🔑 Sans QR · code PIN</span>}
            {scan.secured && <span className="rounded-full bg-white px-3 py-1 text-ink">📵 Anciens QR désactivés</span>}
          </div>
          {scan.order ? <div className="flex-1" /> : <p className="px-5 pb-2 text-sm font-bold uppercase tracking-wider opacity-80">Plat servi</p>}
          <div className={clsx("grid auto-rows-min grid-cols-2 gap-3 overflow-y-auto px-5 pb-4", !scan.order && "flex-1")}>
            {scan.dishes.map((d) => (
              <button key={d.menu_item_id} disabled={!d.available} aria-disabled={!!alert?.dish_risks[d.menu_item_id]?.severe.length}
                onClick={(e) => { if (alert?.dish_risks[d.menu_item_id]?.severe.length) { deny(e.currentTarget); say("Interdit. Allergie grave."); return; } serve(d); }}
                className={clsx("overflow-hidden rounded-3xl bg-white text-left text-ink shadow-lg transition active:scale-95 disabled:opacity-40",
                  alert?.dish_risks[d.menu_item_id] && "ring-4 ring-err")}>
                <DishImage name={d.name} src={d.photo_url} rounded="rounded-none" className="h-24 w-full" />
                <div className="p-3">
                  <p className="text-[15px] font-extrabold leading-tight">{d.name}</p>
                  {alert?.dish_risks[d.menu_item_id]
                    ? <p className="mt-0.5 text-xs font-extrabold text-err">{alert.dish_risks[d.menu_item_id].severe.length ? "⛔ Interdit : allergie grave" : `⚠️ ${alert.dish_risks[d.menu_item_id].reasons.join(", ")}`}</p>
                    : <p className="mt-0.5 text-xs font-semibold text-muted">{!d.available ? "Épuisé" : d.left === null ? "Disponible" : `${d.left} restants`}</p>}
                </div>
              </button>
            ))}
          </div>
          <div className="px-5 pb-[max(1rem,env(safe-area-inset-bottom))]">
            {scan.order
              ? <button onClick={() => { soundServed(); setServed(scan.order!.dish); setScan(null); setTimeout(reset, 1300); }} className="h-14 w-full rounded-full bg-white text-lg font-extrabold text-ok">Commande remise ✓</button>
              : <button onClick={reset} className="h-12 w-full rounded-full bg-white/20 font-bold">Plat non précisé</button>}
          </div>
        </div>
      )}

      {/* Servi / refusé : couleur franche (lisible de loin) + le chef au centre avec une bulle */}
      {served && (
        <ChefPopup scene="ready" backdrop="bg-ok" message={<span className="flex items-center justify-center gap-2 text-3xl text-ok"><Check className="size-8" strokeWidth={3} />Servi</span>}
          sub={<p className="text-xl font-extrabold text-ink">{served}</p>} />
      )}

      {fail && (
        <ChefPopup scene="denied"
          backdrop={fail.code === "ALREADY_USED" ? "bg-[repeating-linear-gradient(135deg,#b91c1c_0_28px,#16181d_28px_56px)]" : "bg-err"}
          message={<span className="animate-shake flex items-center justify-center gap-2 text-3xl uppercase text-err"><X className="size-8" strokeWidth={3} />{fail.code === "ALREADY_USED" ? "Déjà utilisé" : "Refusé"}</span>}
          sub={<p className="text-lg font-bold text-ink">{fail.message}</p>} />
      )}
    </main>
  );
}
