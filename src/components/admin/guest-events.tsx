"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import clsx from "clsx";
import QRCode from "qrcode";
import { Printer, Plus, Trash2, Users, Check } from "lucide-react";
import { rpc, supabase } from "@/lib/supabase/client";
import { Card, Badge, Empty, input } from "@/components/admin/ui";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { useStaff } from "@/components/admin/admin-shell";
import { escapeHtml } from "@/lib/html";
import { fcfa, todayISO, dayLong } from "@/lib/format";
import { SERVICES, type ServiceKind } from "@/lib/types";

type Dish = { menu_item_id: string; name: string; qty: number };
type Ev = { id: string; name: string; service_date: string; service: ServiceKind; service_label: string; guests: number; unit_price: number;
  dishes: Dish[]; note: string | null; cancelled_at: string | null; used: number; valid: number; returned: number };
type Overview = { budget: number; engaged: number; remaining: number; spent: number; prices: Record<ServiceKind, number>; events: Ev[] };
type Voucher = { seq: number; status: string; code: string };

const LABEL: Record<ServiceKind, string> = { breakfast: "Petit-déjeuner", lunch: "Déjeuner", snack: "Snack", dinner: "Dîner" };

/** Réceptions : délégations et visites officielles, repas payés par le budget de l'école (un QR imprimé par invité). */
export function GuestEvents() {
  const toast = useToast();
  const me = useStaff();
  const [o, setO] = useState<Overview | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [f, setF] = useState({ name: "", date: todayISO(), service: "lunch" as ServiceKind, guests: "10", note: "" });
  const [menu, setMenu] = useState<{ id: string; name: string }[]>([]);
  const [plan, setPlan] = useState<Record<string, string>>({});
  const [budget, setBudget] = useState("");

  const load = useCallback(async () => {
    const r = await rpc<Overview>("guest_overview");
    if (r.ok) { setO(r); setBudget(String(r.budget)); }
  }, []);
  useEffect(() => { load(); }, [load]);

  // Plats au menu du jour et du repas choisis (pour prévoir ce que mangera la délégation)
  useEffect(() => {
    if (!open) return;
    setPlan({});
    supabase().from("menu_items").select("id, dish:dishes(name)").eq("service_date", f.date).eq("service", f.service)
      .then(({ data }) => setMenu((data ?? []).map((m) => ({ id: m.id as string, name: (m.dish as unknown as { name: string } | null)?.name ?? "?" }))));
  }, [open, f.date, f.service]);

  const guests = Math.max(0, parseInt(f.guests, 10) || 0);
  const cost = guests * (o?.prices?.[f.service] ?? 0);
  const planned = useMemo(() => Object.values(plan).reduce((s, v) => s + (parseInt(v, 10) || 0), 0), [plan]);

  async function create() {
    setBusy("create");
    const dishes = Object.entries(plan).map(([id, v]) => ({ menu_item_id: id, qty: parseInt(v, 10) || 0 })).filter((d) => d.qty > 0);
    const r = await rpc<{ event_id: string }>("guest_event_create", { p_name: f.name, p_date: f.date, p_service: f.service, p_guests: guests,
      p_dishes: dishes, p_note: f.note || null });
    setBusy(null);
    if (!r.ok) return toast("err", r.message);
    toast("ok", `${guests} bon(s) invité créés : touchez « QR » pour imprimer la feuille.`);
    setOpen(false); setF({ ...f, name: "", note: "" });
    load();
  }

  async function cancel(e: Ev) {
    if (!confirm(`Annuler « ${e.name} » ? Les ${e.valid} bon(s) non utilisés seront rendus au budget.`)) return;
    setBusy(e.id);
    const r = await rpc<{ cancelled: number }>("guest_event_cancel", { p_event: e.id });
    setBusy(null);
    if (!r.ok) return toast("err", r.message);
    toast("ok", `${r.cancelled} bon(s) annulés et rendus au budget.`); load();
  }

  async function saveBudget() {
    const r = await rpc("guest_budget_set", { p_monthly: parseInt(budget, 10) || 0 });
    if (!r.ok) return toast("err", r.message);
    toast("ok", "Budget Réceptions enregistré."); load();
  }

  return (
    <Card className="mt-4" title="Réceptions · bons invités" subtitle="Délégations, visites officielles : repas payés par l'école, un QR imprimé par invité"
      action={<Button size="sm" onClick={() => setOpen((v) => !v)}><Plus className="size-4" />Nouvel événement</Button>}>
      {o && (
        <div className="mb-4 flex flex-wrap items-center gap-2 text-sm">
          <Badge tone="dark">Budget du mois {fcfa(o.budget)}</Badge>
          <Badge tone={o.remaining < o.budget * 0.15 ? "warn" : "ok"}>Reste {fcfa(o.remaining)}</Badge>
          <span className="text-xs text-muted">dont {fcfa(o.spent)} déjà servis · un bon non utilisé revient au budget</span>
          {me?.role === "admin" && (
            <span className="ml-auto flex items-center gap-2">
              <input type="number" min={0} value={budget} onChange={(e) => setBudget(e.target.value)} className={clsx(input, "h-9 w-32 text-right")} aria-label="Budget mensuel des réceptions" />
              <Button size="sm" variant="dark" onClick={saveBudget}>Enregistrer</Button>
            </span>
          )}
        </div>
      )}

      {open && (
        <div className="mb-4 grid gap-3 rounded-2xl border border-line p-4 sm:grid-cols-2">
          <label className="text-sm font-bold sm:col-span-2">Événement
            <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} maxLength={80} placeholder="Visite du ministère" className={clsx(input, "mt-1 w-full")} />
          </label>
          <label className="text-sm font-bold">Jour
            <input type="date" value={f.date} min={todayISO()} onChange={(e) => setF({ ...f, date: e.target.value })} className={clsx(input, "mt-1 w-full")} />
          </label>
          <label className="text-sm font-bold">Repas
            <select value={f.service} onChange={(e) => setF({ ...f, service: e.target.value as ServiceKind })} className={clsx(input, "mt-1 w-full")}>
              {SERVICES.map((s) => <option key={s} value={s}>{LABEL[s]} · {fcfa(o?.prices?.[s] ?? 0)}</option>)}
            </select>
          </label>
          <label className="text-sm font-bold">Nombre d&apos;invités
            <input type="number" min={1} max={300} value={f.guests} onChange={(e) => setF({ ...f, guests: e.target.value })} className={clsx(input, "mt-1 w-full")} />
          </label>
          <label className="text-sm font-bold">Note pour la cuisine (facultatif)
            <input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} maxLength={300} placeholder="Ministre + 9 conseillers, servir à 12h30" className={clsx(input, "mt-1 w-full")} />
          </label>
          <div className="sm:col-span-2">
            <p className="mb-1 text-sm font-bold">Plats prévus (facultatif) {planned > 0 && <span className="font-normal text-muted">· {planned}/{guests}</span>}</p>
            {menu.length === 0 ? <p className="text-xs text-muted">Pas encore de menu pour ce repas : l&apos;agent choisira le plat au comptoir.</p> : (
              <ul className="grid gap-1.5 sm:grid-cols-2">
                {menu.map((m) => (
                  <li key={m.id} className="flex items-center gap-2 text-sm">
                    <input type="number" min={0} value={plan[m.id] ?? ""} placeholder="0" onChange={(e) => setPlan({ ...plan, [m.id]: e.target.value })}
                      className={clsx(input, "h-9 w-16 text-right")} aria-label={`Portions de ${m.name}`} />
                    <span>{m.name}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2 sm:col-span-2">
            <Button loading={busy === "create"} disabled={!f.name.trim() || guests < 1} onClick={create}>
              <Check className="size-4" />Créer {guests} bon{guests > 1 ? "s" : ""} · {fcfa(cost)}
            </Button>
            <Button variant="ghost" onClick={() => setOpen(false)}>Fermer</Button>
          </div>
        </div>
      )}

      {!o ? null : o.events.length === 0 ? <Empty>Aucune réception ce mois-ci</Empty> : (
        <ul className="divide-y divide-line">
          {o.events.map((e) => (
            <li key={e.id} className="flex flex-wrap items-center gap-3 py-3">
              <span className="min-w-0 flex-1 basis-full sm:basis-0">
                <span className="block font-extrabold">{e.name}</span>
                <span className="block text-xs text-muted">{dayLong(e.service_date)} · {e.service_label} · {fcfa(e.guests * e.unit_price)}
                  {e.dishes.length > 0 && <> · {e.dishes.map((d) => `${d.qty} ${d.name}`).join(", ")}</>}</span>
              </span>
              <Badge tone={e.cancelled_at ? "gray" : "lime"}><Users className="size-3" />{e.used} servi{e.used > 1 ? "s" : ""} / {e.guests}</Badge>
              {e.returned > 0 && <Badge tone="gray">{e.returned} rendu{e.returned > 1 ? "s" : ""} au budget</Badge>}
              {!e.cancelled_at && e.valid > 0 && (
                <>
                  <Button size="sm" variant="outline" onClick={() => printVouchers(e.id)}><Printer className="size-4" />QR</Button>
                  <Button size="sm" variant="ghost" loading={busy === e.id} onClick={() => cancel(e)} aria-label={`Annuler ${e.name}`}><Trash2 className="size-4" /></Button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/** Feuille A4 : un QR par invité encore valable (texte échappé : le nom vient de la saisie). */
async function printVouchers(eventId: string) {
  const w = window.open("", "_blank", "width=820,height=900");
  const r = await rpc<{ event: { name: string; day: string; service_label: string; dishes: Dish[] }; vouchers: Voucher[] }>("guest_event_vouchers", { p_event: eventId });
  if (!w) return;
  if (!r.ok || !Array.isArray(r.vouchers)) { w.close(); return; }
  const list = r.vouchers.filter((v) => v.status === "valid");
  const svgs = await Promise.all(list.map((v) => QRCode.toString(v.code, { type: "svg", margin: 1, width: 180, errorCorrectionLevel: "M" })));
  const name = escapeHtml(r.event.name);
  w.document.write(`<html><head><title>Bons invités · ${name}</title><style>
    body{font-family:system-ui,sans-serif;margin:0;padding:16px;color:#111}
    h1{font-size:18px;margin:0 0 2px}.sub{font-size:12px;color:#555;margin-bottom:12px}
    .g{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}
    .c{border:1px dashed #999;border-radius:12px;padding:10px;text-align:center;break-inside:avoid}
    .c svg{width:150px;height:150px}.t{font-weight:800;font-size:13px}.s{font-size:11px;color:#444}
    @media print{body{padding:8mm}}</style></head><body>
    <h1>Vatel · Cantine — ${name}</h1>
    <div class="sub">${escapeHtml(r.event.day)} · ${escapeHtml(r.event.service_label)} · ${list.length} invité(s) · repas offert par l'école, à présenter au comptoir</div>
    <div class="g">${list.map((v, i) => `<div class="c">${svgs[i]}<div class="t">Invité n° ${v.seq}</div><div class="s">${name}</div><div class="s">${escapeHtml(r.event.service_label)} · ${escapeHtml(r.event.day)}</div></div>`).join("")}</div>
    <script>setTimeout(()=>print(),300)</script></body></html>`);
  w.document.close();
}
