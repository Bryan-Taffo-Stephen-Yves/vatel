"use client";
import { useCallback, useEffect, useState } from "react";
import clsx from "clsx";
import { Plus, Upload, Trash2, Search, Sparkles } from "lucide-react";
import { edge, supabase } from "@/lib/supabase/client";
import { PageTitle, Badge, input } from "@/components/admin/ui";
import { DishImage } from "@/components/app/dish-image";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import { useToast } from "@/components/ui/toast";
import { fcfa } from "@/lib/format";
import type { Dish } from "@/lib/types";

type Cat = { id: number; name: string };
type Ing = { id: string; name: string; unit: string };
type Line = { ingredient_id: string; qty_per_portion: number };
import { ALLERGIES, DISH_TAGS } from "@/lib/diet";
type D = Dish & { is_active: boolean; popularity_prior: number };
const EMPTY: Partial<D> = { photo_credit: null, photo_source: null, name: "", description: "", composition: "", kcal: null, weight_g: null, allergens: [], base_price: 2000, is_active: true, category_id: null, photo_url: null, popularity_prior: 1 };

export default function DishesPage() {
  const toast = useToast();
  const [dishes, setDishes] = useState<D[]>([]);
  const [cats, setCats] = useState<Cat[]>([]);
  const [ings, setIngs] = useState<Ing[]>([]);
  const [edit, setEdit] = useState<Partial<D> | null>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [ai, setAi] = useState<{ busy: boolean; text: string | null }>({ busy: false, text: null });

  // L'IA propose allergènes, traces et étiquettes à partir du nom et de la composition ; le chef relit puis enregistre
  async function suggestAllergens() {
    if (!edit?.name) return toast("err", "Écris d'abord le nom du plat.");
    setAi({ busy: true, text: null });
    const r = await edge<{ allergens: string[]; traces: string[]; diet_tags: string[]; explanation: string }>("dish-allergens",
      { name: edit.name, composition: edit.composition ?? "", description: edit.description ?? "" });
    if (!r.ok) { setAi({ busy: false, text: null }); return toast("err", r.message); }
    setEdit((e) => e && ({ ...e, allergens: r.allergens, traces: r.traces, diet_tags: r.diet_tags }));
    setAi({ busy: false, text: r.explanation });
  }
  // Allergène : rien → contient → traces possibles → rien
  const cycleAllergen = (a: string) => setEdit((e) => {
    if (!e) return e;
    const has = (e.allergens ?? []).includes(a), tr = (e.traces ?? []).includes(a);
    if (!has && !tr) return { ...e, allergens: [...(e.allergens ?? []), a] };
    if (has) return { ...e, allergens: (e.allergens ?? []).filter((x) => x !== a), traces: [...(e.traces ?? []), a] };
    return { ...e, traces: (e.traces ?? []).filter((x) => x !== a) };
  });

  const load = useCallback(async () => {
    const sb = supabase();
    const [d, c, i] = await Promise.all([
      sb.from("dishes").select("*").order("name"),
      sb.from("categories").select("id, name").order("sort"),
      sb.from("ingredients").select("id, name, unit").order("name"),
    ]);
    setDishes((d.data ?? []) as D[]); setCats(c.data ?? []); setIngs(i.data ?? []);
  }, []);
  useEffect(() => { load(); }, [load]);

  async function open(d: Partial<D>) {
    setEdit({ ...d }); setAi({ busy: false, text: null });
    if (d.id) {
      const { data } = await supabase().from("recipe_lines").select("ingredient_id, qty_per_portion").eq("dish_id", d.id);
      setLines(data ?? []);
    } else setLines([]);
  }

  async function upload(file: File) {
    if (!edit) return;
    setBusy(true);
    const path = `${crypto.randomUUID()}.${file.name.split(".").pop() || "jpg"}`;
    const { error } = await supabase().storage.from("dishes").upload(path, file, { contentType: file.type, upsert: false });
    setBusy(false);
    if (error) return toast("err", "Envoi de la photo impossible (5 Mo max, JPG/PNG/WebP).");
    const { data } = supabase().storage.from("dishes").getPublicUrl(path);
    setEdit({ ...edit, photo_url: data.publicUrl });
  }

  async function save() {
    if (!edit?.name || !edit.base_price) return toast("err", "Nom et prix obligatoires.");
    setBusy(true);
    const sb = supabase();
    const payload = {
      name: edit.name.trim(), category_id: edit.category_id, description: edit.description || null, composition: edit.composition || null,
      kcal: edit.kcal || null, weight_g: edit.weight_g || null, allergens: edit.allergens ?? [], traces: (edit.traces ?? []).filter((a) => !(edit.allergens ?? []).includes(a)), diet_tags: edit.diet_tags ?? [], photo_url: edit.photo_url || null,
      photo_credit: edit.photo_credit || null, photo_source: edit.photo_source || null,
      base_price: edit.base_price, is_active: edit.is_active ?? true, popularity_prior: edit.popularity_prior ?? 1, updated_at: new Date().toISOString(),
    };
    const res = edit.id ? await sb.from("dishes").update(payload).eq("id", edit.id).select("id").single()
      : await sb.from("dishes").insert(payload).select("id").single();
    if (res.error || !res.data) { setBusy(false); return toast("err", "Enregistrement refusé."); }
    const id = res.data.id;
    await sb.from("recipe_lines").delete().eq("dish_id", id);
    const valid = lines.filter((l) => l.ingredient_id && l.qty_per_portion > 0);
    if (valid.length) await sb.from("recipe_lines").insert(valid.map((l) => ({ ...l, dish_id: id })));
    setBusy(false);
    toast("ok", "Plat enregistré.");
    setEdit(null); load();
  }

  const list = dishes.filter((d) => d.name.toLowerCase().includes(q.toLowerCase()));

  return (
    <>
      <PageTitle title="Plats" subtitle="Catalogue, photos, composition et recettes">
        <label className="relative"><Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Rechercher" className={clsx(input, "pl-9")} /></label>
        <Button size="sm" variant="dark" onClick={() => open(EMPTY)}><Plus className="size-4" />Nouveau plat</Button>
      </PageTitle>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {list.map((d) => (
          <button key={d.id} onClick={() => open(d)} className="overflow-hidden rounded-[22px] border border-line bg-card text-left transition hover:shadow-[var(--shadow-card)]">
            <DishImage name={d.name} src={d.photo_url} rounded="rounded-none" className={clsx("h-36 w-full", !d.is_active && "grayscale")} />
            <div className="p-4">
              <div className="flex items-start justify-between gap-2">
                <p className="font-extrabold">{d.name}</p>
                <span className="shrink-0 font-extrabold">{fcfa(d.base_price)}</span>
              </div>
              <p className="mt-1 line-clamp-1 text-sm text-muted">{d.composition}</p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                <Badge>{cats.find((c) => c.id === d.category_id)?.name ?? "Sans catégorie"}</Badge>
                {d.kcal && <Badge>{d.kcal} kcal</Badge>}
                {!d.is_active && <Badge tone="err">Inactif</Badge>}
                {!d.photo_url && <Badge tone="warn">Sans photo</Badge>}
              </div>
            </div>
          </button>
        ))}
      </div>

      <Sheet open={!!edit} onClose={() => setEdit(null)} title={edit?.id ? "Modifier le plat" : "Nouveau plat"}>
        {edit && (
          <div className="space-y-3">
            <div className="flex items-center gap-3">
              <DishImage name={edit.name || "Plat"} src={edit.photo_url} className="size-24" />
              <label className="flex cursor-pointer items-center gap-2 rounded-xl border border-dashed border-line px-4 py-3 text-sm font-bold">
                <Upload className="size-4" />{edit.photo_url ? "Changer la photo" : "Ajouter une photo"}
                <input type="file" accept="image/jpeg,image/png,image/webp" className="hidden" onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
              </label>
            </div>
            <input value={edit.photo_credit ?? ""} onChange={(e) => setEdit({ ...edit, photo_credit: e.target.value })} placeholder="Crédit photo (auteur · licence) — obligatoire pour une photo CC BY-SA" className={clsx(input, "w-full text-xs")} />
            <input value={edit.name ?? ""} onChange={(e) => setEdit({ ...edit, name: e.target.value })} placeholder="Nom du plat" className={clsx(input, "w-full")} />
            <div className="grid grid-cols-2 gap-2">
              <select value={edit.category_id ?? ""} onChange={(e) => setEdit({ ...edit, category_id: e.target.value ? +e.target.value : null })} className={input}>
                <option value="">Catégorie…</option>{cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
              <input type="number" value={edit.base_price ?? ""} onChange={(e) => setEdit({ ...edit, base_price: +e.target.value })} placeholder="Prix (FCFA)" className={input} />
              <input type="number" value={edit.kcal ?? ""} onChange={(e) => setEdit({ ...edit, kcal: +e.target.value || null })} placeholder="kcal" className={input} />
              <input type="number" value={edit.weight_g ?? ""} onChange={(e) => setEdit({ ...edit, weight_g: +e.target.value || null })} placeholder="Poids (g)" className={input} />
            </div>
            <textarea value={edit.description ?? ""} onChange={(e) => setEdit({ ...edit, description: e.target.value })} placeholder="Description" rows={2} className={clsx(input, "h-auto w-full py-2")} />
            <input value={edit.composition ?? ""} onChange={(e) => setEdit({ ...edit, composition: e.target.value })} placeholder="Composition (attiéké, poisson…)" className={clsx(input, "w-full")} />
            <div className="rounded-xl border border-line p-3">
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-extrabold">Allergènes</p>
                <Button type="button" size="sm" variant="outline" loading={ai.busy} onClick={suggestAllergens}><Sparkles className="size-4" />Proposer avec l&apos;IA</Button>
              </div>
              <p className="mt-0.5 text-xs text-muted">Touche : 1 fois = contient · 2 fois = traces possibles · 3 fois = retirer.</p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {ALLERGIES.map((a) => {
                  const has = (edit.allergens ?? []).includes(a), tr = (edit.traces ?? []).includes(a) && !has;
                  return (
                    <button key={a} type="button" onClick={() => cycleAllergen(a)}
                      className={clsx("rounded-full px-3 py-1.5 text-sm font-bold capitalize", has ? "bg-err text-white" : tr ? "bg-warn-soft text-ink ring-1 ring-warn" : "bg-canvas text-muted")}>
                      {has ? "⚠️ " : tr ? "≈ " : ""}{a}{tr ? " (traces)" : ""}
                    </button>
                  );
                })}
              </div>
              {ai.text && <p className="mt-2 rounded-lg bg-lime-soft px-3 py-2 text-xs font-semibold text-ink-2"><Sparkles className="mr-1 inline size-3.5" />{ai.text} <b>Vérifie avant d&apos;enregistrer.</b></p>}
            </div>
            <div className="flex flex-wrap gap-2">
              {DISH_TAGS.map((tg) => {
                const on = (edit.diet_tags ?? []).includes(tg.id);
                return (
                  <button key={tg.id} type="button" onClick={() => setEdit({ ...edit, diet_tags: on ? (edit.diet_tags ?? []).filter((x) => x !== tg.id) : [...(edit.diet_tags ?? []), tg.id] })}
                    className={clsx("rounded-full px-3 py-1.5 text-sm font-bold", on ? "bg-ink text-white" : "bg-canvas")}>{on ? "✓ " : ""}{tg.label}</button>
                );
              })}
            </div>

            <div className="rounded-xl bg-canvas p-3">
              <div className="flex items-center justify-between">
                <p className="text-sm font-extrabold">Popularité de départ</p>
                <span className="rounded-lg bg-ink px-2 py-0.5 text-xs font-extrabold text-lime">
                  ×{(edit.popularity_prior ?? 1).toFixed(2)} · {popLabel(edit.popularity_prior ?? 1)}
                </span>
              </div>
              <input type="range" min={0.3} max={2} step={0.05} value={edit.popularity_prior ?? 1}
                onChange={(e) => setEdit({ ...edit, popularity_prior: +e.target.value })} className="mt-2 w-full accent-[#16181D]" />
              <p className="text-xs text-muted">Sert aux prévisions tant que le plat a peu d&apos;historique ; ensuite les choix réels au comptoir prennent le relais.</p>
            </div>

            <div>
              <p className="mb-2 text-sm font-extrabold">Recette (par portion)</p>
              <div className="space-y-2">
                {lines.map((l, i) => (
                  <div key={i} className="flex gap-2">
                    <select value={l.ingredient_id} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, ingredient_id: e.target.value } : x)))} className={clsx(input, "flex-1")}>
                      <option value="">Ingrédient…</option>{ings.map((g) => <option key={g.id} value={g.id}>{g.name} ({g.unit})</option>)}
                    </select>
                    <input type="number" step="0.01" value={l.qty_per_portion || ""} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, qty_per_portion: +e.target.value } : x)))} className={clsx(input, "w-24")} placeholder="Qté" />
                    <button onClick={() => setLines(lines.filter((_, j) => j !== i))} className="px-1 text-muted hover:text-err" aria-label="Retirer"><Trash2 className="size-4" /></button>
                  </div>
                ))}
                <button onClick={() => setLines([...lines, { ingredient_id: "", qty_per_portion: 0 }])} className="text-sm font-bold text-muted hover:text-ink">+ Ingrédient</button>
              </div>
            </div>
            <label className="flex items-center gap-2 text-sm font-bold">
              <input type="checkbox" checked={edit.is_active ?? true} onChange={(e) => setEdit({ ...edit, is_active: e.target.checked })} className="size-4 accent-[#16181D]" /> Plat actif
            </label>
            <Button block size="lg" loading={busy} onClick={save}>Enregistrer</Button>
          </div>
        )}
      </Sheet>
    </>
  );
}

function popLabel(p: number) {
  return p >= 1.3 ? "très demandé" : p >= 1.1 ? "apprécié" : p > 0.9 ? "moyen" : p > 0.7 ? "peu demandé" : "rarement choisi";
}
