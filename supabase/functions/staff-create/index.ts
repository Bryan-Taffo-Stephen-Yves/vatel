// POST /functions/v1/staff-create  (JWT admin)  { full_name, job, phone? }
// Crée le compte d'un membre du personnel (agent d'entretien, vigile…) qui n'a pas forcément de smartphone :
// compte sans mot de passe connu (il s'identifie au comptoir avec sa carte QR), inscrit au repas du personnel.
// Renvoie son code DB-… (imprimé sur sa carte). S'il a un smartphone, il pourra se connecter plus tard via « mot de passe oublié ».
import { adminClient, corsHeaders, fail, json, requestUser } from "../_shared/http.ts";

const JOBS = ["entretien", "securite", "administration", "cuisine", "autre"];
const db = adminClient();

function normalizePhone(raw: unknown): string | null {
  let d = String(raw ?? "").replace(/\D/g, "");
  if (!d) return null;
  if (d.startsWith("225") && d.length === 13) d = d.slice(3);
  return /^(01|05|07|27|25|21)\d{8}$/.test(d) ? `+225${d}` : "invalid";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return fail("METHOD", "POST uniquement", 405);
  const user = await requestUser(req);
  if (!user) return fail("AUTH_REQUIRED", "Connexion requise.", 401);
  const { data: me } = await db.from("profiles").select("role, is_blocked").eq("id", user.id).single();
  if (!me || me.is_blocked || me.role !== "admin") return fail("FORBIDDEN", "Réservé à l'administration.", 403);

  const body = await req.json().catch(() => ({}));
  const fullName = String(body.full_name ?? "").trim().replace(/\s+/g, " ").slice(0, 80);
  const job = String(body.job ?? "");
  const phone = normalizePhone(body.phone);
  if (fullName.length < 3) return fail("INVALID_NAME", "Indiquez le nom complet.");
  if (!JOBS.includes(job)) return fail("INVALID_JOB", "Choisissez une fonction.");
  if (phone === "invalid") return fail("INVALID_PHONE", "Numéro invalide (10 chiffres).");
  if (phone) {
    const { data: taken } = await db.from("profiles").select("id").eq("phone", phone).maybeSingle();
    if (taken) return fail("PHONE_TAKEN", "Ce numéro a déjà un compte : inscrivez plutôt ce compte au repas du personnel.");
  }

  const email = `personnel-${crypto.randomUUID().slice(0, 8)}@personnel.vatel.ci`;
  const { data: created, error } = await db.auth.admin.createUser({
    email, password: crypto.randomUUID() + crypto.randomUUID(), email_confirm: true,
    user_metadata: { full_name: fullName, ...(phone ? { phone } : {}) },
  });
  if (error || !created.user) { console.error("staff-create", error?.message); return fail("CREATE", "Le compte n'a pas pu être créé.", 500); }

  const { data: p, error: upErr } = await db.from("profiles").update({ staff_job: job }).eq("id", created.user.id)
    .select("id, full_name, short_code, staff_job").single();
  if (upErr || !p) { console.error("staff-create profile", upErr?.message); return fail("PROFILE", "Compte créé, mais inscription au repas impossible.", 500); }
  // Téléphone donné : WhatsApp relié à Jean tout de suite (question du matin, sans passer par l'appli)
  if (phone) {
    const { data: used } = await db.from("whatsapp_links").select("user_id").eq("phone", phone).maybeSingle();
    if (!used) await db.from("whatsapp_links").insert({ user_id: p.id, phone });
  }
  await db.from("audit_log").insert({ actor_id: user.id, action: "staff_create", target: p.id, payload: { job } });
  return json({ ok: true, id: p.id, full_name: p.full_name, short_code: p.short_code, job: p.staff_job });
});
