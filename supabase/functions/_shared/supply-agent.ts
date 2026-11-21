// Agent d'achats : l'équipe lui parle (groupe WhatsApp « Vatel – Approvisionnement » ou page « Agent d'achats »).
// Claude comprend la demande et utilise des outils ; les règles (plafond, budget, secours, statuts) sont en base.
// Il ne paie jamais, ne commande que des produits du carnet, et n'invente aucun chiffre.
import Anthropic from "npm:@anthropic-ai/sdk";
import { adminClient } from "./http.ts";

const MODEL = "claude-opus-5-5";
const db = adminClient();
const hm = (iso: string | null) => (iso ? new Date(iso).toISOString().slice(11, 16).replace(":", "h") : null); // Abidjan = UTC+0

const STATUS: Record<string, string> = {
  a_approuver: "attend l'accord de l'équipe", a_appeler: "à appeler", appel_en_cours: "appel en cours", commande: "commandé (livraison attendue)",
  a_valider: "prix à valider par l'équipe", valide: "prix validé, à rappeler", injoignable: "injoignable, nouvel essai prévu", rappeler: "rappel prévu",
  coursier: "coursier envoyé", refuse: "refusé", annule: "annulé", reporte: "passé au fournisseur de secours", recu: "reçu",
};

const TOOLS = [
  { name: "voir_situation", description: "Situation des achats : réglages de l'agent (allumé, plafond d'accord, budget du jour), montant engagé aujourd'hui, ingrédients à surveiller (stock, seuil, besoin des menus, déjà en route, à commander, fournisseur prévu), commandes de l'agent avec id, statut, montant, livraison.", strict: true,
    input_schema: { type: "object", additionalProperties: false, properties: {}, required: [] } },
  { name: "voir_carnet", description: "Carnet de prix : produits achetables avec produit_id, fournisseur, conditionnement (ex. « sacs de riz de 25 kg »), prix habituel par unité, rang (0 = fournisseur habituel, 1+ = secours).", strict: true,
    input_schema: { type: "object", additionalProperties: false, required: ["recherche"], properties: {
      recherche: { type: ["string", "null"], description: "mot à chercher (riz, poulet…) ; null pour tout" } } } },
  { name: "commander", description: "Passe une commande demandée par l'équipe : une commande par fournisseur, appelée tout de suite par l'agent vocal (pas besoin d'accord, c'est l'équipe qui demande). Quantités en unités du carnet (2 sacs, 20 poulets, 15 kg).", strict: true,
    input_schema: { type: "object", additionalProperties: false, required: ["lignes"], properties: {
      lignes: { type: "array", items: { type: "object", additionalProperties: false, required: ["produit_id", "quantite"],
        properties: { produit_id: { type: "string" }, quantite: { type: "number" } } } } } } },
  { name: "annuler_commande", description: "Annule une commande pas encore passée (à approuver, à appeler, injoignable, à rappeler, prix à valider). Pas de fournisseur de secours ensuite.", strict: true,
    input_schema: { type: "object", additionalProperties: false, required: ["commande_id"], properties: { commande_id: { type: "string" } } } },
  { name: "decider", description: "Répond à une commande qui attend l'équipe : accord avant appel (attend l'accord) ou prix trop haut (prix à valider). accepter=false sur un prix → fournisseur de secours.", strict: true,
    input_schema: { type: "object", additionalProperties: false, required: ["commande_id", "accepter"], properties: {
      commande_id: { type: "string" }, accepter: { type: "boolean" } } } },
  { name: "lancer_tour", description: "Fait travailler l'agent tout de suite : recalcule les besoins, passe les nouvelles commandes et lance les appels prévus.", strict: true,
    input_schema: { type: "object", additionalProperties: false, properties: {}, required: [] } },
] as const;

const SYSTEM = `Tu es l'agent d'achats de la cantine Vatel (école hôtelière, Abidjan, francs CFA). Tu surveilles le stock, tu passes les commandes aux fournisseurs (un agent vocal les appelle pour toi) et tu tiens l'équipe au courant.
Un membre de l'équipe t'écrit. Traite sa demande avec tes outils puis réponds en 1 à 4 lignes courtes, en français simple d'Abidjan, avec des emojis sobres.
- Questions (« où en est le riz ? », « qu'est-ce qu'on a commandé ? », « combien on a dépensé ? ») → voir_situation, puis réponds avec les vrais chiffres.
- « commande 2 sacs de riz », « prends 20 poulets chez Bamba » → voir_carnet pour trouver le produit (fournisseur habituel, rang 0, sauf si un fournisseur est nommé), puis commander. Annonce le fournisseur et le montant prévu.
- « annule la commande du marché » → voir_situation pour trouver l'id, puis annuler_commande.
- « oui pour Koné », « valide le prix de Bamba », « non » → decider sur la commande en attente correspondante.
- « lance l'agent », « vérifie le stock » → lancer_tour, puis résume ce qui a été fait.
Règles : n'invente aucun prix, aucune quantité, aucun statut ; ne parle jamais de paiement en ton nom (le paiement Wave est fait par une personne) ; ne commande que des produits du carnet ; si une demande est ambiguë (quel produit, quelle quantité), pose UNE question courte.
Si le message ne te concerne pas (discussion entre collègues, salutations, sujet sans rapport avec les achats), réponds exactement : RIEN`;

async function situation() {
  const { data } = await db.rpc("_supply_agent_overview");
  const d = (data ?? {}) as any;
  const cfg = d.settings ?? {};
  return {
    agent: { allume: !!cfg.enabled, mode: cfg.mode, plafond_sans_accord: cfg.auto_limit, budget_du_jour: cfg.daily_budget, engage_aujourdhui: d.spent_today },
    ingredients: (d.needs ?? []).map((n: any) => ({ ingredient: n.name, unite: n.unit, stock: n.stock, seuil: n.threshold, besoin_menus: n.need,
      deja_en_route: n.open_qty, a_commander: n.to_order, fournisseur_prevu: n.supplier, conditionnement: n.product, unites: n.units, estimation: n.est,
      refuse_par_equipe: n.declined })),
    commandes: (d.orders ?? []).slice(0, 15).map((o: any) => ({ commande_id: o.id, fournisseur: o.supplier_name, statut: STATUS[o.status] ?? o.status,
      articles: (o.items ?? []).map((i: any) => `${i.qty} ${i.label}`).join(", "), budget: o.budget, prix_fournisseur: o.quoted_total,
      livraison: o.delivery_at, essais: o.attempts, prochain_appel: hm(o.next_call_at), origine: o.origin, creee_a: hm(o.created_at) })),
  };
}

async function carnet(q: string | null) {
  const { data } = await db.from("supplier_products")
    .select("id, label, unit, usual_price, backup_rank, supplier:suppliers(name, is_active), ingredient:ingredients(name)")
    .order("backup_rank");
  const k = (q ?? "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  return (data ?? []).filter((p: any) => p.supplier?.is_active !== false)
    .filter((p: any) => !k || `${p.label} ${p.ingredient?.name ?? ""} ${p.supplier?.name ?? ""}`.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").includes(k))
    .slice(0, 40)
    .map((p: any) => ({ produit_id: p.id, fournisseur: p.supplier?.name, produit: p.label, unite: p.unit, prix_habituel: p.usual_price, rang: p.backup_rank }));
}

async function runTool(name: string, input: any, author: string) {
  if (name === "voir_situation") return situation();
  if (name === "voir_carnet") return carnet(input.recherche ?? null);
  if (name === "commander") {
    const lines = (input.lignes ?? []).map((l: any) => ({ product_id: l.produit_id, qty: l.quantite }));
    const { data, error } = await db.rpc("_supply_team_order", { p_lines: lines, p_author: author });
    if (error) return { erreur: "Service indisponible." };
    if (!(data as any)?.ok) return data;
    const { data: orders } = await db.from("supplier_orders").select("supplier_name, budget, items").in("id", (data as any).orders);
    await db.rpc("supply_agent_tick", { p_force: true }); // appel lancé tout de suite
    return { ok: true, commandes: (orders ?? []).map((o: any) => ({ fournisseur: o.supplier_name, budget: o.budget,
      articles: (o.items ?? []).map((i: any) => `${i.qty} ${i.label}`).join(", ") })), suite: "L'agent vocal appelle le fournisseur." };
  }
  if (name === "annuler_commande") {
    const { data, error } = await db.rpc("_supply_cancel", { p_order: input.commande_id, p_author: author });
    return error ? { erreur: "Commande introuvable." } : data;
  }
  if (name === "decider") {
    const { data, error } = await db.rpc("_supplier_order_decide", { p_order: input.commande_id, p_accept: !!input.accepter, p_author: author });
    if (error) return { erreur: "Commande introuvable." };
    if ((data as any)?.ok) await db.rpc("supply_agent_tick", { p_force: true });
    return data;
  }
  if (name === "lancer_tour") {
    const { data, error } = await db.rpc("supply_agent_tick", { p_force: true });
    return error ? { erreur: "Service indisponible." } : { ...(data as any), explication: "planned = nouvelles commandes, calls = appels lancés, reroutes = passages au secours, couriers = coursiers envoyés" };
  }
  return { erreur: "Outil inconnu." };
}

/** Message de l'équipe → réponse de l'agent d'achats, ou null s'il n'a rien à dire (« RIEN ») */
export async function supplyMessage(text: string, author: string): Promise<string | null> {
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY_JEAN") ?? Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) return null;
  const client = new Anthropic({ apiKey });
  const messages: any[] = [{ role: "user", content: `${author} : ${text}` }];
  for (let k = 0; k < 8; k++) {
    let res: any;
    try {
      res = await client.beta.messages.create({ model: MODEL, max_tokens: 2000, system: SYSTEM, tools: TOOLS as any, messages,
        output_config: { effort: "low" }, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" } as any);
    } catch (e) { console.error("supply-agent", e); return null; }
    messages.push({ role: "assistant", content: res.content });
    const uses = res.content.filter((b: any) => b.type === "tool_use");
    if (res.stop_reason !== "tool_use" || !uses.length) {
      const out = res.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n").trim();
      return !out || /^RIEN\.?$/i.test(out) ? null : out;
    }
    const results = [];
    for (const u of uses) results.push({ type: "tool_result", tool_use_id: u.id, content: JSON.stringify(await runTool(u.name, u.input ?? {}, author).catch(() => ({ erreur: "Indisponible." }))) });
    messages.push({ role: "user", content: results });
  }
  return null;
}
