// Itinéraire routier pour la tournée du coursier : OSRM (OpenStreetMap, gratuit, sans clé), sinon ligne droite.
// Renvoie les points [lat, lng], le temps cumulé (s) à chaque point, et l'indice d'arrivée à chaque étape.
import { adminClient } from "./http.ts";

type P = { lat: number; lng: number };
export type Route = { coords: [number, number][]; cum: number[]; source: "osrm" | "ligne"; legEnds: number[] };

const hav = (a: P, b: P) => {
  const R = 6371e3, t = Math.PI / 180, dLat = (b.lat - a.lat) * t, dLng = (b.lng - a.lng) * t;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * t) * Math.cos(b.lat * t) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};

export async function computeRoute(points: P[]): Promise<Route> {
  try {
    const path = points.map((p) => `${p.lng},${p.lat}`).join(";");
    const r = await fetch(`https://router.project-osrm.org/route/v1/driving/${path}?overview=full&geometries=geojson&annotations=duration`,
      { headers: { "User-Agent": "dabali-cantine/1.0" }, signal: AbortSignal.timeout(8000) });
    if (r.ok) {
      const j = await r.json();
      const route = j.routes?.[0];
      if (route?.geometry?.coordinates?.length > 1) {
        const coords = (route.geometry.coordinates as [number, number][]).map(([lng, lat]) => [Number(lat.toFixed(6)), Number(lng.toFixed(6))] as [number, number]);
        // Durées par segment, leg par leg (moto en ville : ×1,25 par rapport à la voiture d'OSRM, embouteillages)
        const durs: number[] = [];
        const legEnds: number[] = [];
        for (const leg of route.legs) { for (const d of leg.annotation?.duration ?? []) durs.push(d * 1.25); legEnds.push(durs.length); }
        if (durs.length === coords.length - 1) {
          const cum = [0];
          for (const d of durs) cum.push(Math.round(cum[cum.length - 1] + d));
          return { coords, cum, source: "osrm", legEnds };
        }
      }
    }
  } catch (e) { console.error("osrm", e); }
  // Repli : ligne droite, 20 points par étape, 18 km/h de moyenne (circulation d'Abidjan)
  const coords: [number, number][] = []; const cum: number[] = []; const legEnds: number[] = [];
  for (let k = 0; k < points.length - 1; k++) {
    const a = points[k], b = points[k + 1], dist = hav(a, b);
    for (let s = k === 0 ? 0 : 1; s <= 20; s++) {
      const f = s / 20;
      coords.push([Number((a.lat + (b.lat - a.lat) * f).toFixed(6)), Number((a.lng + (b.lng - a.lng) * f).toFixed(6))]);
      cum.push(Math.round((cum.length ? cum[cum.length - 1] : 0) + (s === 0 ? 0 : (dist / 20) / 5)));
    }
    legEnds.push(coords.length - 1);
  }
  return { coords, cum, source: "ligne", legEnds };
}

/** (Re)calcule l'itinéraire d'une tournée depuis la position actuelle du coursier, par les arrêts restants, jusqu'à la cantine. */
export async function planRoute(runId: string): Promise<{ ok: boolean; message?: string }> {
  const db = adminClient();
  const [{ data: run }, { data: stops }, { data: cfg }] = await Promise.all([
    db.from("delivery_runs").select("id, status, route, route_idx, target_stop").eq("id", runId).single(),
    db.from("delivery_stops").select("id, seq, lat, lng, status").eq("run_id", runId).order("seq"),
    db.from("settings").select("value").eq("key", "delivery").single(),
  ]);
  if (!run) return { ok: false, message: "Tournée introuvable." };
  const c = cfg?.value as any;
  const here: P = run.route ? { lat: run.route.coords[run.route_idx][0], lng: run.route.coords[run.route_idx][1] } : { lat: c.courier_start.lat, lng: c.courier_start.lng };
  const todo = (stops ?? []).filter((s: any) => s.status === "a_faire");
  const atStop = (stops ?? []).find((s: any) => s.status === "en_cours");
  const pts: P[] = [here, ...todo.map((s: any) => ({ lat: Number(s.lat), lng: Number(s.lng) })), { lat: c.canteen.lat, lng: c.canteen.lng }];
  const route = await computeRoute(pts);
  const stopIdx: Record<string, number> = {};
  todo.forEach((s: any, k: number) => { stopIdx[s.id] = route.legEnds[k]; });
  if (atStop) stopIdx[atStop.id] = 0;
  const { error } = await db.rpc("_delivery_set_route", { p_run: runId, p_route: { coords: route.coords, cum: route.cum, source: route.source }, p_stop_idx: stopIdx });
  return error ? { ok: false, message: error.message } : { ok: true };
}
