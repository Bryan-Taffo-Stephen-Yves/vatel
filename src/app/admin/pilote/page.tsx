"use client";
// Pilote du service : l'écran du PC de la cuisine pendant le service. Il lit en direct le rythme du comptoir,
// les portions restantes, la file d'attente, les commandes prêtes et les assiettes laissées, propose les actions
// utiles (relancer des portions, mettre un plat en avant, renfort au comptoir, relancer les commandes prêtes)
// et répond à voix haute aux questions du chef (« combien de garba je relance ? »).
import { useCallback, useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { BellRing, ChefHat, Flame, Loader2, Megaphone, Mic, Minus, Plus, Sparkles, Users, Utensils, Volume2, VolumeX, X } from "lucide-react";
import { edge, rpc } from "@/lib/supabase/client";
import { Badge, Card, Kpi, PageTitle } from "@/components/admin/ui";
import { DishImage } from "@/components/app/dish-image";
import { CloudBubble } from "@/components/chef";
import { useToast } from "@/components/ui/toast";
import { useStaff } from "@/components/admin/admin-shell";
import { sfx } from "@/lib/sfx";
import { SERVICE_LABEL, time } from "@/lib/format";

type Item = { id: string; name: string; photo_url: string | null; planned: number | null; sold: number; remaining: number | null;
  sold_out: boolean; served: number; served_15: number; rate: number; runout_min: number | null; need: number; left_pct: number | null; scans: number };
type Sugg = { kind: "more" | "push_dish" | "queue" | "remind_ready" | "left"; ref: string; priority: number; qty?: number; title: string; text: string };
type State = {
  ok: boolean; status: "open" | "closed"; message?: string; next?: { service: string; starts_at: string } | null;
  service?: string; ends_at?: string; minutes_left?: number; served?: number; served_15?: number;
  queue_count?: number | null; wait_min?: number | null; level?: string; ready_waiting?: number;
  items?: Item[]; suggestions?: Sugg[]; recent?: { kind: string; qty: number | null; done: number | null; at: string }[];
};

const KIND = {
  more: { icon: Flame, tone: "bg-err-soft", btn: "Relancer" },
  queue: { icon: Users, tone: "bg-warn-soft", btn: "Appeler un renfort" },
  remind_ready: { icon: BellRing, tone: "bg-warn-soft", btn: "Relancer les élèves" },
  push_dish: { icon: Megaphone, tone: "bg-lime-soft", btn: "Prévenir les élèves" },
  left: { icon: Utensils, tone: "bg-canvas", btn: "Vu" },
} as const;
const DONE: Record<string, string> = { more: "portions relancées", push_dish: "élèves prévenus", queue: "renfort appelé", remind_ready: "élèves relancés", left: "vu" };

const hm = (min: number) => (min >= 60 ? `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, "0")}` : `${min} min`);
const at = (min: number) => time(new Date(Date.now() + min * 60_000).toISOString());

export default function ServicePilot() {
  const toast = useToast();
  const me = useStaff();
  const isChef = me?.role === "chef" || me?.role === "admin";
  const [s, setS] = useState<State | null>(null);
  const [qty, setQty] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => rpc<State>("pilot_state").then((r) => setS(r as unknown as State)), []);
  useEffect(() => {
    load();
    const id = setInterval(() => { if (!document.hidden) load(); }, 20_000);   // le service bouge vite : toutes les 20 s
    return () => clearInterval(id);
  }, [load]);

  async function act(g: Sugg, dismiss = false) {
    const key = g.kind + g.ref;
    setBusy(key);
    const r = await rpc<{ done: number }>("pilot_act", dismiss
      ? { p_kind: "dismiss", p_ref: g.ref }
      : { p_kind: g.kind, p_ref: g.ref, p_qty: g.kind === "more" ? (qty[key] ?? g.qty) : null });
    setBusy(null);
    if (!r.ok) return toast("err", r.message);
    if (!dismiss) {
      sfx.success();
      toast("ok", g.kind === "more" ? `+${r.done} ${DONE.more}` : g.kind === "left" ? "Noté." : `${r.done} ${DONE[g.kind]}`);
    }
    load();
  }

  if (!s) return <><PageTitle title="Pilote du service" /><div className="h-96 animate-pulse rounded-[22px] bg-card" /></>;
  if (!s.ok) return <><PageTitle title="Pilote du service" /><Card><p className="text-sm text-muted">{s.message}</p></Card></>;

  if (s.status === "closed") return (
    <>
      <PageTitle title="Pilote du service" />
      <section className="flex items-end gap-4 overflow-hidden rounded-[22px] bg-ink px-5 pt-6 text-white">
                <CloudBubble tail="left" className="mb-8 max-w-lg text-left">
          <p className="text-[15px] font-bold">Aucun service en cours. Je reprends la main dès l&apos;ouverture
            {s.next ? ` : ${SERVICE_LABEL[s.next.service]} à ${time(s.next.starts_at)}.` : "."}</p>
        </CloudBubble>
      </section>
    </>
  );

  const items = s.items ?? [];
  const sugg = s.suggestions ?? [];
  return (
    <>
      <PageTitle title="Pilote du service" subtitle={`${SERVICE_LABEL[s.service!]} · fin à ${time(s.ends_at!)} · encore ${hm(s.minutes_left ?? 0)}`}>
        <Badge tone="ok"><span className="size-2 animate-pulse rounded-full bg-ok" />En direct · mis à jour toutes les 20 s</Badge>
      </PageTitle>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi tone="dark" label="Repas servis" value={String(s.served ?? 0)} hint={`${s.served_15 ?? 0} ces 15 dernières minutes`} />
        <Kpi tone="lime" label="File d'attente" value={s.queue_count != null ? String(s.queue_count) : "—"} hint={s.wait_min != null ? `~${s.wait_min} min d'attente` : "caméra éteinte"} />
        <Kpi label="Commandes prêtes en attente" value={String(s.ready_waiting ?? 0)} hint="depuis plus de 10 min" />
        <Kpi label="Plats qui vont manquer" value={String(items.filter((i) => i.runout_min != null && i.runout_min < (s.minutes_left ?? 0) - 10).length)} hint="avant la fin du service" />
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
        {/* Actions proposées : le cœur de l'écran */}
        <Card title="À faire maintenant" subtitle={sugg.length ? "Le plus urgent en premier. Une action faite ou écartée ne revient pas pendant 20 min." : undefined}>
          {sugg.length === 0 ? (
            <div className="flex items-center gap-4 rounded-2xl bg-ok-soft p-4">
                            <p className="font-bold text-[#15803d]">Tout roule : rien à signaler pour le moment. 👌</p>
            </div>
          ) : (
            <ul className="space-y-3">
              {sugg.map((g) => {
                const k = KIND[g.kind]; const key = g.kind + g.ref; const Icon = k.icon;
                const n = qty[key] ?? g.qty ?? 0;
                const blocked = g.kind === "more" && !isChef;
                return (
                  <li key={key} className={clsx("animate-rise rounded-2xl p-4", k.tone)}>
                    <div className="flex items-start gap-3">
                      <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-white"><Icon className="size-5" /></span>
                      <div className="min-w-0 flex-1">
                        <p className="font-extrabold">{g.title}</p>
                        <p className="mt-0.5 text-sm text-ink-2">{g.text}</p>
                      </div>
                      <button onClick={() => act(g, true)} aria-label="Écarter" className="grid size-8 shrink-0 place-items-center rounded-full text-muted hover:bg-white"><X className="size-4" /></button>
                    </div>
                    <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
                      {g.kind === "more" && (
                        <span className="flex items-center gap-1.5 rounded-full bg-white px-1.5 py-1">
                          <button aria-label="Moins" onClick={() => setQty((q) => ({ ...q, [key]: Math.max(5, n - 5) }))} className="grid size-7 place-items-center rounded-full bg-canvas"><Minus className="size-3.5" /></button>
                          <span className="w-24 whitespace-nowrap text-center text-sm font-extrabold">+{n} portions</span>
                          <button aria-label="Plus" onClick={() => setQty((q) => ({ ...q, [key]: Math.min(200, n + 5) }))} className="grid size-7 place-items-center rounded-full bg-canvas"><Plus className="size-3.5" /></button>
                        </span>
                      )}
                      <button disabled={busy === key || blocked} onClick={() => act(g)} title={blocked ? "Réservé à la cuisine" : undefined}
                        className="flex h-10 items-center gap-2 rounded-full bg-ink px-4 text-sm font-extrabold text-white transition active:scale-[0.98] disabled:opacity-50">
                        {busy === key ? <Loader2 className="size-4 animate-spin" /> : <ChefHat className="size-4 text-lime" />}
                        {g.kind === "push_dish" || g.kind === "remind_ready" ? `${k.btn} (${g.qty})` : k.btn}
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
          {(s.recent ?? []).length > 0 && (
            <p className="mt-4 text-xs font-semibold text-muted">Déjà fait : {(s.recent ?? []).map((a) => `${time(a.at)} ${a.kind === "more" ? `+${a.done} portions` : `${a.done ?? ""} ${DONE[a.kind] ?? a.kind}`}`).join(" · ")}</p>
          )}
        </Card>

        <AskPilot />
      </div>

      {/* Plats du service */}
      <Card title="Plats du service" subtitle="Restant, rythme du comptoir et heure à laquelle il n'en restera plus" className="mt-4" pad={false}>
        <div className="overflow-x-auto px-5 pb-5">
          <table className="w-full min-w-[640px] text-sm">
            <thead><tr className="text-left text-xs font-bold text-muted">
              <th className="py-2">Plat</th><th>Restant</th><th>Rythme</th><th>Il n&apos;en restera plus</th><th>Assiettes</th>
            </tr></thead>
            <tbody className="divide-y divide-line">
              {items.map((i) => {
                const short = i.runout_min != null && i.runout_min < (s.minutes_left ?? 0) - 10;
                const pct = i.planned ? Math.round(((i.remaining ?? 0) / i.planned) * 100) : 100;
                return (
                  <tr key={i.id}>
                    <td className="py-2.5"><span className="flex items-center gap-2.5"><DishImage name={i.name} src={i.photo_url} className="size-9 shrink-0" rounded="rounded-xl" /><b>{i.name}</b></span></td>
                    <td className="w-40">
                      {i.remaining == null ? <span className="text-muted">illimité</span> : (
                        <span className="block">
                          <b>{i.remaining}</b><span className="text-muted"> / {i.planned}</span>
                          <span className="mt-1 block h-1.5 w-28 overflow-hidden rounded-full bg-canvas"><span className={clsx("block h-full rounded-full", pct < 20 ? "bg-err" : pct < 50 ? "bg-warn" : "bg-ok")} style={{ width: `${pct}%` }} /></span>
                        </span>
                      )}
                    </td>
                    <td>{Math.round(i.rate * 15)} <span className="text-muted">/ 15 min</span></td>
                    <td>{i.runout_min == null ? <span className="text-muted">—</span> : <Badge tone={short ? "err" : "gray"}>{i.remaining === 0 ? "épuisé" : `vers ${at(i.runout_min)}`}</Badge>}</td>
                    <td>{i.left_pct != null ? <Badge tone={i.left_pct >= 35 ? "warn" : "gray"}>{i.left_pct} % laissé</Badge> : <span className="text-muted">—</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
}

/** « Demande au pilote » : à l'écrit ou à la voix (micro du PC), réponse lue à voix haute */
function AskPilot() {
  const [q, setQ] = useState("");
  const [answer, setAnswer] = useState<string | null>(null);
  const [thinking, setThinking] = useState(false);
  const [listening, setListening] = useState(false);
  const [voice, setVoice] = useState(true);
  const rec = useRef<{ start: () => void; stop: () => void } | null>(null);
  type SR = new () => { lang: string; interimResults: boolean; onresult: (e: { results: { 0: { transcript: string } }[] }) => void; onend: () => void; onerror: () => void; start: () => void; stop: () => void };
  const SRClass = typeof window !== "undefined" ? ((window as unknown as { SpeechRecognition?: SR; webkitSpeechRecognition?: SR }).SpeechRecognition
    ?? (window as unknown as { webkitSpeechRecognition?: SR }).webkitSpeechRecognition) : undefined;

  const speak = (text: string) => {
    if (!voice || !("speechSynthesis" in window)) return;
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text); u.lang = "fr-FR"; u.rate = 1.05;
    const fr = window.speechSynthesis.getVoices().find((v) => v.lang.startsWith("fr")); if (fr) u.voice = fr;
    window.speechSynthesis.speak(u);
  };
  async function ask(question: string) {
    setThinking(true); setAnswer(null);
    const r = await edge<{ answer: string }>("service-pilot", { question });
    setThinking(false);
    const text = r.ok ? r.answer : r.message;
    setAnswer(text); if (r.ok) speak(text);
  }
  function listen() {
    if (!SRClass) return;
    const r = new SRClass(); r.lang = "fr-FR"; r.interimResults = false;
    r.onresult = (e) => { const t = e.results[0][0].transcript; setQ(t); ask(t); };
    r.onend = () => setListening(false); r.onerror = () => setListening(false);
    rec.current = r; setListening(true); r.start();
  }

  return (
    <Card title="Demande au pilote" subtitle="Il répond avec les chiffres du service, à voix haute"
      action={<button onClick={() => setVoice((v) => !v)} aria-label={voice ? "Couper la voix" : "Activer la voix"} className="grid size-8 place-items-center rounded-full bg-canvas">{voice ? <Volume2 className="size-4" /> : <VolumeX className="size-4" />}</button>}>
      <div className="flex items-end gap-2 rounded-2xl bg-ink px-3 pt-4">
                <CloudBubble tail="left" className="mb-6 min-w-0 flex-1 text-left">
          {thinking ? <p className="flex items-center gap-2 text-sm font-bold text-muted"><Loader2 className="size-4 animate-spin" />Je regarde le service…</p>
            : <p className="text-[15px] font-bold leading-snug">{answer ?? "Pose-moi une question sur le service, ou touche « Faire le point »."}</p>}
        </CloudBubble>
      </div>
      <form className="mt-3 flex gap-2" onSubmit={(e) => { e.preventDefault(); if (q.trim()) ask(q.trim()); }}>
        <input value={q} onChange={(e) => setQ(e.target.value)} maxLength={300} placeholder="Ex. : combien de garba je relance ?"
          className="h-11 min-w-0 flex-1 rounded-full border border-line bg-canvas px-4 text-sm outline-none focus:border-ink" />
        {SRClass && (
          <button type="button" onClick={() => (listening ? rec.current?.stop() : listen())} aria-label="Poser la question à voix haute"
            className={clsx("grid size-11 shrink-0 place-items-center rounded-full", listening ? "animate-pulse bg-err text-white" : "bg-canvas")}><Mic className="size-5" /></button>
        )}
      </form>
      <button onClick={() => ask("")} disabled={thinking} className="mt-2 flex h-11 w-full items-center justify-center gap-2 rounded-full bg-lime text-sm font-extrabold text-ink disabled:opacity-50">
        <Sparkles className="size-4" />Faire le point
      </button>
    </Card>
  );
}
