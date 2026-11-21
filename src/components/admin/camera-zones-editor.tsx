"use client";
// Réglage de la caméra d'affluence DEPUIS L'ORDINATEUR : le téléphone est fixé en hauteur ; on lui demande une photo,
// puis on trace à la souris un rectangle par table (avec ses chaises) et la file d'attente. Le téléphone reprend
// les zones tout seul (en 10 s environ). La photo est réservée à l'équipe et effacée sous 24 h.
import { useCallback, useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { Camera, Trash2, Minus, Plus, Save, RefreshCw, Eraser, Smartphone } from "lucide-react";
import { rpc } from "@/lib/supabase/client";
import { Card, Badge } from "@/components/admin/ui";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { time } from "@/lib/format";

type Kind = "table" | "queue";
type Zone = { id: string; kind: Kind; seats: number; x: number; y: number; w: number; h: number };
type Setup = { zones: Zone[]; zones_updated_at: string | null; snapshot: string | null; snapshot_at: string | null; snapshot_requested_at: string | null };

export function CameraZonesEditor() {
  const toast = useToast();
  const [setup, setSetup] = useState<Setup | null>(null);
  const [zones, setZones] = useState<Zone[]>([]);
  const [dirty, setDirty] = useState(false);
  const [tool, setTool] = useState<Kind>("table");
  const [draft, setDraft] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const area = useRef<HTMLDivElement>(null);
  const dirtyRef = useRef(false); dirtyRef.current = dirty;

  const load = useCallback(async () => {
    const r = await rpc<Setup>("vision_setup_get");
    if (!r.ok) { setUnavailable(true); return; }
    setUnavailable(false);
    setSetup(r as unknown as Setup);
    if (!dirtyRef.current) setZones(((r as unknown as Setup).zones ?? []) as Zone[]);
  }, []);
  // En attente de la photo : on regarde toutes les 4 s ; sinon toutes les 30 s
  const waiting = !!setup?.snapshot_requested_at;
  useEffect(() => { load(); const id = setInterval(load, waiting ? 4000 : 30_000); return () => clearInterval(id); }, [load, waiting]);

  const call = async (fn: string, args: Record<string, unknown>, ok: string) => {
    setBusy(fn);
    const r = await rpc(fn, args);
    setBusy(null);
    if (!r.ok) return toast("err", r.message);
    toast("ok", ok); load();
  };
  const save = async () => {
    setBusy("save");
    const r = await rpc("vision_zones_save", { p_zones: zones });
    setBusy(null);
    if (!r.ok) return toast("err", r.message);
    setDirty(false); toast("ok", "Zones enregistrées : le téléphone les reprend dans quelques secondes."); load();
  };
  const edit = (z: Zone[]) => { setZones(z); setDirty(true); };

  // Tracé à la souris (coordonnées 0..1 de l'image, comme sur le téléphone)
  const pt = (e: React.PointerEvent) => {
    const r = area.current!.getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) };
  };
  const down = (e: React.PointerEvent) => { (e.target as HTMLElement).setPointerCapture(e.pointerId); const p = pt(e); setDraft({ x0: p.x, y0: p.y, x1: p.x, y1: p.y }); };
  const move = (e: React.PointerEvent) => { if (draft) { const p = pt(e); setDraft({ ...draft, x1: p.x, y1: p.y }); } };
  const up = () => {
    if (!draft) return;
    const z: Zone = { id: crypto.randomUUID(), kind: tool, seats: tool === "table" ? 4 : 0,
      x: Math.min(draft.x0, draft.x1), y: Math.min(draft.y0, draft.y1), w: Math.abs(draft.x1 - draft.x0), h: Math.abs(draft.y1 - draft.y0) };
    setDraft(null);
    if (z.w < 0.03 || z.h < 0.03) return toast("err", "Rectangle trop petit : fais-le plus grand.");
    edit([...zones, z]);
  };

  const tables = zones.filter((z) => z.kind === "table");
  const label = (z: Zone) => (z.kind === "queue" ? "File d'attente" : `Table T${tables.indexOf(z) + 1}`);

  if (unavailable) return null; // réglage à distance pas encore en ligne
  return (
    <Card title="Réglage de la caméra depuis l'ordinateur"
      subtitle="Le téléphone est fixé en hauteur : demande-lui une photo, puis trace à la souris un rectangle par table (avec ses chaises) et la file d'attente."
      action={setup?.zones_updated_at ? <Badge tone="ok">Zones du {new Date(setup.zones_updated_at).toLocaleDateString("fr-FR", { day: "numeric", month: "short", timeZone: "Africa/Abidjan" })} · {time(setup.zones_updated_at)}</Badge> : <Badge>Aucune zone</Badge>}>
      {!setup?.snapshot ? (
        <div className="rounded-2xl border-2 border-dashed border-line p-6 text-center">
          <Smartphone className="mx-auto size-8 text-muted" />
          <ol className="mx-auto mt-3 max-w-md space-y-1 text-left text-sm text-ink-2">
            <li>1. Sur le téléphone fixé dans la salle : <b>/scan/camera</b> (compte Agent ou Admin), touche <b>Démarrer</b> et laisse la page ouverte.</li>
            <li>2. Ici : <b>Demander une photo</b>. Elle arrive en 10 à 20 secondes. Conseil : salle vide.</li>
          </ol>
          <Button className="mt-4" loading={busy === "vision_snapshot_request"} disabled={waiting}
            onClick={() => call("vision_snapshot_request", {}, "Photo demandée : le téléphone l'envoie dans quelques secondes.")}>
            <Camera className="size-4" />{waiting ? `Demandée à ${time(setup!.snapshot_requested_at!)} · en attente du téléphone…` : "Demander une photo"}
          </Button>
          {waiting && <p className="mt-2 text-xs text-muted">Rien ne vient ? Vérifie que la page caméra est ouverte et démarrée sur le téléphone.</p>}
        </div>
      ) : (
        <>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            {(["table", "queue"] as Kind[]).map((k) => (
              <button key={k} onClick={() => setTool(k)} className={clsx("h-9 rounded-full px-4 text-sm font-bold", tool === k ? "bg-ink text-lime" : "bg-canvas")}>
                {k === "table" ? "+ Table" : "+ File d'attente"}
              </button>
            ))}
            <span className="text-xs text-muted">Clique-glisse sur la photo pour tracer un rectangle « {tool === "table" ? "table + chaises" : "file d'attente"} ».</span>
          </div>
          <div ref={area} className="relative w-full cursor-crosshair touch-none select-none overflow-hidden rounded-2xl bg-ink"
            onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={() => setDraft(null)}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={setup.snapshot} alt="Photo de réglage de la caméra" className="block w-full" draggable={false} />
            {zones.map((z) => (
              <div key={z.id} className={clsx("pointer-events-none absolute border-2", z.kind === "queue" ? "border-yellow-400 bg-yellow-400/20" : "border-green-500 bg-green-500/20")}
                style={{ left: `${z.x * 100}%`, top: `${z.y * 100}%`, width: `${z.w * 100}%`, height: `${z.h * 100}%` }}>
                <span className="absolute left-1 top-0.5 rounded bg-black/60 px-1.5 text-xs font-bold text-white">{z.kind === "queue" ? "File" : `T${tables.indexOf(z) + 1} · ${z.seats} pl.`}</span>
              </div>
            ))}
            {draft && (
              <div className="pointer-events-none absolute border-2 border-dashed border-white"
                style={{ left: `${Math.min(draft.x0, draft.x1) * 100}%`, top: `${Math.min(draft.y0, draft.y1) * 100}%`, width: `${Math.abs(draft.x1 - draft.x0) * 100}%`, height: `${Math.abs(draft.y1 - draft.y0) * 100}%` }} />
            )}
          </div>
          <p className="mt-1.5 text-xs text-muted">Photo du {time(setup.snapshot_at!)} · visible par l&apos;équipe seulement, effacée automatiquement sous 24 h.</p>

          {zones.length > 0 && (
            <ul className="mt-3 divide-y divide-line rounded-2xl border border-line">
              {zones.map((z) => (
                <li key={z.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                  <span className={clsx("size-3 rounded-full", z.kind === "queue" ? "bg-yellow-400" : "bg-green-500")} />
                  <span className="flex-1 font-bold">{label(z)}</span>
                  {z.kind === "table" && (
                    <span className="flex items-center gap-2">
                      <button aria-label="Moins de places" onClick={() => edit(zones.map((x) => (x.id === z.id ? { ...x, seats: Math.max(1, x.seats - 1) } : x)))} className="grid size-7 place-items-center rounded-full bg-canvas"><Minus className="size-3.5" /></button>
                      <span className="w-16 text-center font-bold">{z.seats} places</span>
                      <button aria-label="Plus de places" onClick={() => edit(zones.map((x) => (x.id === z.id ? { ...x, seats: Math.min(20, x.seats + 1) } : x)))} className="grid size-7 place-items-center rounded-full bg-canvas"><Plus className="size-3.5" /></button>
                    </span>
                  )}
                  <button aria-label={`Supprimer ${label(z)}`} onClick={() => edit(zones.filter((x) => x.id !== z.id))} className="grid size-8 place-items-center rounded-full text-err"><Trash2 className="size-4" /></button>
                </li>
              ))}
            </ul>
          )}

          <div className="mt-4 flex flex-wrap gap-2">
            <Button loading={busy === "save"} disabled={!dirty} onClick={save}><Save className="size-4" />{dirty ? "Enregistrer les zones" : "Zones enregistrées"}</Button>
            {dirty && <Button variant="outline" onClick={() => { setZones(setup.zones ?? []); setDirty(false); }}>Annuler les changements</Button>}
            <Button variant="outline" loading={busy === "vision_snapshot_request"} onClick={() => call("vision_snapshot_request", {}, "Nouvelle photo demandée.")}><RefreshCw className="size-4" />Nouvelle photo</Button>
            <Button variant="outline" loading={busy === "vision_snapshot_clear"} onClick={() => call("vision_snapshot_clear", {}, "Photo effacée.")}><Eraser className="size-4" />Effacer la photo</Button>
          </div>
        </>
      )}
    </Card>
  );
}
