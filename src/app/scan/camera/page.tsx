"use client";
// Caméra d'affluence sur téléphone : le téléphone filme la salle, repère les personnes LUI-MÊME (modèle de détection
// embarqué, rien n'est envoyé ailleurs), compte la file d'attente et les places libres par table, et n'envoie que des
// NOMBRES à Vatel toutes les 10 s. Aucune image n'est enregistrée ni transmise, pas de reconnaissance de visage.
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import clsx from "clsx";
import { X, Play, Square, Pencil, Check, Trash2, Minus, Plus, ShieldCheck, Video, Monitor } from "lucide-react";
import { rpc } from "@/lib/supabase/client";

type Kind = "table" | "queue";
type Zone = { id: string; kind: Kind; seats: number; x: number; y: number; w: number; h: number }; // coordonnées 0..1 de l'image
type Box = { x: number; y: number; w: number; h: number };                                          // idem
type TableState = { occupied: boolean; since: number | null; gone: number | null; people: number };

const KEY = "dabali:camera-zones";
const KEY_AT = "dabali:camera-zones-at"; // date des zones reçues de l'ordinateur (ou envoyées par ce téléphone)
const SYNC_EVERY = 10_000;               // le téléphone regarde s'il y a de nouvelles zones ou une demande de photo
const DETECT_EVERY = 600;   // ms entre deux analyses
const SEND_EVERY = 10_000;  // envoi des chiffres
const OCCUPY_AFTER = 5_000; // table occupée après 5 s de présence (anti-passage)
const FREE_AFTER = 15_000;  // libérée après 15 s sans personne
const PER_MIN = 3;          // rythme du comptoir par défaut (personnes servies / min)

const inside = (z: Zone, px: number, py: number) => px >= z.x && px <= z.x + z.w && py >= z.y && py <= z.y + z.h;
// Part du cadre de la personne qui recouvre la zone (0..1)
const overlap = (z: Zone, b: Box) => {
  const w = Math.max(0, Math.min(z.x + z.w, b.x + b.w) - Math.max(z.x, b.x)), h = Math.max(0, Math.min(z.y + z.h, b.y + b.h) - Math.max(z.y, b.y));
  return b.w * b.h > 0 ? (w * h) / (b.w * b.h) : 0;
};
const median = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; };

export default function CameraPage() {
  const video = useRef<HTMLVideoElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const detector = useRef<{ detectForVideo: (v: HTMLVideoElement, t: number) => { detections: { boundingBox?: { originX: number; originY: number; width: number; height: number } }[] }; close: () => void } | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const tables = useRef<Record<string, TableState>>({});
  const queueHist = useRef<number[]>([]);
  const draft = useRef<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const mode = useRef<"GPU" | "CPU">("GPU");
  const loadingModel = useRef(false);

  const [zones, setZones] = useState<Zone[]>([]);
  const [running, setRunning] = useState(false);
  const [loading, setLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [edit, setEdit] = useState(false);
  const [tool, setTool] = useState<Kind>("table");
  const [boxes, setBoxes] = useState<Box[]>([]);
  const [stats, setStats] = useState({ people: 0, queue: 0, occupied: 0, seatsFree: 0, seatsTotal: 0 });
  const [sent, setSent] = useState<{ at: Date; ok: boolean; msg?: string } | null>(null);
  const [ratio, setRatio] = useState(16 / 9);
  const [saved, setSaved] = useState<string | null>(null); // confirmation après chaque zone tracée
  const [model, setModel] = useState<{ status: "idle" | "loading" | "ready" | "error"; pct?: number; msg?: string; mode?: "GPU" | "CPU" }>({ status: "idle" });

  // Zones gardées sur ce téléphone ET en base : on peut les tracer à la souris depuis l'ordinateur (Admin → Affluence)
  useEffect(() => { try { const z = JSON.parse(localStorage.getItem(KEY) ?? "[]"); if (Array.isArray(z)) setZones(z); } catch { /* rien */ } }, []);
  const keepLocal = (z: Zone[], at?: string | null) => {
    setZones(z);
    try { localStorage.setItem(KEY, JSON.stringify(z)); if (at) localStorage.setItem(KEY_AT, at); } catch { /* rien */ }
  };
  const saveZones = (z: Zone[]) => {
    keepLocal(z);
    rpc<{ zones_updated_at: string }>("vision_zones_save", { p_zones: z }).then((r) => { if (r.ok) keepLocal(z, r.zones_updated_at); });
  };

  const stop = useCallback(() => {
    stream.current?.getTracks().forEach((t) => t.stop()); stream.current = null;
    setRunning(false); setBoxes([]);
  }, []);
  useEffect(() => () => { stop(); detector.current?.close(); }, [stop]);

  // Photo de réglage demandée par l'ordinateur : UNE image réduite, envoyée seulement à la demande
  const sendSnapshot = useCallback(async () => {
    const v = video.current;
    if (!v || v.readyState < 2 || !v.videoWidth) return false;
    const c = document.createElement("canvas");
    c.width = 960; c.height = Math.round((960 * v.videoHeight) / v.videoWidth);
    c.getContext("2d")!.drawImage(v, 0, 0, c.width, c.height);
    let q = 0.7, data = c.toDataURL("image/jpeg", q);
    while (data.length > 550_000 && q > 0.3) { q -= 0.15; data = c.toDataURL("image/jpeg", q); }
    const r = await rpc("vision_snapshot_put", { p_image: data });
    setSaved(r.ok ? "📷 Photo envoyée à l'ordinateur : trace les tables à la souris (Admin → Affluence)." : `Photo non envoyée : ${r.message}`);
    return r.ok;
  }, []);

  // Synchronisation avec l'ordinateur : nouvelles zones → reprises ici ; demande de photo → envoyée
  useEffect(() => {
    let alive = true;
    const sync = async () => {
      const r = await rpc<{ zones: Zone[]; zones_updated_at: string | null; snapshot_requested_at: string | null }>("vision_setup_get");
      if (!alive || !r.ok) return; // fonction pas encore en ligne, ou hors réseau : on garde les zones du téléphone
      let localAt: string | null = null; let local: Zone[] = [];
      try { localAt = localStorage.getItem(KEY_AT); local = JSON.parse(localStorage.getItem(KEY) ?? "[]"); } catch { /* rien */ }
      if (r.zones_updated_at && (!localAt || r.zones_updated_at > localAt)) {
        keepLocal(r.zones, r.zones_updated_at); tables.current = {};
        if (r.zones.length) setEdit(false); // zones tracées sur l'ordinateur : plus rien à faire sur le téléphone
        setSaved("🖥️ Zones mises à jour depuis l'ordinateur ✓");
      } else if (!r.zones_updated_at && local.length) {
        saveZones(local); // premières zones tracées sur ce téléphone : partagées avec l'ordinateur
      }
      if (r.snapshot_requested_at && running) await sendSnapshot();
    };
    sync();
    const id = setInterval(sync, SYNC_EVERY);
    return () => { alive = false; clearInterval(id); };
  }, [running, sendSnapshot]); // eslint-disable-line react-hooks/exhaustive-deps

  // Télécharge un fichier en affichant la progression (le navigateur le garde ensuite en cache)
  async function download(url: string, onBytes: (n: number) => void): Promise<Uint8Array> {
    const r = await fetch(url);
    if (!r.ok || !r.body) throw new Error(`${url} : ${r.status}`);
    const reader = r.body.getReader(); const parts: Uint8Array[] = []; let n = 0;
    for (;;) { const { done, value } = await reader.read(); if (done) break; parts.push(value); n += value.length; onBytes(value.length); }
    const out = new Uint8Array(n); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  }
  const withTimeout = <T,>(p: Promise<T>, ms: number) => Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error("délai dépassé")), ms))]);

  // Modèle chargé EN ARRIÈRE-PLAN : la caméra s'affiche tout de suite et on peut tracer les zones pendant ce temps
  async function loadModel() {
    if (detector.current || loadingModel.current) return;
    loadingModel.current = true;
    setModel({ status: "loading", pct: 0 });
    try {
      const TOTAL = 9_574_032 + 4_602_795; let got = 0;
      const tick = (n: number) => { got += n; setModel({ status: "loading", pct: Math.min(99, Math.round((got / TOTAL) * 100)) }); };
      const [, buffer] = await Promise.all([download("/mediapipe/vision_wasm_internal.wasm", tick), download("/models/efficientdet_lite0.tflite", tick)]);
      setModel({ status: "loading", pct: 99, msg: "Préparation…" });
      const { FilesetResolver, ObjectDetector } = await import("@mediapipe/tasks-vision");
      const files = await withTimeout(FilesetResolver.forVisionTasks("/mediapipe"), 30_000);
      const make = (delegate: "GPU" | "CPU") => ObjectDetector.createFromOptions(files, {
        baseOptions: { modelAssetBuffer: buffer, delegate },
        runningMode: "IMAGE", scoreThreshold: 0.25, maxResults: 40, categoryAllowlist: ["person"],
      });
      // Test de la carte graphique sur une image de référence (3 personnes), 8 s au plus : si elle ne voit rien ou bloque
      // (certains téléphones), on prend le processeur, plus lent mais fiable. Le GPU écarté est fermé APRÈS (sinon blocage).
      const probe = new Image(); probe.src = "/models/probe.jpg"; await probe.decode();
      let det: Awaited<ReturnType<typeof make>> | null = null;
      let unused: Awaited<ReturnType<typeof make>> | null = null;
      if (!new URLSearchParams(location.search).has("cpu")) {
        try {
          const gpu = await withTimeout(make("GPU"), 8_000);
          if (gpu.detect(probe).detections.length > 0) { det = gpu; mode.current = "GPU"; } else unused = gpu;
        } catch { /* pas de carte graphique utilisable */ }
      }
      if (!det) { det = await withTimeout(make("CPU"), 30_000); mode.current = "CPU"; }
      try { unused?.close(); } catch { /* rien */ }
      await det.setOptions({ runningMode: "VIDEO" });
      detector.current = det as unknown as typeof detector.current;
      setModel({ status: "ready", mode: mode.current });
    } catch (e) {
      setModel({ status: "error", msg: String(e).includes("Failed to fetch") || String(e).includes("NetworkError") ? "Réseau trop lent ou coupé." : "Le modèle n'a pas pu démarrer sur ce téléphone." });
    } finally { loadingModel.current = false; }
  }

  async function start() {
    setError(null);
    try {
      setLoading("Ouverture de la caméra…");
      stream.current = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
      const v = video.current!;
      v.srcObject = stream.current;
      await v.play();
      setRatio(v.videoWidth / v.videoHeight || 16 / 9);
      // L'écran reste allumé pendant l'analyse
      try { await (navigator as unknown as { wakeLock?: { request: (t: string) => Promise<unknown> } }).wakeLock?.request("screen"); } catch { /* facultatif */ }
      setRunning(true);
      if (!zones.length) { setEdit(true); setTool("table"); } // étape suivante : tracer les zones (ici ou depuis l'ordinateur)
    } catch (e) {
      setError(String(e).includes("Permission") || String(e).includes("NotAllowed") ? "Autorise l'accès à la caméra dans le navigateur (réglages du navigateur → Caméra), puis réessaie." : "Impossible d'ouvrir la caméra sur ce téléphone.");
      stop(); return;
    } finally { setLoading(null); }
    loadModel();
  }

  // Analyse : personnes → zones → compteurs (lissés pour éviter les clignotements)
  useEffect(() => {
    if (!running) return;
    // Boucle adaptative : on attend au moins 2× la durée d'une analyse (écran fluide même sur un téléphone lent)
    let timer: ReturnType<typeof setTimeout>; let alive = true;
    const tick = () => {
      const t0 = performance.now();
      step();
      if (alive) timer = setTimeout(tick, Math.max(DETECT_EVERY, 2 * (performance.now() - t0)));
    };
    const step = () => {
      const v = video.current, det = detector.current;
      if (!v || !det || v.readyState < 2) return;
      const W = v.videoWidth, H = v.videoHeight;
      let res;
      try { res = det.detectForVideo(v, performance.now()); } catch { return; }
      const b: Box[] = res.detections.map((d) => d.boundingBox).filter(Boolean)
        .map((bb) => ({ x: bb!.originX / W, y: bb!.originY / H, w: bb!.width / W, h: bb!.height / H }));
      setBoxes(b);
      const now = Date.now();
      let queue = 0; const perTable: Record<string, number> = {};
      for (const box of b) {
        const fx = box.x + box.w / 2, fy = Math.min(box.y + box.h, 1), cy = box.y + box.h / 2; // pieds, puis centre (assis : pieds cachés)
        // Table : pieds ou centre dans la zone, sinon la table que le cadre de la personne recouvre le plus
        // (personne assise dont le buste dépasse sur la table, chaise hors du rectangle tracé)
        const t = zones.find((z) => z.kind === "table" && (inside(z, fx, fy) || inside(z, fx, cy)))
          ?? zones.filter((z) => z.kind === "table").map((z) => ({ z, o: overlap(z, box) })).filter((x) => x.o >= 0.2).sort((p, q) => q.o - p.o)[0]?.z;
        if (t) { perTable[t.id] = (perTable[t.id] ?? 0) + 1; continue; }
        if (zones.some((z) => z.kind === "queue" && (inside(z, fx, fy) || inside(z, fx, cy)))) queue++;
      }
      queueHist.current = [...queueHist.current.slice(-4), queue];
      let occupied = 0, seatsTotal = 0, seatsFree = 0;
      for (const z of zones.filter((x) => x.kind === "table")) {
        const n = perTable[z.id] ?? 0;
        const s = (tables.current[z.id] ??= { occupied: false, since: null, gone: null, people: 0 });
        s.people = n;
        if (n > 0) { s.gone = null; s.since ??= now; if (!s.occupied && now - s.since >= OCCUPY_AFTER) s.occupied = true; }
        else { s.since = null; s.gone ??= now; if (s.occupied && now - s.gone >= FREE_AFTER) s.occupied = false; }
        if (s.occupied) occupied++;
        seatsTotal += z.seats; seatsFree += Math.max(0, z.seats - (s.occupied ? Math.max(n, 1) : n));
      }
      setStats({ people: b.length, queue: median(queueHist.current), occupied, seatsFree, seatsTotal });
    };
    timer = setTimeout(tick, 300);
    return () => { alive = false; clearTimeout(timer); };
  }, [running, zones]);

  // Envoi des chiffres à Vatel (l'appli des élèves affiche alors l'affluence « en direct »)
  const statsRef = useRef(stats); statsRef.current = stats;
  useEffect(() => {
    if (!running || !zones.length) return;
    const send = async () => {
      const s = statsRef.current; const tz = zones.filter((z) => z.kind === "table");
      const r = await rpc("vision_report", { p_people: s.people, p_occupied: s.occupied, p_total: Math.max(tz.length, 1), p_queue: s.queue, p_counter: 0,
        p_seats_total: s.seatsTotal, p_seats_free: s.seatsFree,
        p_table_states: Object.fromEntries(tz.map((z, i) => [`T${i + 1}`, !!tables.current[z.id]?.occupied])) });
      setSent({ at: new Date(), ok: r.ok, msg: r.ok ? undefined : r.message });
    };
    const id = setInterval(send, SEND_EVERY);
    return () => clearInterval(id);
  }, [running, zones]);

  // Dessin : vidéo + cadres des personnes + zones
  useEffect(() => {
    const c = canvas.current; if (!c) return;
    const r = c.getBoundingClientRect(); const dpr = window.devicePixelRatio || 1;
    c.width = r.width * dpr; c.height = r.height * dpr;
    const g = c.getContext("2d")!; g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, r.width, r.height);
    const W = r.width, H = r.height;
    if (!running) return; // caméra arrêtée : pas de zones par-dessus les consignes
    zones.forEach((z, i) => {
      const occ = z.kind === "table" && tables.current[z.id]?.occupied;
      g.fillStyle = z.kind === "queue" ? "rgba(250,204,21,0.18)" : occ ? "rgba(239,68,68,0.22)" : "rgba(34,197,94,0.18)";
      g.strokeStyle = z.kind === "queue" ? "#facc15" : occ ? "#ef4444" : "#22c55e"; g.lineWidth = 2;
      g.fillRect(z.x * W, z.y * H, z.w * W, z.h * H); g.strokeRect(z.x * W, z.y * H, z.w * W, z.h * H);
      g.fillStyle = "#fff"; g.font = "bold 13px system-ui";
      const label = z.kind === "queue" ? `File · ${stats.queue}` : `T${zones.filter((x) => x.kind === "table").indexOf(z) + 1} · ${tables.current[z.id]?.people ?? 0}/${z.seats}`;
      g.fillText(label, z.x * W + 6, z.y * H + 16);
      void i;
    });
    g.strokeStyle = "#C8F135"; g.lineWidth = 3;
    boxes.forEach((b) => { g.strokeRect(b.x * W, b.y * H, b.w * W, b.h * H); });
    if (draft.current) {
      const d = draft.current; g.setLineDash([6, 4]); g.strokeStyle = "#fff";
      g.strokeRect(Math.min(d.x0, d.x1) * W, Math.min(d.y0, d.y1) * H, Math.abs(d.x1 - d.x0) * W, Math.abs(d.y1 - d.y0) * H); g.setLineDash([]);
    }
  }, [boxes, zones, stats.queue, edit, running]);

  // Tracé d'une zone au doigt
  const pt = (e: React.PointerEvent) => { const r = (e.target as HTMLElement).getBoundingClientRect(); return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) }; };
  const [, redraw] = useState(0);
  function down(e: React.PointerEvent) { if (!edit) return; (e.target as HTMLElement).setPointerCapture(e.pointerId); const p = pt(e); draft.current = { x0: p.x, y0: p.y, x1: p.x, y1: p.y }; redraw((n) => n + 1); setBoxes((b) => [...b]); }
  function move(e: React.PointerEvent) { if (!edit || !draft.current) return; const p = pt(e); draft.current.x1 = p.x; draft.current.y1 = p.y; setBoxes((b) => [...b]); }
  function up() {
    const d = draft.current; draft.current = null;
    if (!d) return;
    const z: Zone = { id: crypto.randomUUID(), kind: tool, seats: tool === "table" ? 4 : 0, x: Math.min(d.x0, d.x1), y: Math.min(d.y0, d.y1), w: Math.abs(d.x1 - d.x0), h: Math.abs(d.y1 - d.y0) };
    if (z.w > 0.04 && z.h > 0.04) {
      saveZones([...zones, z]);
      setSaved(z.kind === "table" ? `✓ Table T${zones.filter((x) => x.kind === "table").length + 1} enregistrée : règle son nombre de places plus bas (− / +).` : "✓ File d'attente enregistrée.");
    } else { setSaved("Rectangle trop petit : fais-le plus grand."); setBoxes((b) => [...b]); }
  }

  const wait = stats.queue ? Math.max(1, Math.ceil(stats.queue / PER_MIN)) : 0;
  const tableZones = zones.filter((z) => z.kind === "table");

  return (
    <main className={clsx("min-h-dvh bg-ink text-white", edit && running ? "pb-36" : "pb-10")}>
      <header className="flex items-center justify-between gap-2 px-4 pb-3 pt-[max(0.8rem,env(safe-area-inset-top))]">
        <p className="flex items-center gap-2 font-extrabold"><Video className="size-5 text-lime" />Caméra d&apos;affluence</p>
        <Link href="/scan" aria-label="Fermer" className="grid size-9 place-items-center rounded-full bg-white/10"><X className="size-5" /></Link>
      </header>

      <div className="relative mx-auto overflow-hidden rounded-3xl bg-black" style={{ aspectRatio: ratio, width: `min(calc(100% - 2rem), calc(52dvh * ${ratio}))` }}>
        <video ref={video} className="absolute inset-0 size-full object-fill" muted playsInline />
        <canvas ref={canvas} className={clsx("absolute inset-0 size-full", edit && "cursor-crosshair touch-none")}
          onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} />
        {!running && (
          <div className="absolute inset-0 grid place-items-center p-6 text-center">
            <div>
              {loading ? <p className="text-sm font-semibold text-white/80">{loading}</p> : (
                <ol className="space-y-1 text-left text-sm font-semibold text-white/80">
                  <li>1. Pose le téléphone en hauteur, face aux tables et à la file.</li>
                  <li>2. Touche « Démarrer » et autorise la caméra.</li>
                  <li>3. Trace un rectangle par table, puis la file d&apos;attente : au doigt ici, ou à la souris sur l&apos;ordinateur (Admin → Affluence).</li>
                </ol>
              )}
              {!loading && <button onClick={start} className="mx-auto mt-4 flex h-12 items-center gap-2 rounded-full bg-lime px-6 font-extrabold text-ink"><Play className="size-5" />Démarrer</button>}
            </div>
          </div>
        )}
        {edit && running && <p className="pointer-events-none absolute inset-x-0 top-2 px-3 text-center text-xs font-bold text-white drop-shadow">Trace au doigt un rectangle « {tool === "table" ? "table (avec ses chaises)" : "file d'attente"} »</p>}
        {running && model.status === "loading" && (
          <div className="pointer-events-none absolute inset-x-3 bottom-3 rounded-xl bg-black/70 px-3 py-2 text-xs font-bold">
            {model.msg ?? `Téléchargement du modèle de détection : ${model.pct ?? 0} %`} <span className="font-semibold text-white/60">(14 Mo, une seule fois)</span>
            <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-white/20"><div className="h-full rounded-full bg-lime transition-all" style={{ width: `${model.pct ?? 0}%` }} /></div>
          </div>
        )}
      </div>
      {error && <p className="mx-4 mt-3 rounded-2xl bg-err px-4 py-3 text-sm font-bold">{error}</p>}
      {running && model.status === "error" && (
        <div className="mx-4 mt-3 flex items-center gap-3 rounded-2xl bg-err px-4 py-3 text-sm font-bold">
          <span className="flex-1">{model.msg}</span>
          <button onClick={loadModel} className="rounded-full bg-white px-3 py-1.5 text-ink">Réessayer</button>
        </div>
      )}
      {running && saved && <p className="mx-4 mt-3 rounded-2xl bg-white/10 px-4 py-2.5 text-sm font-bold text-lime">{saved}</p>}
      {running && !zones.length && model.status !== "error" && (
        <p className="mx-4 mt-3 rounded-2xl bg-lime px-4 py-3 text-sm font-extrabold text-ink">
          Étape 2 : sur l&apos;image, trace au doigt UN rectangle qui couvre une table ET ses chaises (là où les gens s&apos;assoient). La zone est enregistrée dès que tu lèves le doigt. Ensuite « + File d&apos;attente » pour la zone de la queue.
        </p>
      )}

      {/* Compteurs en direct */}
      <div className="mx-4 mt-4 grid grid-cols-2 gap-3">
        <div className="rounded-2xl bg-white/10 p-3">
          <p className="text-xs font-bold uppercase tracking-wider text-white/60">File d&apos;attente</p>
          <p className="text-3xl font-extrabold text-lime">{stats.queue}</p>
          <p className="text-xs font-semibold text-white/70">{stats.queue ? `≈ ${wait} min d'attente` : "personne"}</p>
        </div>
        <div className="rounded-2xl bg-white/10 p-3">
          <p className="text-xs font-bold uppercase tracking-wider text-white/60">Places libres</p>
          <p className="text-3xl font-extrabold">{stats.seatsTotal ? `${stats.seatsFree}/${stats.seatsTotal}` : "—"}</p>
          <p className="text-xs font-semibold text-white/70">{tableZones.length ? `${stats.occupied}/${tableZones.length} tables occupées` : "aucune table tracée"}</p>
        </div>
      </div>
      <p className="mx-4 mt-2 text-xs font-semibold text-white/60">
        {stats.people} personne{stats.people > 1 ? "s" : ""} détectée{stats.people > 1 ? "s" : ""}
        {sent && (sent.ok ? ` · envoyé à l'appli à ${sent.at.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", second: "2-digit" })} ✓` : ` · envoi refusé : ${sent.msg}`)}
        {running && model.status === "ready" && ` · analyse : ${model.mode === "GPU" ? "carte graphique" : "processeur"}`}
        {running && model.status === "loading" && " · modèle en chargement…"}
      </p>

      {/* Commandes */}
      <div className={clsx("flex flex-wrap gap-2", edit && running ? "fixed inset-x-0 bottom-0 z-40 border-t border-white/10 bg-ink/95 px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 backdrop-blur" : "mx-4 mt-4")}>
        {running ? <button onClick={stop} className="flex h-11 items-center gap-2 rounded-full bg-white/10 px-4 text-sm font-bold"><Square className="size-4" />Arrêter</button> : null}
        {running && (
          <button onClick={() => setEdit((e) => !e)} className={clsx("flex h-11 items-center gap-2 rounded-full px-4 text-sm font-bold", edit ? "bg-lime text-ink" : "bg-white/10")}>
            {edit ? <><Check className="size-4" />Terminer les zones</> : <><Pencil className="size-4" />Tracer les zones</>}
          </button>
        )}
        {running && !edit && (
          <button onClick={sendSnapshot} className="flex h-11 items-center gap-2 rounded-full bg-white/10 px-4 text-sm font-bold"><Monitor className="size-4" />Tracer depuis l&apos;ordinateur</button>
        )}
        {edit && running && (["table", "queue"] as Kind[]).map((k) => (
          <button key={k} onClick={() => setTool(k)} className={clsx("h-11 rounded-full px-4 text-sm font-bold", tool === k ? "bg-white text-ink" : "bg-white/10")}>
            {k === "table" ? "+ Table" : "+ File d'attente"}
          </button>
        ))}
      </div>

      {/* Zones : places par table, suppression */}
      {zones.length > 0 && (
        <ul className="mx-4 mt-4 divide-y divide-white/10 overflow-hidden rounded-2xl bg-white/5">
          {zones.map((z) => (
            <li key={z.id} className="flex items-center gap-3 px-3 py-2.5 text-sm">
              <span className={clsx("size-3 rounded-full", z.kind === "queue" ? "bg-yellow-400" : "bg-green-500")} />
              <span className="flex-1 font-bold">{z.kind === "queue" ? "File d'attente" : `Table T${tableZones.indexOf(z) + 1}`}</span>
              {z.kind === "table" && (
                <span className="flex items-center gap-2">
                  <button aria-label="Moins de places" onClick={() => saveZones(zones.map((x) => x.id === z.id ? { ...x, seats: Math.max(1, x.seats - 1) } : x))} className="grid size-7 place-items-center rounded-full bg-white/10"><Minus className="size-3.5" /></button>
                  <span className="w-16 text-center font-bold">{z.seats} place{z.seats > 1 ? "s" : ""}</span>
                  <button aria-label="Plus de places" onClick={() => saveZones(zones.map((x) => x.id === z.id ? { ...x, seats: Math.min(20, x.seats + 1) } : x))} className="grid size-7 place-items-center rounded-full bg-white/10"><Plus className="size-3.5" /></button>
                </span>
              )}
              <button aria-label="Supprimer la zone" onClick={() => { delete tables.current[z.id]; saveZones(zones.filter((x) => x.id !== z.id)); }} className="grid size-8 place-items-center rounded-full text-err"><Trash2 className="size-4" /></button>
            </li>
          ))}
        </ul>
      )}

      <p className="mx-4 mt-5 flex gap-2 text-xs font-semibold text-white/60">
        <ShieldCheck className="size-4 shrink-0 text-lime" />
        L&apos;analyse se fait sur ce téléphone, pas de reconnaissance de visage : seuls les nombres (file, places libres) partent vers Vatel. Seule exception : la photo de réglage, envoyée quand on la demande pour tracer les zones sur l&apos;ordinateur, visible par l&apos;équipe seulement et effacée sous 24 h.
      </p>
    </main>
  );
}
