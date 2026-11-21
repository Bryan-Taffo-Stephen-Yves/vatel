// Préparation d'une commande du jour (panier : plats en quantité + suppléments) par Jean (WhatsApp ou téléphone).
// Crée une order_request valable 15 min ; le client confirme dans l'appli (Face ID ou PIN) → place_order_cart revérifie tout.
import { adminClient } from "./http.ts";
import { severeHits } from "./diet.ts";

const APP = "https://vatel-cantine.netlify.app";
const db = adminClient();
const todayISO = () => new Date().toISOString().slice(0, 10); // Abidjan = UTC+0
const fcfa = (n: number) => `${n.toLocaleString("fr-FR").replace(/\u202f/g, " ")} F`;

/** Prépare une demande de commande (panier du jour) + lien de confirmation. Les règles finales sont revérifiées en base à la confirmation. */
export async function prepareOrder(userId: string, plats: { menu_item_id: string; quantite: number }[], supps: { supplement_id: string; quantite: number }[], heure: string, source: string): Promise<any> {
  const lines = new Map<string, number>();
  for (const p of plats) if (p?.menu_item_id && p.quantite > 0) lines.set(p.menu_item_id, (lines.get(p.menu_item_id) ?? 0) + Math.floor(p.quantite));
  if (!lines.size) return { erreur: "Aucun plat choisi." };
  const n = [...lines.values()].reduce((a, b) => a + b, 0);
  if (n > 10) return { erreur: "Au plus 10 plats par commande." };
  const { data: mis } = await db.from("menu_items").select("id, service_date, service, price, planned_qty, sold_qty, is_sold_out, is_full, dish:dishes(name, allergens, traces), menu:menus!inner(status)")
    .in("id", [...lines.keys()]).eq("menu.status", "published");
  if ((mis ?? []).length !== lines.size) return { erreur: "Un des plats n'est pas au menu (utilise les menu_item_id de voir_menu)." };
  if ((mis ?? []).some((m: any) => m.service_date !== todayISO())) return { erreur: "On ne commande que les plats du jour." };
  if (new Set((mis ?? []).map((m: any) => m.service)).size > 1) return { erreur: "Une commande = un seul repas. Fais une commande par repas." };
  for (const m of mis as any[]) {
    const q = lines.get(m.id)!;
    if (m.is_sold_out || m.is_full || (m.planned_qty != null && m.planned_qty - m.sold_qty < q)) return { erreur: `Plus assez de ${m.dish?.name}.` };
  }
  // Allergie grave déclarée : plat interdit (la base le refuse aussi à la confirmation)
  const { data: me } = await db.from("profiles").select("severe_allergies").eq("id", userId).single();
  for (const m of mis as any[]) {
    const hit = severeHits(me, m.dish);
    if (hit.length) return { erreur: `Allergie grave : ${m.dish?.name} contient ${hit.join(", ")}. Ce plat est interdit pour ce client : propose un plat compatible.` };
  }
  const service = (mis as any[])[0].service as string;
  if (!/^\d{2}:\d{2}$/.test(heure ?? "")) return { erreur: "Heure invalide (HH:MM)." };
  const pickup = `${todayISO()}T${heure}:00Z`;
  const { data: slots } = await db.rpc("order_slots", { p_date: todayISO(), p_service: service });
  const slot = ((slots ?? []) as { at: string; left: number }[]).find((s) => new Date(s.at).getTime() === new Date(pickup).getTime());
  if (!slot || slot.left < n) return { erreur: "Cette heure n'est pas libre pour autant de plats. Utilise voir_creneaux.", creneaux_libres: ((slots ?? []) as any[]).filter((s) => s.left >= n).map((s) => s.at.slice(11, 16)) };
  const ex = new Map<string, number>();
  for (const e of supps) if (e?.supplement_id && e.quantite > 0) ex.set(e.supplement_id, (ex.get(e.supplement_id) ?? 0) + Math.floor(e.quantite));
  let extras: any[] = [];
  if (ex.size) {
    const { data: s } = await db.from("settings").select("value").eq("key", "services").single();
    if (!(s?.value as any)?.[service]?.extras) return { erreur: "Pas de supplément pour ce repas." };
    const { data } = await db.from("extras").select("id, name, kind, price").in("id", [...ex.keys()]).eq("is_active", true).in("kind", ["starter", "dessert"]);
    extras = data ?? [];
    if (extras.length !== ex.size) return { erreur: "Supplément inconnu (utilise les supplement_id de voir_menu)." };
    for (const k of ["starter", "dessert"]) if (extras.filter((e) => e.kind === k).reduce((a, e) => a + ex.get(e.id)!, 0) > n) return { erreur: `Au plus ${n} ${k === "starter" ? "entrée(s)" : "dessert(s)"} pour ${n} plat(s).` };
  }
  const { count } = await db.from("order_requests").select("id", { count: "exact", head: true })
    .eq("user_id", userId).eq("status", "pending").gt("expires_at", new Date().toISOString());
  if ((count ?? 0) >= 3) return { erreur: "Trop de demandes en attente : confirme d'abord ou attends 15 min." };
  const items = (mis as any[]).map((m) => ({ menu_item_id: m.id, qty: lines.get(m.id)! }));
  const { data: r, error } = await db.from("order_requests").insert({ user_id: userId, menu_item_id: items[0].menu_item_id, pickup_at: pickup, source,
    items, extras: extras.map((e) => ({ extra_id: e.id, qty: ex.get(e.id)! })) }).select("token").single();
  if (error || !r) return { erreur: "Impossible de préparer la commande." };
  const total = (mis as any[]).reduce((a, m) => a + m.price * lines.get(m.id)!, 0) + extras.reduce((a, e) => a + e.price * ex.get(e.id)!, 0);
  const lbl = (q: number, name: string) => `${q > 1 ? `${q} × ` : ""}${name}`;
  return { lien_de_confirmation: `${APP}/app/confirmer/${r.token}`, token: r.token,
    plats: (mis as any[]).map((m) => lbl(lines.get(m.id)!, m.dish?.name)), supplements: extras.map((e) => lbl(ex.get(e.id)!, e.name)),
    nombre_de_plats: n, repas: service, retrait: heure, total: fcfa(total), total_f: total, valable: "15 minutes" };
}

