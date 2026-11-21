// POST /functions/v1/supply-agent   (chef / admin, JWT)
//  { action: "chat", text }  → l'équipe parle à l'agent d'achats depuis l'appli (même cerveau que dans le groupe WhatsApp)
// Le travail automatique (besoins, commandes, relances, secours, coursier) tourne en base : supply_agent_tick (pg_cron).
import { adminClient, corsHeaders, fail, json, requestUser } from "../_shared/http.ts";
import { supplyMessage } from "../_shared/supply-agent.ts";

const db = adminClient();

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return fail("METHOD", "POST uniquement", 405);
  const user = await requestUser(req);
  if (!user) return fail("AUTH_REQUIRED", "Connexion requise.", 401);
  const { data: me } = await db.from("profiles").select("full_name, role, is_blocked").eq("id", user.id).single();
  if (!me || me.is_blocked || !["chef", "admin"].includes(me.role)) return fail("FORBIDDEN", "Réservé à la cuisine.", 403);
  const body = await req.json().catch(() => ({}));

  if (body.action === "chat") {
    const text = String(body.text ?? "").trim().slice(0, 1000);
    if (!text) return fail("EMPTY", "Message vide.");
    if (!Deno.env.get("ANTHROPIC_API_KEY_JEAN") && !Deno.env.get("ANTHROPIC_API_KEY")) return fail("NO_KEY", "Clé Anthropic manquante dans les secrets Supabase.");
    const author = String(me.full_name ?? "Chef").split(" ")[0];
    const reply = await supplyMessage(text, author);
    return json({ ok: true, reply: reply ?? "Je n'ai rien à faire pour ce message. Demande-moi par exemple « où en est le riz ? » ou « commande 2 sacs de riz »." });
  }
  return fail("ACTION", "Action inconnue.");
});
