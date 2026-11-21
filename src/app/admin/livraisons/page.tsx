"use client";
import { useCallback, useEffect, useState } from "react";
import clsx from "clsx";
import { Bike, Plus, Share2, ExternalLink, PackageCheck, Play } from "lucide-react";
import { rpc, supabase } from "@/lib/supabase/client";
import { Card, PageTitle, Badge, Empty } from "@/components/admin/ui";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { DeliveryTracker, STATUS, type Track } from "@/components/delivery/tracker";
import { dateTime } from "@/lib/format";

type Run = { id: string; title: string; status: string; track_token: string; created_at: string; eta_at: string | null };

/** Livraisons : tournée d'achats du coursier (type Yango, simulée), suivie en direct et pilotée avec Jean. */
export default function DeliveriesPage() {
  const toast = useToast();
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const load = useCallback(() => supabase().from("delivery_runs").select("id, title, status, track_token, created_at, eta_at")
    .order("created_at", { ascending: false }).limit(20).then(({ data }) => {
      const l = (data ?? []) as Run[];
      setRuns(l);
      setSel((s) => s ?? l[0]?.id ?? null);
    }), []);
  useEffect(() => { load(); }, [load]);

  const run = runs?.find((r) => r.id === sel) ?? null;
  const onData = useCallback((t: Track) => setStatus(t.run.status), []);
  const st = status ?? run?.status;
  const link = run ? `${typeof window !== "undefined" ? window.location.origin : "https://vatel-cantine.netlify.app"}/suivi/${run.track_token}` : "";

  async function call(action: "create" | "start") {
    setBusy(action);
    const { data, error } = await supabase().functions.invoke("delivery", { body: { action, run_id: sel } });
    setBusy(null);
    if (error || !data?.ok) {
      let m = data?.message as string | undefined;
      if (!m && error && "context" in error) m = (await (error as { context: Response }).context.json().catch(() => null))?.message;
      return toast("err", m ?? "Action impossible.");
    }
    if (action === "create") { setSel(data.run_id); setStatus(null); toast("ok", "Tournée créée : 3 fournisseurs, 6 articles."); }
    else toast("ok", "Le coursier est parti 🛵");
    load();
  }

  async function receive() {
    setBusy("receive");
    const r = await rpc<{ stock_lines: number }>("delivery_receive", { p_run: sel });
    setBusy(null);
    if (!r.ok) return toast("err", r.message);
    toast("ok", `Réceptionné : ${r.stock_lines} article(s) ajoutés au stock.`); load();
  }

  return (
    <>
      <PageTitle title="Livraisons" subtitle="Le coursier fait les courses chez les fournisseurs : suivez-le en direct et changez la liste avec Jean">
        <Button loading={busy === "create"} onClick={() => call("create")}><Plus className="size-4" />Nouvelle tournée (démo)</Button>
      </PageTitle>

      {runs && runs.length === 0 && <Card><Empty>Aucune tournée. Créez-en une pour la démo.</Empty></Card>}

      {runs && runs.length > 0 && (
        <div className="mb-4 flex gap-2 overflow-x-auto pb-1">
          {runs.map((r) => (
            <button key={r.id} onClick={() => { setSel(r.id); setStatus(null); }}
              className={clsx("shrink-0 rounded-2xl border px-4 py-2 text-left text-sm", r.id === sel ? "border-ink bg-ink text-white" : "border-line bg-card")}>
              <p className="font-extrabold">{r.title}</p>
              <p className={clsx("text-xs", r.id === sel ? "text-lime" : "text-muted")}>{STATUS[r.id === sel && status ? status : r.status]} · {dateTime(r.created_at)}</p>
            </button>
          ))}
        </div>
      )}

      {run && (
        <>
          <div className="mb-4 flex flex-wrap items-center gap-2">
            {st === "prete" && <Button loading={busy === "start"} onClick={() => call("start")}><Play className="size-4" />Faire partir le coursier</Button>}
            {st === "livre" && <Button loading={busy === "receive"} onClick={receive}><PackageCheck className="size-4" />Réceptionner (le stock remonte)</Button>}
            {st === "receptionne" && <Badge tone="ok"><PackageCheck className="size-3" />Réceptionné</Badge>}
            <a href={`https://wa.me/?text=${encodeURIComponent(`🛵 Suivez les courses de la cantine en direct : ${link}`)}`} target="_blank" rel="noreferrer"
              className="flex h-11 items-center gap-2 rounded-full border border-line bg-card px-4 text-sm font-bold"><Share2 className="size-4" />Partager sur WhatsApp</a>
            <a href={link} target="_blank" rel="noreferrer" className="flex h-11 items-center gap-2 rounded-full border border-line bg-card px-4 text-sm font-bold"><ExternalLink className="size-4" />Page de suivi</a>
            <span className="ml-auto flex items-center gap-1.5 text-xs text-muted"><Bike className="size-4" />Coursier simulé : il avance toutes les 10 s</span>
          </div>
          <DeliveryTracker key={run.id} token={run.track_token} runId={run.id} teamBox onData={onData} />
        </>
      )}
    </>
  );
}
