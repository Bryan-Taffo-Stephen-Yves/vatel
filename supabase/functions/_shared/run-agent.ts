// Jean coordonne la tournée du coursier : il lit les messages de l'équipe (groupe WhatsApp ou page de suivi)
// et modifie la liste d'achats (annuler / ajouter un article pas encore acheté), puis répond en une ou deux lignes.
// Les règles (pas d'annulation d'un article acheté, arrêts annulés, itinéraire) sont appliquées en base, pas par l'IA.
import Anthropic from "npm:@anthropic-ai/sdk";
import { adminClient } from "./http.ts";
import { planRoute } from "./route.ts";

const MODEL = "claude-opus-5-5";
const db = adminClient();
const hm = (iso: string | null) => (iso ? new Date(iso).toISOString().slice(11, 16).replace(":", "h") : "?"); // Abidjan = UTC+0

const TOOLS = [
  { name: "voir_tournee", description: "État de la tournée : arrêts (fournisseurs) dans l'ordre, articles avec leur id et statut (a_acheter, achete, annule), heure d'arrivée prévue.", strict: true,
    input_schema: { type: "object", additionalProperties: false, properties: {}, required: [] } },
  { name: "annuler_articles", description: "Annule des articles PAS ENCORE achetés (ids de voir_tournee). Un fournisseur sans article restant n'est plus visité et l'itinéraire est recalculé.", strict: true,
    input_schema: { type: "object", additionalProperties: false, required: ["ids"], properties: { ids: { type: "array", items: { type: "string" } } } } },
  { name: "ajouter_article", description: "Ajoute un article chez un fournisseur pas encore terminé (arret_id de voir_tournee).", strict: true,
    input_schema: { type: "object", additionalProperties: false, required: ["arret_id", "libelle", "quantite"], properties: {
      arret_id: { type: "string" }, libelle: { type: "string", description: "ex. « kg d'oignons »" }, quantite: { type: "number" } } } },
] as const;

const SYSTEM = `Tu es Jean, l'assistant de la cantine Dabali (Abidjan). Un coursier fait les courses de la cuisine chez plusieurs fournisseurs, puis livre la cantine. Tu es dans le groupe WhatsApp de l'équipe.
Tu reçois un message d'un membre de l'équipe. Si c'est une consigne sur la tournée (annuler, ne garder que certains articles, ajouter un article) ou une question sur la tournée (où en est le coursier, qu'est-ce qui a été acheté, quand arrive-t-il), traite-la avec tes outils puis réponds en 1 à 3 lignes courtes, en français simple, avec des emojis sobres.
- « laisse tomber les tomates » → annule les tomates. « prends seulement les poulets et la banane » → annule tous les autres articles pas encore achetés.
- Un article déjà acheté ne peut plus être annulé : dis-le clairement.
- N'invente rien : utilise voir_tournee. Donne la nouvelle heure d'arrivée si elle change.
- Si le message ne concerne pas la tournée (discussion, salutation entre collègues…), réponds exactement : RIEN`;

async function view(runId: string) {
  const [{ data: run }, { data: stops }, { data: items }] = await Promise.all([
    db.from("delivery_runs").select("status, eta_at, courier_name, target_stop").eq("id", runId).single(),
    db.from("delivery_stops").select("id, seq, name, district, status").eq("run_id", runId).order("seq"),
    db.from("delivery_items").select("id, stop_id, label, qty, status").eq("run_id", runId).order("created_at"),
  ]);
  return { statut: run?.status, coursier: run?.courier_name, arrivee_prevue: hm(run?.eta_at ?? null),
    arrets: (stops ?? []).map((s: any) => ({ arret_id: s.id, ordre: s.seq, fournisseur: s.name, quartier: s.district, statut: s.status, en_cours: s.id === run?.target_stop,
      articles: (items ?? []).filter((i: any) => i.stop_id === s.id).map((i: any) => ({ id: i.id, article: `${i.qty} ${i.label}`, statut: i.status })) })) };
}

async function runTool(runId: string, name: string, input: any, author: string) {
  if (name === "voir_tournee") return view(runId);
  if (name === "annuler_articles") {
    const { data, error } = await db.rpc("_delivery_cancel_items", { p_run: runId, p_items: input.ids ?? [], p_author: author });
    if (error) return { erreur: error.message };
    if ((data as any)?.reroute) {
      await planRoute(runId);
      const { data: r } = await db.from("delivery_runs").select("eta_at").eq("id", runId).single();
      return { ...(data as any), nouvelle_arrivee: hm(r?.eta_at ?? null) };
    }
    return data;
  }
  if (name === "ajouter_article") {
    const { data, error } = await db.rpc("_delivery_add_item", { p_run: runId, p_stop: input.arret_id, p_label: input.libelle, p_qty: input.quantite, p_author: author });
    return error ? { erreur: error.message } : data;
  }
  return { erreur: "Outil inconnu." };
}

/** Tournée en cours la plus récente */
export async function activeRun(): Promise<string | null> {
  const { data } = await db.from("delivery_runs").select("id").in("status", ["prete", "en_route", "achats", "vers_cantine", "livre"])
    .order("created_at", { ascending: false }).limit(1).maybeSingle();
  return data?.id ?? null;
}

/** Message de l'équipe → réponse de Jean (ou null s'il n'y a rien à dire). La réponse est enregistrée comme événement. */
export async function teamMessage(runId: string, text: string, author: string): Promise<string | null> {
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY_JEAN") ?? Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) return null;
  const client = new Anthropic({ apiKey });
  const messages: any[] = [{ role: "user", content: `${author} : ${text}` }];
  for (let k = 0; k < 6; k++) {
    let res: any;
    try {
      res = await client.beta.messages.create({ model: MODEL, max_tokens: 2000, system: SYSTEM, tools: TOOLS as any, messages,
        output_config: { effort: "low" }, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" } as any);
    } catch (e) { console.error("run-agent", e); return null; }
    messages.push({ role: "assistant", content: res.content });
    const uses = res.content.filter((b: any) => b.type === "tool_use");
    if (res.stop_reason !== "tool_use" || !uses.length) {
      const out = res.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n").trim();
      if (!out || /^RIEN\.?$/i.test(out)) return null;
      await db.from("delivery_events").insert({ run_id: runId, kind: "jean", message: `🤖 Jean : ${out}`, author: "Jean" });
      return out;
    }
    const results = [];
    for (const u of uses) results.push({ type: "tool_result", tool_use_id: u.id, content: JSON.stringify(await runTool(runId, u.name, u.input ?? {}, author).catch(() => ({ erreur: "Indisponible." }))) });
    messages.push({ role: "user", content: results });
  }
  return null;
}
