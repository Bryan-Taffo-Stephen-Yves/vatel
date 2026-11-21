// POST /functions/v1/delivery   (chef / admin, JWT)
//  { action: "create" }                         → nouvelle tournée de démo (3 fournisseurs, 6 articles)
//  { action: "start", run_id }                  → itinéraire routier (OSRM) + départ du coursier simulé
//  { action: "message", run_id, text }          → message de l'équipe : Jean modifie la liste et répond
import { createClient } from "jsr:@supabase/supabase-js@2";
import { adminClient, corsHeaders, fail, json, requestUser } from "../_shared/http.ts";
import { planRoute } from "../_shared/route.ts";
import { teamMessage } from "../_shared/run-agent.ts";

const db = adminClient();

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return fail("METHOD", "POST uniquement", 405);
  // Tests depuis la base : en-tête x-jean-secret (secret du coffre), sinon JWT d'un chef / admin
  const internal = req.headers.get("x-jean-secret");
  let me: { full_name: string; role: string; is_blocked: boolean } | null = null;
  if (internal) {
    const { data: secret } = await db.rpc("_jean_secret");
    if (!secret || internal !== secret) return fail("FORBIDDEN", "Secret invalide.", 401);
    me = { full_name: "Test", role: "admin", is_blocked: false };
  } else {
    const user = await requestUser(req);
    if (!user) return fail("AUTH_REQUIRED", "Connexion requise.", 401);
    const { data } = await db.from("profiles").select("full_name, role, is_blocked").eq("id", user.id).single();
    me = data;
  }
  if (!me || me.is_blocked || !["chef", "admin"].includes(me.role)) return fail("FORBIDDEN", "Réservé à la cuisine.", 403);
  const body = await req.json().catch(() => ({}));

  if (body.action === "create" && !internal) {
    const userDb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: req.headers.get("Authorization")! } }, auth: { persistSession: false } });
    const { data, error } = await userDb.rpc("delivery_create_demo");
    if (error || !data?.ok) return fail("CREATE", data?.message ?? "Impossible de créer la tournée.");
    return json(data);
  }

  const runId = String(body.run_id ?? "");
  const { data: run } = await db.from("delivery_runs").select("id, status").eq("id", runId).maybeSingle();
  if (!run) return fail("NOT_FOUND", "Tournée introuvable.", 404);

  if (body.action === "start") {
    if (run.status !== "prete") return fail("ALREADY", "Le coursier est déjà parti.");
    const r = await planRoute(runId);
    if (!r.ok) return fail("ROUTE", r.message ?? "Itinéraire impossible.");
    await db.rpc("_delivery_start", { p_run: runId });
    return json({ ok: true });
  }

  if (body.action === "message") {
    const text = String(body.text ?? "").trim().slice(0, 500);
    if (!text) return fail("EMPTY", "Message vide.");
    const author = String(me.full_name).split(" ")[0];
    await db.from("delivery_events").insert({ run_id: runId, kind: "equipe_app", message: `💬 ${author} : ${text}`, author });
    const reply = await teamMessage(runId, text, author);
    return json({ ok: true, reply });
  }
  return fail("ACTION", "Action inconnue.");
});
