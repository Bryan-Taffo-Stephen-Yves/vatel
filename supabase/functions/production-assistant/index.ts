// POST /functions/v1/production-assistant  { date: "AAAA-MM-JJ", refresh?: boolean }
// Guide de production du chef : Claude commente le plan calculé (production_plan) — portions par plat, reprises,
// ingrédients, heures de lancement — et l'historique (préparé / servi / restes). Il n'invente aucun chiffre.
// Réservé à la cuisine / l'admin. Mis en cache par jour tant que le plan ne change pas.
import Anthropic from "npm:@anthropic-ai/sdk";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { adminClient, corsHeaders, fail, json } from "../_shared/http.ts";

const MODEL = "claude-opus-5-5";

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["titre", "resume", "plats", "ordre", "vigilance"],
  properties: {
    titre: { type: "string", description: "Phrase courte qui résume la production du jour (moins de 12 mots)" },
    resume: { type: "string", description: "2 ou 3 phrases : volume total, plats qui vont partir le plus vite, reprises" },
    plats: {
      type: "array",
      description: "Un conseil court par plat, dans l'ordre des données",
      items: {
        type: "object", additionalProperties: false, required: ["plat", "conseil", "niveau"],
        properties: {
          plat: { type: "string", description: "Nom exact du plat" },
          conseil: { type: "string", description: "1 phrase : pourquoi cette quantité (popularité, reprises, historique) et quoi surveiller" },
          niveau: { type: "string", enum: ["ok", "attention", "risque"] },
        },
      },
    },
    ordre: { type: "string", description: "Ordre de lancement en cuisine en 1 ou 2 phrases (plats longs d'abord, avec les heures données)" },
    vigilance: { type: "array", items: { type: "string" }, description: "0 à 3 risques (ingrédient manquant, plat nouveau, gaspillage passé)" },
  },
} as const;

const SYSTEM = `Tu es le second de cuisine de Dabali, la cantine d'une école hôtelière à Abidjan.
Tu aides le chef à valider le guide de production : combien de portions préparer par plat et quels ingrédients sortir.
Les chiffres viennent du calcul de l'appli (tu ne les modifies pas, tu les expliques) :
- items[] : par plat, clients attendus (expected), part des choix (share %), popularité, taux de reprise (seconds_rate %, « observed » = appris des restes, « prior » = estimation de départ), portions de reprise (seconds_portions), marge (margin %), portions proposées (proposed), portions retenues (portions), validé ou non, heure de lancement conseillée (start_at) et durée (prep_minutes), ingrédients à sortir.
- ingredients[] : besoin total vs stock, manque (missing).
- historique[] : mêmes jours de semaine passés, par plat : préparé, servi, restes.
Règles : français simple et direct, comme en cuisine. Cite les chiffres fournis, n'en invente aucun. Mets en avant les plats qui attirent du monde (alloco, garba, frites, foutou…) et ceux qu'on reprend beaucoup. Signale un ingrédient manquant, un plat sans historique (marge plus large), ou un plat qui a eu beaucoup de restes. Heures au format 10h30.`;

async function sha256(s: string) {
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(h), (b) => b.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return fail("METHOD", "POST uniquement", 405);
  const auth = req.headers.get("Authorization");
  if (!auth) return fail("AUTH_REQUIRED", "Connexion requise.", 401);

  const body = await req.json().catch(() => ({}));
  const date = String(body?.date ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return fail("BAD_DATE", "Date invalide.");

  // Plan lu avec le JWT de l'appelant : production_plan vérifie le rôle (chef / admin).
  const userDb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: auth } }, auth: { persistSession: false },
  });
  const { data: plan, error } = await userDb.rpc("production_plan", { p_date: date });
  if (error) return fail("FORBIDDEN", "Réservé à la cuisine et à l'administration.", 403);
  if (!(plan as any)?.items?.length) return fail("NO_MENU", "Pas de menu publié ce jour-là.", 404);

  const db = adminClient();
  const past = [7, 14, 21, 28].map((d) => new Date(Date.parse(date) - d * 864e5).toISOString().slice(0, 10));
  const { data: hist } = await db.from("menu_items")
    .select("service_date, service, prepared_qty, served_qty, leftover_qty, dish:dishes(name), menu:menus!inner(status)")
    .in("service_date", past).eq("menu.status", "published").not("prepared_qty", "is", null);
  const historique = (hist ?? []).map((w: any) => ({ date: w.service_date, service: w.service, plat: w.dish?.name, prepare: w.prepared_qty, servi: w.served_qty, restes: w.leftover_qty }));
  // Heures en Abidjan (UTC+0) lisibles
  const p = plan as any;
  const items = p.items.map((i: any) => ({ ...i, photo_url: undefined, start_at: String(i.start_at).slice(11, 16) }));

  const dayName = new Date(date + "T12:00:00Z").toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
  const input = JSON.stringify({ jour: dayName, date, services: p.services, items, ingredients: p.ingredients, historique });
  const hash = await sha256(input);

  if (!body?.refresh) {
    const { data: cached } = await db.from("ai_production_briefs").select("brief, created_at, input_hash").eq("service_date", date).maybeSingle();
    if (cached && cached.input_hash === hash) return json({ ok: true, cached: true, created_at: cached.created_at, brief: cached.brief });
  }

  let apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) apiKey = (await db.rpc("_anthropic_key")).data ?? undefined;
  if (!apiKey) return fail("NO_KEY", "Clé Anthropic non configurée.", 500);

  const client = new Anthropic({ apiKey });
  try {
    const res = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMA } },
      system: SYSTEM,
      messages: [{ role: "user", content: `Commente le guide de production de ${dayName}.\n\n<donnees>\n${input}\n</donnees>` }],
    } as any);
    if (res.stop_reason === "refusal") return fail("AI_REFUSED", "L'assistant n'a pas pu analyser cette journée.", 502);
    const text = res.content.find((b: any) => b.type === "text") as { text: string } | undefined;
    if (!text) return fail("AI_EMPTY", "Réponse vide de l'assistant.", 502);
    const brief = JSON.parse(text.text);
    const created_at = new Date().toISOString();
    await db.from("ai_production_briefs").upsert({ service_date: date, input_hash: hash, brief, model: res.model, created_at });
    return json({ ok: true, cached: false, created_at, brief });
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) return fail("AI_AUTH", "Clé Anthropic refusée.", 502);
    if (e instanceof Anthropic.RateLimitError) return fail("AI_BUSY", "Assistant saturé, réessayez dans une minute.", 503);
    if (e instanceof Anthropic.APIError) return fail("AI_ERROR", `Erreur de l'assistant (${e.status}).`, 502);
    return fail("AI_ERROR", "L'assistant est indisponible.", 502);
  }
});
