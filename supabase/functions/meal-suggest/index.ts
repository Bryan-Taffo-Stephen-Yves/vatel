// POST /functions/v1/meal-suggest  (JWT de l'élève)
// Suggestions de repas personnalisées : Claude choisit 1 à 3 plats du prochain repas, parmi ceux compatibles avec les
// allergies / le régime de l'élève, en tenant compte de ce qu'il a mangé et aimé. Il n'invente aucun plat (ids vérifiés).
import Anthropic from "npm:@anthropic-ai/sdk";
import { adminClient, corsHeaders, fail, json, requestUser } from "../_shared/http.ts";
import { dietConflicts } from "../_shared/diet.ts";

const MODEL = "claude-opus-5-5";
const db = adminClient();
const ORDER = ["breakfast", "lunch", "snack", "dinner"];

const SCHEMA = {
  type: "object", additionalProperties: false, required: ["intro", "suggestions"],
  properties: {
    intro: { type: "string", description: "Une phrase chaleureuse et courte, en tutoyant (moins de 18 mots)" },
    suggestions: { type: "array", description: "1 à 3 plats, le meilleur d'abord", items: { type: "object", additionalProperties: false, required: ["menu_item_id", "raison"],
      properties: { menu_item_id: { type: "string" }, raison: { type: "string", description: "Pourquoi ce plat pour lui, en une phrase courte et concrète" } } } },
  },
} as const;

const SYSTEM = `Tu es le conseiller repas de la cantine Vatel (école hôtelière d'Abidjan). Tu proposes à un élève 1 à 3 plats du prochain repas, choisis UNIQUEMENT parmi les plats candidats fournis (déjà compatibles avec ses allergies et son régime).
Critères : ce qu'il a aimé (bonnes notes), varier par rapport à ce qu'il a mangé les derniers jours, l'équilibre (s'il a mangé lourd récemment, propose plus léger), la popularité, et son budget si son solde est bas.
Réponds en français simple, en tutoyant, phrases courtes. N'invente aucun plat ni aucun chiffre.`;

async function sha256(s: string) {
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(h), (b) => b.toString(16).padStart(2, "0")).join("");
}
const conflicts = (p: any, d: any) => dietConflicts(p, d);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return fail("METHOD", "POST uniquement", 405);
  const user = await requestUser(req);
  if (!user) return fail("AUTH_REQUIRED", "Connexion requise.", 401);
  const body = await req.json().catch(() => ({}));

  // Prochain repas : service du jour pas encore fini, sinon le premier repas de demain qui a un menu
  const [{ data: profile }, { data: s }, { data: w }] = await Promise.all([
    db.from("profiles").select("full_name, allergies, diets, severe_allergies").eq("id", user.id).single(),
    db.from("settings").select("value").eq("key", "services").single(),
    db.from("wallets").select("balance").eq("user_id", user.id).single(),
  ]);
  const svc = (s?.value ?? {}) as Record<string, { label: string; end: string }>;
  const now = new Date(); const today = now.toISOString().slice(0, 10); const hm = now.toISOString().slice(11, 16); // Abidjan = UTC+0
  const tomorrow = new Date(Date.now() + 86400e3).toISOString().slice(0, 10);
  const { data: menu } = await db.from("menu_items")
    .select("id, service_date, service, price, is_sold_out, is_full, dish:dishes(id, name, composition, kcal, allergens, traces, diet_tags, photo_url), menu:menus!inner(status)")
    .eq("menu.status", "published").gte("service_date", today).lte("service_date", new Date(Date.now() + 7 * 86400e3).toISOString().slice(0, 10));
  const slots = [...new Set((menu ?? []).map((m: any) => `${m.service_date}|${m.service}`))]
    .filter((k) => { const [d, sv] = k.split("|"); return d > today || hm < (svc[sv]?.end ?? "24:00"); })
    .sort((a, b) => (a.split("|")[0] + ORDER.indexOf(a.split("|")[1])).localeCompare(b.split("|")[0] + ORDER.indexOf(b.split("|")[1])));
  const target = body.service && body.date ? `${body.date}|${body.service}` : slots[0];
  if (!target) return json({ ok: true, empty: true, message: "Pas de menu publié pour les 7 prochains jours." });
  const [date, service] = target.split("|");
  const items = (menu ?? []).filter((m: any) => m.service_date === date && m.service === service && !(m.is_sold_out || m.is_full));
  const candidates = items.filter((m: any) => conflicts(profile, m.dish).length === 0);
  const EN_SVC: Record<string, string> = { breakfast: "Breakfast", lunch: "Lunch", snack: "Snack", dinner: "Dinner" };
  const wd = new Date(date + "T12:00:00Z").getUTCDay();
  const FR_D = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"], EN_D = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const label = body.lang === "en" ? `${EN_SVC[service] ?? service} ${date === today ? "today" : date === tomorrow ? "tomorrow" : `on ${EN_D[wd]}`}` : `${svc[service]?.label ?? service} ${date === today ? "d'aujourd'hui" : date === tomorrow ? "de demain" : `de ${FR_D[wd]}`}`;
  if (!candidates.length) return json({ ok: true, date, service, label, intro: "Aucun plat de ce repas ne correspond à tes allergies ou à ton régime 😕 Parle-en à la cuisine.", items: [] });

  // Historique : 60 jours, avec les notes
  const { data: hist } = await db.from("tickets").select("used_at, dish:dishes(name), rating:ratings(stars)")
    .eq("user_id", user.id).eq("status", "used").gt("used_at", new Date(Date.now() - 60 * 86400e3).toISOString()).order("used_at", { ascending: false }).limit(30);
  const en = body.lang === "en";
  const input = {
    langue: en ? "anglais" : "français",
    eleve: { prenom: String(profile?.full_name ?? "").split(" ")[0], allergies: profile?.allergies ?? [], regime: profile?.diets ?? [], solde: w?.balance ?? 0 },
    repas: label,
    candidats: candidates.map((m: any) => ({ menu_item_id: m.id, plat: m.dish?.name, composition: m.dish?.composition, kcal: m.dish?.kcal, prix: m.price })),
    historique: (hist ?? []).map((h: any) => ({ date: String(h.used_at).slice(0, 10), plat: h.dish?.name, note: h.rating?.[0]?.stars ?? h.rating?.stars ?? null })),
  };
  const hash = await sha256(JSON.stringify(input));
  const { data: cached } = await db.from("ai_meal_suggestions").select("result, input_hash").eq("user_id", user.id).eq("service_date", date).eq("service", service).maybeSingle();
  if (cached && cached.input_hash === hash && !body.refresh) return json({ ok: true, cached: true, ...cached.result });

  const apiKey = Deno.env.get("ANTHROPIC_API_KEY") ?? (await db.rpc("_anthropic_key")).data ?? undefined;
  if (!apiKey) return fail("NO_KEY", "Clé Anthropic non configurée.", 500);
  try {
    const res = await new Anthropic({ apiKey }).beta.messages.create({
      model: MODEL, max_tokens: 4000, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default",
      output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMA } }, system: SYSTEM + (en ? "\nIMPORTANT : réponds entièrement en anglais (intro et raisons), en tutoyant (you)." : ""),
      messages: [{ role: "user", content: `Propose-lui ses plats pour le ${label}.\n<donnees>\n${JSON.stringify(input)}\n</donnees>` }],
    } as any);
    const text = res.content.find((b: any) => b.type === "text") as { text: string } | undefined;
    if (res.stop_reason === "refusal" || !text) return fail("AI_EMPTY", "Suggestions indisponibles.", 502);
    const out = JSON.parse(text.text);
    const byId = new Map(candidates.map((m: any) => [m.id, m]));
    const picks = (out.suggestions as any[]).filter((x) => byId.has(x.menu_item_id)).slice(0, 3).map((x) => {
      const m: any = byId.get(x.menu_item_id);
      return { menu_item_id: m.id, dish: m.dish?.name, price: m.price, photo_url: m.dish?.photo_url, raison: x.raison };
    });
    const result = { date, service, label, intro: out.intro, items: picks };
    await db.from("ai_meal_suggestions").upsert({ user_id: user.id, service_date: date, service, input_hash: hash, result, created_at: new Date().toISOString() });
    return json({ ok: true, cached: false, ...result });
  } catch (e) {
    console.error("meal-suggest", e);
    return fail("AI_ERROR", "Suggestions indisponibles pour le moment.", 502);
  }
});
