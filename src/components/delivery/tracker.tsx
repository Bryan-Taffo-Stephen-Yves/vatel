"use client";
import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { Phone, Bike, Check, X, Clock, MapPin, Send } from "lucide-react";
import "leaflet/dist/leaflet.css";
import type * as Leaflet from "leaflet";
import { rpc, supabase } from "@/lib/supabase/client";
import { fcfa, time } from "@/lib/format";

type Item = { id: string; label: string; qty: number; emoji: string; status: "a_acheter" | "achete" | "annule"; price: number };
type Stop = { id: string; seq: number; name: string; district: string | null; phone: string | null; lat: number; lng: number; status: "a_faire" | "en_cours" | "fait" | "annule"; items: Item[] };
export type Track = {
  run: { id: string; title: string; status: string; mode: string; courier_name: string | null; courier_phone: string | null; vehicle: string | null;
    eta_at: string | null; started_at: string | null; delivered_at: string | null; target_stop: string | null; position: [number, number] | null };
  canteen: { name: string; address: string; lat: number; lng: number };
  route: { coords: [number, number][]; idx: number } | null;
  stops: Stop[];
  events: { id: number; at: string; kind: string; message: string; author: string | null }[];
};

export const STATUS: Record<string, string> = {
  prete: "Prête au départ", en_route: "En route vers un fournisseur", achats: "En train d'acheter",
  vers_cantine: "Achats finis · en route vers la cantine", livre: "Livré à la cantine", receptionne: "Réceptionné", annule: "Annulée",
};
const fmtQty = (n: number) => Number(n).toLocaleString("fr-FR", { maximumFractionDigits: 2 });
const pin = (html: string, cls: string) => ({ html: `<div class="${cls}">${html}</div>`, className: "", iconSize: [34, 34] as [number, number], iconAnchor: [17, 17] as [number, number] });

/** Suivi en direct d'une tournée d'achats : carte, heure d'arrivée, arrêts et articles, fil des étapes. */
export function DeliveryTracker({ token, runId, teamBox = false, onData }: { token: string; runId?: string; teamBox?: boolean; onData?: (t: Track) => void }) {
  const [t, setT] = useState<Track | null | undefined>(undefined);
  const [now, setNow] = useState(() => Date.now());
  const [msg, setMsg] = useState("");
  const [sending, setSending] = useState(false);
  const mapEl = useRef<HTMLDivElement>(null);
  const map = useRef<{ L: typeof Leaflet; m: Leaflet.Map; done: Leaflet.Polyline; todo: Leaflet.Polyline; courier: Leaflet.Marker; stops: Leaflet.LayerGroup; fitted: boolean } | null>(null);

  // Données toutes les 4 s (la simulation avance toutes les 10 s)
  useEffect(() => {
    let alive = true;
    const load = () => rpc<Track>("delivery_track", { p_token: token }).then((r) => {
      if (!alive) return;
      if (!r.ok) { setT(null); return; }
      setT(r as unknown as Track); onData?.(r as unknown as Track);
    });
    load();
    const a = setInterval(load, 4000), b = setInterval(() => setNow(Date.now()), 15000);
    return () => { alive = false; clearInterval(a); clearInterval(b); };
  }, [token, onData]);

  // Carte (Leaflet + OpenStreetMap), créée une fois puis mise à jour
  useEffect(() => {
    if (!t || !mapEl.current) return;
    let cancelled = false;
    (async () => {
      if (!map.current) {
        const L = (await import("leaflet")).default;
        if (cancelled || !mapEl.current) return;
        const m = L.map(mapEl.current, { zoomControl: true, attributionControl: true }).setView([t.canteen.lat, t.canteen.lng], 13);
        L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "© OpenStreetMap" }).addTo(m);
        const done = L.polyline([], { color: "#9aa1ad", weight: 5, opacity: 0.8 }).addTo(m);
        const todo = L.polyline([], { color: "#16181d", weight: 5, opacity: 0.9, dashArray: "1 8", lineCap: "round" }).addTo(m);
        const stops = L.layerGroup().addTo(m);
        L.marker([t.canteen.lat, t.canteen.lng], { icon: L.divIcon(pin("🍽️", "dl-pin dl-home")) }).addTo(m).bindTooltip(t.canteen.name);
        const courier = L.marker([t.canteen.lat, t.canteen.lng], { icon: L.divIcon(pin("🛵", "dl-pin dl-courier")), zIndexOffset: 1000 }).addTo(m);
        map.current = { L, m, done, todo, courier, stops, fitted: false };
      }
      const { L, m, done, todo, courier, stops } = map.current;
      const coords = t.route?.coords ?? [];
      const idx = t.route?.idx ?? 0;
      done.setLatLngs(coords.slice(0, idx + 1));
      todo.setLatLngs(coords.slice(idx));
      const pos = t.run.position ?? coords[0] ?? [t.canteen.lat, t.canteen.lng];
      courier.setLatLng(pos as [number, number]);
      stops.clearLayers();
      t.stops.forEach((s) => {
        const icon = s.status === "fait" ? "✓" : s.status === "annule" ? "✕" : String(s.seq);
        L.marker([s.lat, s.lng], { icon: L.divIcon(pin(icon, `dl-pin dl-stop dl-${s.status}`)) }).addTo(stops).bindTooltip(s.name);
      });
      if (!map.current.fitted) {
        const pts: [number, number][] = [...coords, ...t.stops.map((s) => [s.lat, s.lng] as [number, number]), [t.canteen.lat, t.canteen.lng]];
        if (pts.length > 1) m.fitBounds(L.latLngBounds(pts), { padding: [30, 30] });
        map.current.fitted = true;
      }
    })();
    return () => { cancelled = true; };
  }, [t]);

  useEffect(() => () => { map.current?.m.remove(); map.current = null; }, []);

  async function send() {
    if (!msg.trim() || !runId) return;
    setSending(true);
    await supabase().functions.invoke("delivery", { body: { action: "message", run_id: runId, text: msg } });
    setSending(false); setMsg("");
  }

  if (t === undefined) return <div className="h-80 animate-pulse rounded-[24px] bg-card" />;
  if (t === null) return <p className="rounded-[24px] border-2 border-dashed border-line p-8 text-center font-bold">Suivi introuvable ou lien expiré.</p>;

  const r = t.run;
  const mins = r.eta_at ? Math.max(0, Math.round((new Date(r.eta_at).getTime() - now) / 60000)) : null;
  const moving = ["en_route", "achats", "vers_cantine"].includes(r.status);
  const items = t.stops.flatMap((s) => s.items);
  const bought = items.filter((i) => i.status === "achete");
  const live = items.filter((i) => i.status !== "annule");

  return (
    <div className="space-y-4">
      <style>{`
        .dl-pin{display:grid;place-items:center;width:34px;height:34px;border-radius:999px;font-weight:800;font-size:15px;box-shadow:0 2px 8px rgba(0,0,0,.25);border:2px solid #fff}
        .dl-courier{background:#53b5fd;font-size:18px}.dl-home{background:#16181d;font-size:16px}
        .dl-stop{background:#fff;color:#16181d}.dl-en_cours{background:#f59e0b;color:#fff}.dl-fait{background:#22c55e;color:#fff}.dl-annule{background:#e7e9ee;color:#858b97;text-decoration:line-through}
      `}</style>

      <div className="overflow-hidden rounded-[24px] bg-ink text-white">
        <div className="flex flex-wrap items-center gap-3 px-5 py-4">
          <span className="grid size-11 place-items-center rounded-2xl bg-lime text-ink"><Bike className="size-6" /></span>
          <div className="min-w-0 flex-1">
            <p className="text-xs font-bold uppercase tracking-wider text-lime">{STATUS[r.status] ?? r.status}{r.mode === "simulation" && " · simulation"}</p>
            <p className="text-lg font-extrabold leading-tight">
              {r.status === "livre" || r.status === "receptionne" ? `Livré à ${r.delivered_at ? time(r.delivered_at) : "—"}`
                : moving && r.eta_at ? `Arrivée vers ${time(r.eta_at)} · dans ${mins} min` : r.title}
            </p>
          </div>
          {r.courier_phone && (
            <a href={`tel:${r.courier_phone}`} className="flex w-full items-center justify-center gap-2 rounded-full bg-lime px-4 py-2.5 text-sm font-extrabold text-ink sm:w-auto">
              <Phone className="size-4" />Appeler le coursier
            </a>
          )}
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-1 border-t border-white/10 px-5 py-3 text-sm text-white/80">
          <span>🛵 {r.courier_name ?? "Coursier"}{r.vehicle && ` · ${r.vehicle}`}</span>
          <span>🛒 {bought.length}/{live.length} articles achetés</span>
          <span>💰 {fcfa(bought.reduce((s, i) => s + i.price, 0))} dépensés</span>
        </div>
      </div>

      <div ref={mapEl} className="h-[340px] w-full overflow-hidden rounded-[24px] border border-line sm:h-[420px]" style={{ zIndex: 0 }} />

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-[24px] bg-card p-4 shadow-[var(--shadow-card)]">
          <p className="mb-3 text-xs font-extrabold uppercase tracking-wider text-muted">Arrêts et achats</p>
          <ol className="space-y-3">
            {t.stops.map((s) => (
              <li key={s.id} className={clsx("rounded-2xl border p-3", s.status === "en_cours" ? "border-warn bg-warn-soft" : "border-line", s.status === "annule" && "opacity-60")}>
                <div className="flex items-center gap-2">
                  <span className={clsx("grid size-7 shrink-0 place-items-center rounded-full text-xs font-extrabold",
                    s.status === "fait" ? "bg-ok text-white" : s.status === "en_cours" ? "bg-warn text-white" : s.status === "annule" ? "bg-line text-off" : "bg-canvas")}>
                    {s.status === "fait" ? <Check className="size-4" /> : s.status === "annule" ? <X className="size-4" /> : s.seq}
                  </span>
                  <p className={clsx("flex-1 font-extrabold", s.status === "annule" && "line-through")}>{s.name}</p>
                  {s.district && <span className="flex items-center gap-1 text-xs text-muted"><MapPin className="size-3" />{s.district}</span>}
                </div>
                <ul className="mt-2 space-y-1 pl-9">
                  {s.items.map((i) => (
                    <li key={i.id} className={clsx("flex items-center justify-between gap-2 text-sm", i.status === "annule" && "text-off line-through", i.status === "achete" && "font-bold")}>
                      <span>{i.status === "achete" ? "✅" : i.status === "annule" ? "❌" : "⬜"} {i.emoji} {fmtQty(i.qty)} {i.label}</span>
                      {i.price > 0 && i.status !== "annule" && <span className="text-xs text-muted">{fcfa(i.price)}</span>}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
            <li className="flex items-center gap-2 rounded-2xl border border-line p-3">
              <span className="grid size-7 place-items-center rounded-full bg-ink text-xs">🍽️</span>
              <p className="flex-1 font-extrabold">{t.canteen.name}</p>
              {r.eta_at && moving && <span className="flex items-center gap-1 text-xs font-bold"><Clock className="size-3" />{time(r.eta_at)}</span>}
            </li>
          </ol>
        </div>

        <div className="rounded-[24px] bg-card p-4 shadow-[var(--shadow-card)]">
          <p className="mb-3 text-xs font-extrabold uppercase tracking-wider text-muted">En direct</p>
          {teamBox && runId && (
            <form onSubmit={(e) => { e.preventDefault(); send(); }} className="mb-3 flex gap-2">
              <input value={msg} onChange={(e) => setMsg(e.target.value)} maxLength={500} placeholder="Ex. laisse tomber les tomates"
                className="h-11 min-w-0 flex-1 rounded-full border border-line bg-canvas px-4 text-sm outline-none focus:border-ink" aria-label="Message à Jean" />
              <button disabled={sending || !msg.trim()} className="grid size-11 place-items-center rounded-full bg-lime disabled:opacity-40" aria-label="Envoyer">
                <Send className={clsx("size-4", sending && "animate-pulse")} />
              </button>
            </form>
          )}
          <ul className="max-h-[420px] space-y-2 overflow-y-auto">
            {t.events.map((e) => (
              <li key={e.id} className={clsx("rounded-2xl px-3 py-2 text-sm", e.kind === "jean" ? "bg-lime-soft" : e.kind.startsWith("equipe") ? "bg-canvas" : e.kind === "changement" ? "bg-err-soft" : "bg-card border border-line")}>
                <p className="whitespace-pre-line">{e.message}</p>
                <p className="mt-0.5 text-[11px] text-muted">{time(e.at)}</p>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
