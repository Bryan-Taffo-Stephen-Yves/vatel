"use client";
import { useCallback, useEffect, useState } from "react";
import QRCode from "qrcode";
import { IdCard, Plus, Printer } from "lucide-react";
import { edge, rpc, supabase } from "@/lib/supabase/client";
import { Badge, Card, Empty, input } from "@/components/admin/ui";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import { Qr } from "@/components/qr";
import { useToast } from "@/components/ui/toast";
import { fcfa } from "@/lib/format";

type Person = { id: string; full_name: string; short_code: string; phone: string | null; job: string; balance: number; meals: number; today: boolean };
type Overview = {
  settings: { school_share: number; start: string; end: string; per_day: number };
  price: number; totals: { meals: number; school: number; employees: number }; staff: Person[];
};
const JOBS: [string, string][] = [["entretien", "Entretien"], ["securite", "Sécurité"], ["administration", "Administration"], ["cuisine", "Cuisine"], ["autre", "Autre"]];
const jobLabel = (j: string) => JOBS.find(([v]) => v === j)?.[1] ?? j;

/** Carte imprimable : QR « DABALI:DB-xxxx » lu au comptoir, nom, fonction, conditions du repas. */
async function printCard(p: { full_name: string; short_code: string; job: string }, o: Overview) {
  const svg = await QRCode.toString(`DABALI:${p.short_code}`, { type: "svg", margin: 1, width: 220 });
  const emp = Math.max(o.price - o.settings.school_share, 0);
  const w = window.open("", "_blank", "width=420,height=640");
  if (!w) return;
  w.document.write(`<html><head><title>Carte ${p.short_code}</title><style>
    body{font-family:system-ui,sans-serif;margin:0;padding:24px;display:flex;justify-content:center}
    .c{width:320px;border:2px solid #16181D;border-radius:22px;padding:20px;text-align:center}
    h1{font-size:15px;margin:0 0 2px;letter-spacing:.04em}h2{font-size:20px;margin:10px 0 2px}
    .code{font:700 22px ui-monospace,monospace;margin:6px 0}.m{font-size:12px;color:#555;margin:4px 0}
    @media print{body{padding:0}}</style></head><body><div class="c">
    <h1>VATEL · REPAS DU PERSONNEL</h1>${svg}<h2>${p.full_name.replace(/</g, "")}</h2>
    <p class="m">${jobLabel(p.job)}</p><p class="code">${p.short_code}</p>
    <p class="m">Déjeuner de ${o.settings.start} à ${o.settings.end} · ${fcfa(emp)} (l'école paie ${fcfa(o.settings.school_share)})</p>
    </div><script>setTimeout(()=>print(),300)</script></body></html>`);
  w.document.close();
}

/**
 * Personnel de l'école (entretien, sécurité, administration…) : repas subventionné au comptoir.
 * L'admin l'inscrit (nouveau compte, ou compte existant), imprime sa carte QR, et suit le total payé par l'école.
 */
export function SchoolStaff() {
  const toast = useToast();
  const [o, setO] = useState<Overview | null>(null);
  const [adding, setAdding] = useState(false);
  const [card, setCard] = useState<Person | null>(null);
  const [form, setForm] = useState({ full_name: "", job: "entretien", phone: "" });
  const [busy, setBusy] = useState(false);
  const [q, setQ] = useState("");
  const [found, setFound] = useState<{ id: string; full_name: string; short_code: string }[]>([]);

  const load = useCallback(() => rpc<Overview>("staff_overview").then((r) => r.ok && setO(r as unknown as Overview)), []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!adding || q.length < 2) { setFound([]); return; }
    const t = setTimeout(() => supabase().rpc("admin_find_users", { p_query: q }).then(({ data }) => setFound((data ?? []) as typeof found)), 250);
    return () => clearTimeout(t);
  }, [q, adding]);

  async function create() {
    setBusy(true);
    const r = await edge<{ id: string; full_name: string; short_code: string; job: string }>("staff-create", form);
    setBusy(false);
    if (!r.ok) return toast("err", r.message);
    toast("ok", `${r.full_name} inscrit·e · carte ${r.short_code}`);
    setAdding(false); setForm({ full_name: "", job: "entretien", phone: "" });
    await load();
    setCard({ id: r.id, full_name: r.full_name, short_code: r.short_code, job: r.job, phone: null, balance: 0, meals: 0, today: false });
  }
  async function enroll(id: string) {
    const r = await rpc("staff_set", { p_user: id, p_job: form.job });
    if (!r.ok) return toast("err", r.message);
    toast("ok", "Compte inscrit au repas du personnel."); setAdding(false); setQ(""); load();
  }
  async function remove(p: Person) {
    if (!confirm(`Retirer ${p.full_name} du repas du personnel ? Son compte et son solde sont conservés.`)) return;
    const r = await rpc("staff_set", { p_user: p.id, p_job: null });
    if (!r.ok) return toast("err", r.message);
    load();
  }

  const emp = o ? Math.max(o.price - o.settings.school_share, 0) : 0;
  return (
    <Card title="Personnel de l'école · repas subventionné"
      subtitle={o ? `Déjeuner ${fcfa(o.price)} = école ${fcfa(o.settings.school_share)} + employé ${fcfa(emp)} · de ${o.settings.start} à ${o.settings.end}, ${o.settings.per_day} par jour` : "…"}
      action={<Button size="sm" variant="dark" onClick={() => setAdding(true)}><Plus className="size-4" />Ajouter</Button>}>
      {o && (
        <div className="mb-4 grid grid-cols-3 gap-2 text-center">
          <div className="rounded-2xl bg-canvas p-3"><p className="text-xl font-extrabold">{o.totals.meals}</p><p className="text-[11px] font-semibold text-muted">repas ce mois</p></div>
          <div className="rounded-2xl bg-lime p-3"><p className="text-xl font-extrabold">{fcfa(o.totals.school)}</p><p className="text-[11px] font-semibold">payé par l&apos;école</p></div>
          <div className="rounded-2xl bg-canvas p-3"><p className="text-xl font-extrabold">{fcfa(o.totals.employees)}</p><p className="text-[11px] font-semibold text-muted">payé par les employés</p></div>
        </div>
      )}
      {o && !o.staff.length && <Empty>Aucun membre du personnel inscrit. Ajoutez les agents d&apos;entretien, vigiles…</Empty>}
      <div className="divide-y divide-line">
        {o?.staff.map((p) => (
          <div key={p.id} className="flex items-center gap-3 py-3">
            <span className="grid size-10 shrink-0 place-items-center rounded-full bg-canvas text-sm font-extrabold">{p.full_name.split(" ").map((w) => w[0]).slice(0, 2).join("")}</span>
            <div className="min-w-0 flex-1">
              <p className="truncate font-bold">{p.full_name} {p.today && <Badge tone="ok">a mangé</Badge>}</p>
              <p className="text-xs text-muted">{jobLabel(p.job)} · {p.short_code} · solde {fcfa(p.balance)} · {p.meals} repas ce mois</p>
            </div>
            <button onClick={() => setCard(p)} className="flex items-center gap-1 text-xs font-bold"><IdCard className="size-4" />Carte</button>
            <button onClick={() => remove(p)} className="text-xs font-bold text-muted hover:text-err">Retirer</button>
          </div>
        ))}
      </div>

      <Sheet open={adding} onClose={() => setAdding(false)} title="Ajouter au repas du personnel">
        <div className="space-y-3">
          <input className={`${input} w-full`} placeholder="Nom complet" value={form.full_name} onChange={(e) => setForm({ ...form, full_name: e.target.value })} />
          <select className={`${input} w-full`} value={form.job} onChange={(e) => setForm({ ...form, job: e.target.value })}>
            {JOBS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          <input className={`${input} w-full`} inputMode="tel" placeholder="Téléphone (facultatif, pour WhatsApp)" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
          <Button block loading={busy} disabled={form.full_name.trim().length < 3} onClick={create}>Créer son compte et sa carte</Button>
          <p className="pt-2 text-xs font-semibold text-muted">Il a déjà un compte Vatel ? Cherchez-le (nom ou DB-…) :</p>
          <input className={`${input} w-full`} placeholder="Rechercher un compte existant" value={q} onChange={(e) => setQ(e.target.value)} />
          {found.map((u) => (
            <div key={u.id} className="flex items-center justify-between rounded-xl bg-canvas px-3 py-2">
              <span className="text-sm"><b>{u.full_name}</b> <span className="text-muted">{u.short_code}</span></span>
              <button onClick={() => enroll(u.id)} className="text-xs font-bold">Inscrire ({jobLabel(form.job)})</button>
            </div>
          ))}
        </div>
      </Sheet>

      <Sheet open={!!card} onClose={() => setCard(null)} title="Carte repas du personnel">
        {card && o && (
          <div className="text-center">
            <div className="mx-auto w-[240px] rounded-[22px] border-2 border-ink p-4">
              <p className="text-[11px] font-extrabold tracking-wide">VATEL · REPAS DU PERSONNEL</p>
              <Qr value={`DABALI:${card.short_code}`} size={200} className="mx-auto mt-2 w-[200px]" />
              <p className="mt-2 text-lg font-extrabold">{card.full_name}</p>
              <p className="text-xs text-muted">{jobLabel(card.job)}</p>
              <p className="mt-1 font-mono text-xl font-bold">{card.short_code}</p>
            </div>
            <p className="mt-3 text-xs text-muted">À présenter au comptoir de {o.settings.start} à {o.settings.end}. Le compte doit avoir au moins {fcfa(emp)} (recharge à la caisse).</p>
            <Button block className="mt-4" onClick={() => printCard(card, o)}><Printer className="size-4" />Imprimer la carte</Button>
          </div>
        )}
      </Sheet>
    </Card>
  );
}
