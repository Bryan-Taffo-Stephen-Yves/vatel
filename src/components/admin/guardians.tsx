"use client";
import { useState } from "react";
import { Search, Trash2, UserCheck } from "lucide-react";
import { rpc } from "@/lib/supabase/client";
import { Badge, Card, input } from "@/components/admin/ui";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";

type Phone = { phone: string; label: string | null; linked: boolean };
type Data = { child: { id: string; name: string; short_code: string }; phones: Phone[] };
const pretty = (p: string) => p.replace(/^\+225(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/, "$1 $2 $3 $4 $5");

/**
 * Parents des élèves : l'école enregistre le ou les numéros officiels des parents (dossier d'inscription).
 * Seul un compte parent dont le WhatsApp vérifié correspond à l'un de ces numéros peut suivre et recharger l'élève :
 * un ami ne peut pas se faire passer pour un parent.
 */
export function Guardians() {
  const toast = useToast();
  const [code, setCode] = useState("");
  const [d, setD] = useState<Data | null>(null);
  const [phone, setPhone] = useState("");
  const [label, setLabel] = useState("Mère");
  const [busy, setBusy] = useState(false);

  async function find() {
    const r = await rpc<Data>("guardian_list", { p_child_code: code });
    if (!r.ok) { setD(null); return toast("err", r.message); }
    setD(r as unknown as Data);
  }
  async function save(p: string, remove = false) {
    if (!d) return;
    if (remove && !confirm(`Retirer ${pretty(p)} ? Ce parent ne pourra plus suivre ${d.child.name}.`)) return;
    setBusy(true);
    const r = await rpc<Data>("guardian_set", { p_child_code: d.child.short_code, p_phone: p, p_label: label, p_remove: remove });
    setBusy(false);
    if (!r.ok) return toast("err", r.message);
    setD(r as unknown as Data); setPhone("");
    toast("ok", remove ? "Numéro retiré." : "Numéro du parent enregistré.");
  }

  return (
    <Card title="Parents des élèves" subtitle="Numéros officiels du dossier d'inscription : seuls ces parents peuvent suivre et recharger l'élève">
      <form onSubmit={(e) => { e.preventDefault(); find(); }} className="flex gap-2">
        <input className={`${input} min-w-0 flex-1`} placeholder="Code de l'élève (DB-…)" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} />
        <Button size="sm" variant="dark" disabled={code.length < 6}><Search className="size-4" />Chercher</Button>
      </form>
      {d && (
        <div className="mt-4">
          <p className="font-bold">{d.child.name} <span className="text-xs text-muted">{d.child.short_code}</span></p>
          <div className="mt-2 divide-y divide-line">
            {d.phones.map((p) => (
              <div key={p.phone} className="flex items-center gap-3 py-2.5">
                <span className="flex-1 text-sm"><b>{pretty(p.phone)}</b> <span className="text-muted">{p.label ?? ""}</span></span>
                {p.linked ? <Badge tone="ok"><UserCheck className="size-3" />suit l&apos;élève</Badge> : <Badge>pas encore relié</Badge>}
                <button onClick={() => save(p.phone, true)} aria-label="Retirer" className="text-muted hover:text-err"><Trash2 className="size-4" /></button>
              </div>
            ))}
            {!d.phones.length && <p className="py-2 text-sm text-muted">Aucun numéro de parent enregistré : personne ne peut suivre cet élève.</p>}
          </div>
          <form onSubmit={(e) => { e.preventDefault(); save(phone); }} className="mt-3 flex flex-wrap gap-2">
            <input className={`${input} min-w-0 flex-1`} inputMode="tel" placeholder="Numéro du parent (07 …)" value={phone} onChange={(e) => setPhone(e.target.value)} />
            <select className={input} value={label} onChange={(e) => setLabel(e.target.value)}>
              {["Mère", "Père", "Tuteur", "Tutrice"].map((l) => <option key={l}>{l}</option>)}
            </select>
            <Button size="sm" loading={busy} disabled={phone.replace(/\D/g, "").length < 8}>Enregistrer</Button>
          </form>
          <p className="mt-2 text-xs text-muted">Le parent crée ensuite un compte « parent » et relie ce WhatsApp à Jean : il peut alors entrer le code de l&apos;élève.</p>
        </div>
      )}
    </Card>
  );
}
