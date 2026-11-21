// POST /functions/v1/service-pilot  { question?: string }  → { ok, answer }
// Le pilote du service répond à la cuisine (à voix haute sur l'écran Admin → Pilote) à partir de l'état du service
// en direct (pilot_state, lu avec le JWT de la personne : rôle vérifié en base). Ne modifie rien : les actions se
// lancent d'un toucher sur l'écran (pilot_act).
import Anthropic from "npm:@anthropic-ai/sdk";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { adminClient, corsHeaders, fail, json } from "../_shared/http.ts";

const MODEL = "claude-opus-5-5";

const SYSTEM = `Tu es le pilote du service de Vatel, la cantine d'une école hôtelière à Abidjan. Tu parles au chef et à l'équipe pendant le service.
Tu reçois l'état du service en direct : minutes restantes, repas servis (total et sur les 15 dernières minutes), file d'attente et attente estimée,
commandes prêtes non récupérées, et pour chaque plat : portions prévues, vendues, restantes, rythme (portions servies par minute),
runout_min (dans combien de minutes il n'en restera plus), need (portions encore nécessaires d'ici la fin) et % laissé dans l'assiette.
Tu reçois aussi les suggestions déjà calculées et les dernières actions faites.
Règles :
- Réponds en 2 ou 3 phrases courtes, en français parlé, sans liste ni mise en forme : la réponse est lue à voix haute.
- Donne des chiffres exacts tirés des données (portions, heures au format 13h05, minutes). N'invente rien ; si les données ne permettent pas de répondre, dis-le simplement.
- Les seules actions possibles : relancer des portions d'un plat, mettre en avant un plat auprès des élèves qui n'ont pas encore mangé, appeler un renfort au comptoir, relancer les élèves dont la commande est prête. Termine par l'action la plus utile s'il y en a une (« Je te conseille de… »).
- Tutoie le chef.`;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return fail("METHOD", "POST uniquement", 405);
  const auth = req.headers.get("Authorization");
  if (!auth) return fail("AUTH_REQUIRED", "Connexion requise.", 401);
  const body = await req.json().catch(() => ({}));
  const question = String(body?.question ?? "").trim().slice(0, 300)
    || "Fais le point du service : ce qui va bien, et l'action la plus urgente.";

  // État lu avec le JWT de la personne : pilot_state vérifie le rôle (cuisine, caisse, admin)
  const userDb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: auth } }, auth: { persistSession: false },
  });
  const { data: state, error } = await userDb.rpc("pilot_state");
  if (error || !state || state.ok === false) return fail("FORBIDDEN", "Réservé à la cuisine et à l'administration.", 403);
  if (state.status !== "open") return json({ ok: true, answer: "Aucun service n'est en cours pour le moment. Je reprends dès le prochain service." });

  const apiKey = Deno.env.get("ANTHROPIC_API_KEY") ?? (await adminClient().rpc("_anthropic_key")).data ?? undefined;
  if (!apiKey) return fail("NO_KEY", "Clé Anthropic non configurée.", 500);
  try {
    const res = await new Anthropic({ apiKey }).beta.messages.create({
      model: MODEL, max_tokens: 600, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default",
      output_config: { effort: "low" }, system: SYSTEM,
      messages: [{ role: "user", content: `${question}\n\n<etat_du_service>\n${JSON.stringify(state)}\n</etat_du_service>` }],
    } as any);
    if (res.stop_reason === "refusal") return fail("AI_REFUSED", "Le pilote n'a pas pu répondre.");
    const text = (res.content as any[]).filter((b) => b.type === "text").map((b) => b.text).join(" ").trim();
    if (!text) return fail("AI_EMPTY", "Réponse vide du pilote.");
    return json({ ok: true, answer: text });
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) return fail("AI_AUTH", "Clé Anthropic refusée.", 500);
    if (e instanceof Anthropic.RateLimitError) return fail("AI_BUSY", "Le pilote est saturé, réessaie dans une minute.", 429);
    return fail("AI_ERROR", "Le pilote est indisponible.", 502);
  }
});
