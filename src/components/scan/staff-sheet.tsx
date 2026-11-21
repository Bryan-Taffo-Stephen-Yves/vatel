"use client";
import { useEffect, useState } from "react";
import clsx from "clsx";
import { ArrowLeft, Clock, Search, X } from "lucide-react";
import { rpc } from "@/lib/supabase/client";
import { fetchMenu, soldOut } from "@/lib/menu";
import { fcfa, todayISO } from "@/lib/format";
import type { MenuItem } from "@/lib/types";

type Person = { id: string; full_name: string; short_code: string; job: string; balance: number; blocked: boolean; meals_today: number };
type Lookup = { window: { start: string; end: string; open: boolean }; results: Person[] };
const JOB: Record<string, string> = { entretien: "Entretien", securite: "Sécurité", administration: "Administration", cuisine: "Cuisine", autre: "Personnel" };

/**
 * Repas du personnel au comptoir : carte QR scannée (ou code / nom), choix du plat du déjeuner du jour,
 * part de l'employé débitée de son compte, part de l'école comptée. Créneau réservé (14h00–14h45 par défaut).
 */
export function StaffSheet({ initial, onClose, onServed }: {
  initial?: string; onClose: () => void; onServed: (msg: string) => void;
}) {
  const [q, setQ] = useState(initial ?? "");
  const [data, setData] = useState<Lookup | null>(null);
  const [who, setWho] = useState<Person | null>(null);
  const [menu, setMenu] = useState<MenuItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const id = setTimeout(async () => {
      const r = await rpc<Lookup>("staff_lookup", { p_query: q });
      if (!r.ok) return;
      setData(r as unknown as Lookup);
      // Carte scannée : une seule personne → on l'ouvre directement
      if (initial && q === initial && r.results.length === 1) setWho(r.results[0]);
    }, q === initial ? 0 : 300);
    return () => clearTimeout(id);
  }, [q, initial]);
  useEffect(() => {
    const d = todayISO();
    fetchMenu(d, d).then((items) => setMenu(items.filter((i) => i.service === "lunch")));
  }, []);

  async function serve(item: MenuItem) {
    if (!who || busy) return;
    setBusy(true); setErr(null);
    const r = await rpc<{ dish: string; full_name: string; employee_share: number; school_share: number; balance: number }>(
      "staff_meal_serve", { p_user: who.id, p_menu_item_id: item.id });
    setBusy(false);
    if (!r.ok) return setErr(r.message);
    onServed(`${r.full_name.split(" ")[0]} · ${r.dish} · ${fcfa(r.employee_share)} payés (école ${fcfa(r.school_share)})`);
  }

  const win = data?.window;
  return (
    <div className="fixed inset-0 z-40 flex items-end bg-black/60" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Repas du personnel"
        className="max-h-[92dvh] w-full overflow-y-auto rounded-t-[28px] bg-card p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] text-ink">
        <div className="flex items-center gap-2">
          {who && <button onClick={() => { setWho(null); setErr(null); }} aria-label="Retour" className="grid size-9 place-items-center rounded-full bg-canvas"><ArrowLeft className="size-4" /></button>}
          <p className="flex-1 text-lg font-extrabold">Repas du personnel</p>
          <button onClick={onClose} aria-label="Fermer" className="grid size-9 place-items-center rounded-full bg-canvas"><X className="size-4" /></button>
        </div>
        {win && (
          <p className={clsx("mt-3 flex items-center gap-2 rounded-2xl px-3 py-2 text-[13px] font-bold", win.open ? "bg-ok-soft text-[#15803d]" : "bg-warn-soft text-[#b45309]")}>
            <Clock className="size-4" />Créneau du personnel {win.start} – {win.end} · {win.open ? "ouvert" : "fermé"}
          </p>
        )}

        {!who && (
          <>
            <label className="mt-4 flex h-12 items-center gap-2 rounded-2xl border border-line px-3">
              <Search className="size-4 text-muted" />
              <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Code de la carte (DB-…) ou nom"
                className="h-full flex-1 bg-transparent text-[16px] font-semibold outline-none" />
            </label>
            <div className="mt-3 space-y-2">
              {data?.results.map((p) => (
                <button key={p.id} onClick={() => setWho(p)} className="flex w-full items-center justify-between rounded-2xl bg-canvas px-4 py-3 text-left">
                  <span><b>{p.full_name}</b><span className="block text-xs text-muted">{JOB[p.job] ?? p.job} · {p.short_code}</span></span>
                  <span className="text-sm font-bold">{fcfa(p.balance)}</span>
                </button>
              ))}
              {q.trim().length >= 3 && data && !data.results.length && <p className="py-4 text-center text-sm text-muted">Personne du personnel ne correspond.</p>}
            </div>
          </>
        )}

        {who && (
          <>
            <div className="mt-4 rounded-2xl bg-canvas p-4">
              <p className="text-xl font-extrabold">{who.full_name}</p>
              <p className="text-sm text-muted">{JOB[who.job] ?? who.job} · {who.short_code} · solde <b className="text-ink">{fcfa(who.balance)}</b></p>
              {who.meals_today > 0 && <p className="mt-1 text-sm font-bold text-err">A déjà pris son repas aujourd&apos;hui.</p>}
            </div>
            {err && <p className="mt-3 rounded-2xl bg-err-soft px-3 py-2 text-sm font-bold text-err">{err}</p>}
            <p className="mb-2 mt-4 text-sm font-extrabold">Plat du déjeuner</p>
            <div className="space-y-2">
              {menu.map((i) => (
                <button key={i.id} disabled={busy || soldOut(i)} onClick={() => serve(i)}
                  className={clsx("flex w-full items-center justify-between rounded-2xl border-2 px-4 py-3 text-left font-bold",
                    soldOut(i) ? "border-transparent bg-canvas text-off" : "border-line active:border-ink")}>
                  {i.dish?.name}<span className="text-xs text-muted">{soldOut(i) ? "épuisé" : "servir"}</span>
                </button>
              ))}
              {!menu.length && <p className="py-4 text-center text-sm text-muted">Pas de menu du déjeuner publié aujourd&apos;hui.</p>}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
