// POST /functions/v1/dish-allergens  (JWT chef ou admin)
// L'IA lit le nom et la composition d'un plat et PROPOSE ses allergènes, les traces possibles et ses étiquettes
// (végétarien, sans porc, pimenté). Rien n'est enregistré ici : le chef relit et valide dans Admin → Plats.
import Anthropic from "npm:@anthropic-ai/sdk";
import { adminClient, corsHeaders, fail, json, requestUser } from "../_shared/http.ts";

const MODEL = "claude-opus-5-5";
const db = adminClient();
const ALLERGIES = ["arachide", "gluten", "lait", "œuf", "poisson", "crustacés", "mollusques", "fruits à coque", "soja", "sésame", "moutarde", "céleri", "sulfites", "lupin"];

const SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["allergenes", "traces", "vegetarien", "sans_porc", "pimente", "explication"],
  properties: {
    allergenes: { type: "array", items: { type: "string", enum: ALLERGIES }, description: "Allergènes présents dans la recette habituelle" },
    traces: { type: "array", items: { type: "string", enum: ALLERGIES }, description: "Allergènes possibles (ingrédient souvent ajouté, friture partagée, cube, sauce…), pas déjà dans allergenes" },
    vegetarien: { type: "boolean" }, sans_porc: { type: "boolean" }, pimente: { type: "boolean", description: "Plat servi pimenté d'habitude" },
    explication: { type: "string", description: "Une ou deux phrases courtes pour le chef : d'où vient chaque allergène, ce qu'il doit vérifier" },
  },
} as const;

const SYSTEM = `Tu aides le chef d'une cantine d'école hôtelière à Abidjan à déclarer les allergènes de ses plats (cuisine ivoirienne et internationale).
À partir du nom et de la composition, liste les allergènes présents (liste fermée fournie), puis les traces possibles : ingrédients souvent présents dans la recette ivoirienne habituelle mais non cités (ex. pâte d'arachide, cube de bouillon avec gluten ou soja, poisson fumé ou crevettes séchées dans les sauces, moutarde dans les vinaigrettes, céleri dans les bouillons, sulfites dans les vinaigres et fruits secs, friture commune).
Sois prudent : en cas de doute, mets l'allergène en traces plutôt que de l'oublier. Réponds en français simple. Le chef validera.`;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return fail("METHOD", "POST uniquement", 405);
  const user = await requestUser(req);
  if (!user) return fail("AUTH_REQUIRED", "Connexion requise.", 401);
  const { data: me } = await db.from("profiles").select("role, is_blocked").eq("id", user.id).single();
  if (!me || me.is_blocked || !["chef", "admin"].includes(me.role)) return fail("FORBIDDEN", "Réservé au chef.", 403);
  const body = await req.json().catch(() => ({}));
  const name = String(body.name ?? "").trim().slice(0, 120);
  const composition = String(body.composition ?? "").trim().slice(0, 1000);
  const description = String(body.description ?? "").trim().slice(0, 600);
  if (!name) return fail("INVALID", "Nom du plat requis.");

  const apiKey = Deno.env.get("ANTHROPIC_API_KEY") ?? (await db.rpc("_anthropic_key")).data ?? undefined;
  if (!apiKey) return fail("NO_KEY", "Clé Anthropic non configurée.", 500);
  try {
    const res = await new Anthropic({ apiKey }).beta.messages.create({
      model: MODEL, max_tokens: 3000, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default",
      output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMA } }, system: SYSTEM,
      messages: [{ role: "user", content: `<plat>\nNom : ${name}\nComposition : ${composition || "(non précisée)"}\nDescription : ${description || "(aucune)"}\n</plat>` }],
    } as any);
    const text = res.content.find((b: any) => b.type === "text") as { text: string } | undefined;
    if (res.stop_reason === "refusal" || !text) return fail("AI_EMPTY", "Proposition indisponible.", 502);
    const out = JSON.parse(text.text);
    const clean = (l: unknown) => [...new Set((Array.isArray(l) ? l : []).filter((a) => ALLERGIES.includes(a)))];
    const allergens = clean(out.allergenes);
    return json({ ok: true, allergens, traces: clean(out.traces).filter((a) => !allergens.includes(a)),
      diet_tags: [out.vegetarien && "vegetarien", out.sans_porc && "sans_porc", out.pimente && "pimente"].filter(Boolean),
      explanation: String(out.explication ?? "") });
  } catch (e) {
    console.error("dish-allergens", e);
    return fail("AI_ERROR", "Proposition indisponible pour le moment.", 502);
  }
});
