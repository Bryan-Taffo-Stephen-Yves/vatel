"use client";
import { ChefPopup, type ChefScene } from "@/components/chef";
import { sfx } from "@/lib/sfx";
import Link from "next/link";
import { use, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import clsx from "clsx";
import { Check, ChevronLeft, Sun, Star, XCircle } from "lucide-react";
import { rpc, supabase } from "@/lib/supabase/client";
import { Qr } from "@/components/qr";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { useAppData } from "@/components/app/app-data";
import { ServiceBadge } from "@/components/app/service-icon";
import { cachedTicket, cachedToken, displayStatus, isOrder, orderDish, orderStep, PREP_STEPS, STATUS_META, syncTokens } from "@/lib/tickets";
import { SERVICE_LABEL, duration, fcfa, relativeDay, shortDateTime, time } from "@/lib/format";
import { TICKET_COLUMNS, type Ticket } from "@/lib/types";
import { useLang, useT } from "@/lib/i18n";

export default function TicketPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const toast = useToast();
  const tr = useT();
  const lang = useLang();
  const en = lang === "en";
  const { balance, profile, refresh } = useAppData();
  const [t, setT] = useState<Ticket | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [offline, setOffline] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [deadline, setDeadline] = useState<string | null>(null);
  useEffect(() => {
    supabase().rpc("ticket_cancel_deadline", { p_ticket_id: id }).then(({ data }) => { if (typeof data === "string") setDeadline(data); }, () => {});
  }, [id]);
  const [justScanned, setJustScanned] = useState(false);
  const [cancelled, setCancelled] = useState<string | null>(null); // écran « commande annulée » avant de repartir
  const last = useRef<string | undefined>(undefined);
  const lastPrep = useRef<string | null | undefined>(undefined);
  const [pop, setPop] = useState<ChefScene | null>(null); // mascotte au centre quand la commande change d'étape

  useEffect(() => {
    // 1) cache local : affichage immédiat, y compris en mode avion
    const c = cachedTicket(id);
    if (c) { setT(c); last.current = c.status; }
    setToken(cachedToken(id));
    setOffline(!navigator.onLine);

    // 2) réseau
    const sb = supabase();
    const load = async () => {
      const { data } = await sb.from("tickets").select(TICKET_COLUMNS).eq("id", id).single();
      if (!data) return;
      const nt = data as unknown as Ticket;
      if (last.current === "valid" && nt.status === "used") { setJustScanned(true); sfx.served(); refresh(); }
      // la cuisine avance : petit son à chaque étape, cloche « ding-ding » quand c'est prêt
      else if (lastPrep.current && lastPrep.current !== "ready" && nt.prep_status === "ready") sfx.ready();
      else if (lastPrep.current === "received" && nt.prep_status === "preparing") sfx.preparing();
      // Mascotte : à chaque nouvelle étape, et une fois à la première ouverture de l'étape en cours
      if (isOrder(nt) && nt.status === "valid") {
        const sc = chefScene(nt.status, nt.prep_status);
        const seenKey = `dabali:chef:${id}`;
        let seen: string | null = null;
        try { seen = localStorage.getItem(seenKey); } catch {}
        if (seen !== sc && (lastPrep.current === undefined || lastPrep.current !== nt.prep_status)) {
          setPop(sc);
          try { localStorage.setItem(seenKey, sc); } catch {}
        }
      }
      last.current = nt.status;
      lastPrep.current = nt.prep_status;
      setT(nt);
    };
    load();
    syncTokens().then(() => setToken(cachedToken(id)));

    // 3) passage au vert en direct (temps réel + filet de sécurité toutes les 4 s : le plat arrive juste après le scan)
    const ch = sb.channel(`ticket-${id}`)
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "tickets", filter: `id=eq.${id}` }, () => load())
      .subscribe();
    const poll = setInterval(() => { if (navigator.onLine && !document.hidden) load(); }, 4000);
    const tick = setInterval(() => setNow(Date.now()), 15_000);
    const on = () => setOffline(false), off = () => setOffline(true);
    window.addEventListener("online", on); window.addEventListener("offline", off);

    // écran allumé tant que le QR est affiché
    let lock: { release: () => Promise<void> } | null = null;
    (navigator as Navigator & { wakeLock?: { request: (t: "screen") => Promise<{ release: () => Promise<void> }> } })
      .wakeLock?.request("screen").then((l) => (lock = l)).catch(() => {});

    return () => {
      sb.removeChannel(ch); clearInterval(poll); clearInterval(tick);
      window.removeEventListener("online", on); window.removeEventListener("offline", off);
      lock?.release().catch(() => {});
    };
  }, [id, refresh]);

  if (!t) return <main className="p-4"><div className="mx-auto mt-16 h-[520px] animate-pulse rounded-[32px] bg-card" /></main>;

  const st = displayStatus(t, now);
  const label = SERVICE_LABEL[t.service];
  const ends = new Date(t.valid_until).getTime();
  const step = st === "used" ? 3 : 2;
  const order = isOrder(t);
  const dish = order ? orderDish(t) : null;
  const ostep = orderStep(t);
  const steps: readonly string[] = (order ? PREP_STEPS : ["Acheté", "Valide", "Utilisé"]).map((s) => tr(s));
  const cur = order ? ostep + 1 : step;
  const allDone = order ? ostep === 3 : step === 3;

  // Commande : remboursée avant l'heure limite ; après, annulation possible mais sans remboursement (confirmée)
  const late = order && deadline ? now > new Date(deadline).getTime() : false;
  async function cancel() {
    if (!late && !confirm(en
      ? (order ? `Cancel order no. ${t!.order_no}? ${fcfa(t!.total)} will be refunded to your balance.`
        : `Cancel this ${label} ticket? ${t!.total > 0 ? fcfa(t!.total) + " will be refunded to your balance." : ""}`)
      : (order ? `Annuler la commande n° ${t!.order_no} ? ${fcfa(t!.total)} seront remboursés sur votre solde.`
        : `Annuler ce ticket ${label} ? ${t!.total > 0 ? fcfa(t!.total) + " seront remboursés sur votre solde." : ""}`))) return;
    let r = await rpc<{ refunded: number; no_refund?: boolean }>("cancel_ticket", { p_ticket_id: id });
    if (!r.ok && r.code === "NO_REFUND_CONFIRM") {
      if (!confirm(en ? "The cancellation deadline has passed: you can still cancel, but you won't be refunded. Cancel anyway?" : r.message)) return;
      r = await rpc<{ refunded: number; no_refund?: boolean }>("cancel_ticket", { p_ticket_id: id, p_no_refund: true });
    }
    if (!r.ok) return toast("err", r.message);
    const msg = r.no_refund ? tr("Commande annulée, sans remboursement.")
      : r.refunded > 0 ? (en ? `${fcfa(r.refunded)} refunded to your balance.` : `${fcfa(r.refunded)} remboursés sur votre solde.`) : tr("Ticket annulé, points rendus.");
    refresh();
    // Le chef annonce l'annulation au centre de l'écran, puis retour à la liste
    sfx.cancel();
    setCancelled(msg);
    setTimeout(() => router.replace("/app/tickets"), 2200);
  }

  return (
    <main className="no-overscroll px-4 pb-6 pt-[max(0.9rem,env(safe-area-inset-top))]">
      <header className="flex items-center justify-between">
        <button onClick={() => router.push("/app/tickets")} aria-label={tr("Retour")} className="grid size-11 place-items-center rounded-full bg-card shadow-[var(--shadow-card)]">
          <ChevronLeft className="size-5" />
        </button>
        <h1 className="text-[17px] font-extrabold">{order ? tr("Ma commande") : tr("Mon ticket")}</h1>
        <span className={clsx("rounded-full px-3 py-1 text-xs font-extrabold", STATUS_META[st].chip)}>{tr(STATUS_META[st].label)}</span>
      </header>

      {/* Hors ligne : bandeau commun en haut de l'appli (« vos QR marchent ») */}


      {/* Talon */}
      <section className="relative mt-4 drop-shadow-[0_10px_30px_rgba(22,24,29,0.10)]">
        <div className="rounded-t-[30px] bg-card px-6 pb-6 pt-6">
          <div className="relative mx-auto w-full max-w-[290px]">
            {/* Cadre qui tourne + horloge à la seconde : une capture d'écran se repère tout de suite */}
            <div className={clsx("rounded-[22px] p-[4px]", st === "valid" && token ? "qr-live" : "bg-transparent")}>
              <Qr value={st === "valid" ? token : null} className={clsx("rounded-[18px] bg-white p-3 ring-1 ring-line transition", st !== "valid" && "opacity-20 blur-[3px]")} />
            </div>
            {st !== "valid" && (
              <div className="absolute inset-0 grid place-items-center">
                <span className={clsx("grid size-20 place-items-center rounded-full", st === "used" ? "bg-ok text-white" : "bg-err text-white")}>
                  {st === "used" ? <Check className="size-10" strokeWidth={3} /> : <XCircle className="size-10" />}
                </span>
              </div>
            )}
            {st === "valid" && !token && (
              <p className="absolute inset-x-0 -bottom-5 text-center text-xs font-semibold text-muted">{offline ? tr("QR non disponible hors ligne") : tr("Génération du QR…")}</p>
            )}
          </div>
          {st === "valid" && token && <LiveClock />}
          <p className="mt-6 text-center text-sm font-semibold text-muted">
            {order ? (st === "valid" ? (en ? `Show this code at the counter from ${time(t.pickup_at!)}` : `Présentez ce code au comptoir à partir de ${time(t.pickup_at!)}`)
                : st === "used" ? (en ? `Picked up on ${shortDateTime(t.used_at!)}` : `Récupérée le ${shortDateTime(t.used_at!)}`)
                : st === "expired" ? tr("Non récupérée à temps : le plat est perdu") : tr("Commande annulée et remboursée"))
              : st === "valid" ? tr("Présentez ce code au comptoir, choisissez votre plat")
              : st === "used" ? (en ? `Used on ${shortDateTime(t.used_at!)}` : `Utilisé le ${shortDateTime(t.used_at!)}`)
              : st === "expired" ? (t.total > 0 ? tr("Non utilisé : remboursé sur ton solde") : tr("Non utilisé : tes points t'ont été rendus")) : tr("Ticket annulé et remboursé")}
          </p>
        </div>

        <div className="relative h-6 bg-card">
          <span className="absolute -left-3 top-0 size-6 rounded-full bg-canvas" />
          <span className="absolute -right-3 top-0 size-6 rounded-full bg-canvas" />
          <span className="absolute inset-x-6 top-1/2 border-t-2 border-dashed border-line" />
        </div>

        <div className="rounded-b-[30px] bg-card px-6 pb-6 pt-3 text-center">
          <div className="flex items-center justify-center gap-3">
            <ServiceBadge service={t.service} size="size-11" />
            <h2 className="text-[22px] font-extrabold leading-tight">{order ? (en ? `Order no. ${t.order_no}` : `Commande n° ${t.order_no}`) : <>Ticket {label}{t.is_reward && " 🎁"}</>}</h2>
          </div>
          {order && <p className="mt-2 text-lg font-extrabold text-ink-2">{dish?.name}</p>}
          {t.gift_from && <p className="mx-auto mt-2 w-fit rounded-full bg-lime-soft px-3 py-1 text-sm font-bold text-lime-deep">🎁 {tr("Offert par")} {t.gift_from}</p>}
          {st === "used" && t.dish && <p className="mt-2 text-sm font-bold text-ink-2">{tr("Servi :")} {t.dish.name}</p>}
          {st === "used" && t.dish && (
            <Link href={`/app/avis/${t.id}`} className="mx-auto mt-3 flex w-fit items-center gap-1.5 rounded-full bg-ink px-4 py-2 text-sm font-bold text-white">
              <Star className="size-4 fill-warn text-warn" />{tr("Mon avis sur ce plat")}
            </Link>
          )}
          {t.extras.length > 0 && (
            <div className="mt-3 flex flex-wrap justify-center gap-1.5">
              {t.extras.map((e) => <span key={e.id} className="rounded-full bg-canvas px-2.5 py-1 text-xs font-bold">+ {e.name}</span>)}
            </div>
          )}
          {order && st === "valid" && (
            t.prep_status === "ready"
              ? <p className="mx-auto mt-4 w-fit rounded-2xl bg-lime px-5 py-3 text-xl font-extrabold">{tr("Prête ! Passe la prendre 🍽️")}</p>
              : <p className="mt-4 text-[26px] font-extrabold tracking-tight text-lime-deep">
                  <span className="text-base font-bold text-muted">{en ? `pickup ${relativeDay(t.pickup_at!.slice(0, 10)).toLowerCase()} at ` : `retrait ${relativeDay(t.pickup_at!.slice(0, 10)).toLowerCase()} à `}</span>{time(t.pickup_at!)}
                </p>
          )}
          {order && st === "valid" && <p className="text-xs font-semibold text-muted">{en ? `pick up before ${time(t.valid_until)}, or the dish is lost` : `à récupérer avant ${time(t.valid_until)}, sinon le plat est perdu`}</p>}
          {!order && st === "valid" && (
            <>
              <p className="mt-4 text-[30px] font-extrabold tracking-tight text-lime-deep">
                <span className="text-base font-bold text-muted">{tr("valable encore")} </span>{duration(ends - now)}
              </p>
              <p className="text-xs font-semibold text-muted">{en ? "until" : "jusqu'au"} {shortDateTime(t.valid_until)}</p>
            </>
          )}

          <ol className="mt-5 flex items-center">
            {steps.map((s, i) => (
              <li key={s} className="flex flex-1 items-center">
                <div className="flex flex-col items-center gap-1">
                  <span className={clsx("grid size-7 place-items-center rounded-full text-xs font-extrabold transition",
                    i + 1 < cur || allDone ? "bg-ink text-lime" : i + 1 === cur ? "bg-lime text-ink ring-4 ring-lime-soft" : "bg-canvas text-off")}>
                    {i + 1 < cur || allDone ? <Check className="size-4" strokeWidth={3} /> : i + 1}
                  </span>
                  <span className={clsx("whitespace-nowrap text-[11px] font-bold", i + 1 <= cur ? "text-ink" : "text-off")}>{s}</span>
                </div>
                {i < steps.length - 1 && <span className={clsx("mx-1 mb-5 h-0.5 flex-1 rounded", i + 1 < cur ? "bg-ink" : "bg-line")} />}
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* Solde (points de fidélité retirés) */}
      <section className="mt-4 flex items-center justify-between rounded-[24px] bg-card p-4 shadow-[var(--shadow-card)]">
        <p className="text-sm font-bold text-muted">{tr("Solde")}</p>
        <p className="text-xl font-extrabold">{balance === null ? "—" : fcfa(balance)}</p>
      </section>

      {st === "valid" && (
        <>
          <p className="mt-4 flex items-center justify-center gap-2 text-xs font-semibold text-muted">
            <Sun className="size-4" /> {tr("Montez la luminosité pour un scan instantané")}
          </p>
          {order && deadline && (
            <p className={clsx("mt-3 text-center text-[13px] font-semibold", late ? "text-err" : "text-muted")}>
              {late
                ? (en ? `Refund deadline passed (${time(deadline)}): cancelling is still possible, without a refund.` : `Heure limite passée (${time(deadline)}) : annulation possible, sans remboursement.`)
                : (en ? `Refunded if cancelled before ${time(deadline)}.` : `Annulation remboursée jusqu'à ${time(deadline)}.`)}
            </p>
          )}
          {(!order || t.prep_status === "received" || late) && (
            <Button variant="ghost" block className="mt-2 text-err" onClick={cancel}>
              {order ? (late ? tr("Annuler sans remboursement") : tr("Annuler la commande (remboursée)")) : tr("Annuler et me faire rembourser")}
            </Button>
          )}
        </>
      )}

      {/* La cuisine te parle : une cuisinière différente à chaque étape, au centre, avec une bulle */}
      {pop && !justScanned && !cancelled && <ChefPopup scene={pop} autoClose={pop === "ready" ? 6000 : 3500} onClose={() => setPop(null)}
        sub={pop === "ready" ? (en ? `Order no. ${t.order_no} · ${dish?.name ?? ""}` : `Commande n° ${t.order_no} · ${dish?.name ?? ""}`) : undefined} />}

      {cancelled && <ChefPopup scene="cancelled" message={order ? tr("Commande annulée") : tr("Ticket annulé")} sub={cancelled} />}

      {justScanned && <ScannedOverlay ticket={t} avatar={profile?.avatar} seed={profile?.id} onClose={() => setJustScanned(false)} />}
    </main>
  );
}

function ScannedOverlay({ ticket, onClose }: { ticket: Ticket; onClose: () => void; avatar?: string | null; seed?: string }) {
  const tr = useT();
  const lang = useLang();
  const dish = orderDish(ticket);
  return (
    <ChefPopup scene="done" onClose={onClose} backdrop="bg-ok/80 backdrop-blur-[3px]" message={tr("Bon appétit !")}
      sub={<>
        <p className="font-extrabold text-ink">{dish ? dish.name : (lang === "en" ? `${SERVICE_LABEL[ticket.service]} ticket validated` : `Ticket ${SERVICE_LABEL[ticket.service]} validé`)}</p>
        <p className="mt-1 text-xs">{tr("On te demandera ton avis dans 15 min, après le repas.")}</p>
      </>} />
  );
}

/** Étape de la commande → personnage à afficher */
function chefScene(st: string, prep: Ticket["prep_status"]): ChefScene {
  if (st === "used") return "done";
  if (st === "cancelled") return "cancelled";
  if (st === "expired") return "expired";
  return prep === "ready" ? "ready" : prep === "preparing" ? "preparing" : "received";
}

/** Heure à la seconde sous le QR : prouve à l'agent que l'écran est vivant (pas une capture) */
function LiveClock() {
  const lang = useLang();
  const [t, setT] = useState<string | null>(null);
  useEffect(() => {
    const f = () => setT(new Date().toLocaleTimeString(lang === "en" ? "en-GB" : "fr-FR", { hour: "2-digit", minute: "2-digit", second: "2-digit", timeZone: "Africa/Abidjan" }));
    f();
    const id = setInterval(f, 1000);
    return () => clearInterval(id);
  }, [lang]);
  return (
    <p className="mt-3 flex items-center justify-center gap-2 font-mono text-sm font-bold tabular-nums text-ink-2">
      <span className="size-2 animate-pulse rounded-full bg-ok" />{t ?? "--:--:--"}
    </p>
  );
}
