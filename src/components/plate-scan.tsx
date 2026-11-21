"use client";
import { useRef, useState } from "react";
import clsx from "clsx";
import { Camera, RotateCcw, Sparkles } from "lucide-react";
import { edge } from "@/lib/supabase/client";
import { Sheet } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";

type Result = { dish: string; recognized: boolean; left_pct: number; items: { name: string; left_pct: number }[]; note: string; today_avg: number | null };

/** Réduit la photo (1024 px, JPEG) avant l'envoi : rapide même en 3G, et rien n'est gardé côté serveur. */
async function shrink(file: File): Promise<string> {
  const img = await createImageBitmap(file);
  const k = Math.min(1, 1024 / Math.max(img.width, img.height));
  const c = document.createElement("canvas");
  c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
  c.getContext("2d")!.drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL("image/jpeg", 0.75).split(",")[1];
}

const tone = (p: number) => (p <= 10 ? "bg-ok" : p <= 40 ? "bg-warn" : "bg-err");
const verdict = (p: number) => (p <= 10 ? "Assiette vide 👏" : p <= 40 ? "Un peu de reste" : p <= 70 ? "Beaucoup de reste" : "Presque pas mangé");

/** Gaspillage dans l'assiette : photo d'un plateau rendu → part non mangée, par élément (l'IA reconnaît le plat du jour). */
export function PlateScan({ open, onClose }: { open: boolean; onClose: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<Result | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function pick(f: File) {
    setErr(null); setRes(null); setBusy(true);
    try {
      const b64 = await shrink(f);
      setPreview(`data:image/jpeg;base64,${b64}`);
      const r = await edge<Result>("plate-scan", { image: b64, media_type: "image/jpeg" });
      if (!r.ok) setErr(r.message); else setRes(r as unknown as Result);
    } catch { setErr("Photo illisible, réessaie."); }
    setBusy(false);
  }
  const again = () => { setPreview(null); setRes(null); setErr(null); input.current?.click(); };
  const close = () => { setPreview(null); setRes(null); setErr(null); onClose(); };

  return (
    <Sheet open={open} onClose={close} title="Analyser une assiette">
      <input ref={input} type="file" accept="image/*" capture="environment" className="hidden"
        onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) pick(f); }} />
      {!preview && (
        <>
          <p className="-mt-1 mb-4 text-sm text-muted">Au retour du plateau, prends l&apos;assiette en photo, bien au-dessus. L&apos;IA reconnaît le plat du jour et mesure ce qui n&apos;a pas été mangé. La photo n&apos;est pas gardée.</p>
          <Button block size="lg" variant="dark" onClick={() => input.current?.click()}><Camera className="size-5" />Prendre la photo</Button>
        </>
      )}
      {preview && (
        <div className="space-y-3">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={preview} alt="Assiette" className={clsx("h-44 w-full rounded-2xl object-cover", busy && "animate-pulse opacity-70")} />
          {busy && <p className="flex items-center justify-center gap-2 text-sm font-bold text-muted"><Sparkles className="size-4 animate-spin" />L&apos;IA regarde l&apos;assiette…</p>}
          {err && <p className="rounded-2xl bg-err-soft px-3 py-2.5 text-sm font-bold text-err">{err}</p>}
          {res && (
            <div className="rounded-2xl bg-canvas p-3.5">
              <div className="flex items-end justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-xs font-extrabold uppercase tracking-wider text-muted">{res.recognized ? "Plat du jour reconnu" : "Plat (hors menu du jour)"}</p>
                  <p className="truncate text-lg font-extrabold">{res.dish}</p>
                  <p className="text-sm font-bold text-ink-2">{verdict(res.left_pct)}</p>
                </div>
                <p className="shrink-0 text-right"><span className="text-4xl font-extrabold">{res.left_pct}%</span><span className="block text-xs font-bold text-muted">laissé</span></p>
              </div>
              <div className="mt-3 space-y-2">
                {res.items.map((i) => (
                  <div key={i.name}>
                    <div className="flex justify-between text-xs font-bold"><span className="capitalize">{i.name}</span><span>{i.left_pct}% laissé</span></div>
                    <div className="mt-1 h-2 overflow-hidden rounded-full bg-line"><div className={clsx("h-full rounded-full", tone(i.left_pct))} style={{ width: `${Math.max(i.left_pct, 2)}%` }} /></div>
                  </div>
                ))}
              </div>
              {res.note && <p className="mt-3 text-sm font-semibold text-ink-2">💡 {res.note}</p>}
              {res.today_avg != null && <p className="mt-1 text-xs font-bold text-muted">Moyenne du jour pour ce plat : {res.today_avg}% laissé</p>}
            </div>
          )}
          {!busy && <Button block variant="dark" onClick={again}><RotateCcw className="size-4" />Assiette suivante</Button>}
        </div>
      )}
    </Sheet>
  );
}
