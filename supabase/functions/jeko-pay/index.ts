// POST /functions/v1/jeko-pay  (JWT de l'utilisateur)
// Recharge du compte cantine par Mobile Money via Jèko (API direct : le client valide sur son téléphone).
//   { action: "create", amount, method, phone, child_id? } → { ok, mode: "redirect" | "ussd", redirect_url, reference }
//   { action: "status", reference }                         → { ok, status, amount, balance? }
// Secrets : JEKO_API_KEY, JEKO_API_KEY_ID, JEKO_STORE_ID ; SITE_URL (adresse du site, pour les pages de retour).
// Les règles (montant, enfant lié, Face ID, cadence) sont vérifiées en base par payment_start ;
// le crédit n'est fait que par _payment_success (webhook signé, ou statut relu ici chez Jèko).
import { createClient } from "jsr:@supabase/supabase-js@2";
import { adminClient, fail, json, corsHeaders, requestUser } from "../_shared/http.ts";

const JEKO_API = "https://api.jeko.africa/partner_api";
const METHODS = ["wave", "orange", "mtn", "moov", "djamo"] as const;
type Method = (typeof METHODS)[number];
const PREFIX: Partial<Record<Method, string>> = { orange: "07", mtn: "05", moov: "01" };
const NAME: Record<Method, string> = { wave: "Wave", orange: "Orange Money", mtn: "MTN MoMo", moov: "Moov Money", djamo: "Djamo" };
const SITE = (Deno.env.get("SITE_URL") ?? "https://vatel-cantine.netlify.app").replace(/\/$/, "");
const db = adminClient();

const configured = () => !!(Deno.env.get("JEKO_API_KEY") && Deno.env.get("JEKO_API_KEY_ID") && Deno.env.get("JEKO_STORE_ID"));
const jekoHeaders = () => ({
  "X-API-KEY": Deno.env.get("JEKO_API_KEY") ?? "",
  "X-API-KEY-ID": Deno.env.get("JEKO_API_KEY_ID") ?? "",
  "Content-Type": "application/json",
});

// « 07 01 02 03 04 », « 0701020304 », « +2250701020304 » → « +2250701020304 »
function normalizePhone(raw: unknown): string | null {
  let d = String(raw ?? "").replace(/\D/g, "");
  if (d.startsWith("225") && d.length === 13) d = d.slice(3);
  return /^(01|05|07)\d{8}$/.test(d) ? `+225${d}` : null;
}

function friendly(id: string | undefined): string {
  switch (id) {
    case "third_party_payment_provider_error":
      return "L'opérateur n'a pas pu lancer le paiement. Vérifiez le numéro et l'opérateur, puis réessayez.";
    case "validation_error":
      return "Les informations de paiement sont invalides. Vérifiez le numéro.";
    case "unauthorized": case "business_not_enabled_for_api_access": case "store_not_found": case "partner_api_ip_not_whitelisted":
      return "Le paiement en ligne est momentanément indisponible. Rechargez à la caisse en attendant.";
    default:
      return "Le paiement n'a pas pu être lancé. Réessayez dans un instant.";
  }
}

async function create(req: Request, body: any) {
  const method = String(body.method ?? "") as Method;
  const phone = normalizePhone(body.phone);
  if (!METHODS.includes(method)) return fail("INVALID_METHOD", "Moyen de paiement non pris en charge.");
  if (!phone) return fail("INVALID_PHONE", "Numéro invalide : un numéro mobile ivoirien à 10 chiffres (01, 05 ou 07…).");
  const prefix = PREFIX[method];
  if (prefix && phone.slice(4, 6) !== prefix) {
    return fail("WRONG_OPERATOR", `Ce numéro n'est pas un numéro ${NAME[method]} (il doit commencer par ${prefix}).`);
  }
  // Interrupteur de l'admin (Paramètres) : tant qu'il est sur « simulation », la page reste en mode démo
  const { data: mm } = await db.from("settings").select("value").eq("key", "mobile_money").maybeSingle();
  if ((mm?.value as { mode?: string } | null)?.mode !== "jeko" || !configured()) {
    return fail("NOT_CONFIGURED", "Le paiement en ligne n'est pas encore activé.", 503);
  }

  // Règles vérifiées en base, avec l'identité de l'utilisateur (auth.uid())
  const userDb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    auth: { persistSession: false }, global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
  });
  const { data: start, error } = await userDb.rpc("payment_start", {
    p_amount: Math.round(Number(body.amount)), p_method: method, p_phone: phone, p_child: body.child_id ?? null,
  });
  if (error) { console.error("payment_start", error.message); return fail("START", "Le paiement n'a pas pu être préparé.", 500); }
  if (!start?.ok) return json(start, 400);

  const reference = start.reference as string;
  const back = `${SITE}/app/recharger?ref=${encodeURIComponent(reference)}`;
  const res = await fetch(`${JEKO_API}/payment_requests`, {
    method: "POST",
    headers: jekoHeaders(),
    body: JSON.stringify({
      storeId: Deno.env.get("JEKO_STORE_ID"),
      amountCents: start.amount * 100, // Jèko compte en centimes, même en franc CFA
      currency: "XOF",
      reference,
      paymentDetails: {
        type: "redirect",
        data: { paymentMethod: method, forceProviderDirect: true, payerPhone: phone,
                successUrl: `${back}&issue=succes`, errorUrl: `${back}&issue=erreur` },
      },
    }),
  });
  const pr = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error("jeko create", res.status, pr?.id, pr?.message);
    await db.rpc("_payment_error", { p_reference: reference, p_reason: pr?.id ?? `http_${res.status}` });
    return fail("PROVIDER", friendly(pr?.id), 502);
  }
  await db.from("payments").update({ payment_request_id: pr.id }).eq("reference", reference);
  return json({ ok: true, reference, mode: method === "mtn" || method === "moov" ? "ussd" : "redirect", redirect_url: pr.redirectUrl ?? null });
}

// Un échec n'envoie pas de webhook : on relit le statut chez Jèko (au plus toutes les 10 s par paiement)
async function status(userId: string, body: any) {
  const reference = String(body.reference ?? "");
  const { data: p } = await db.from("payments")
    .select("reference, payer_id, beneficiary_id, amount, status, payment_request_id, last_checked_at, error_reason")
    .eq("reference", reference).maybeSingle();
  if (!p || (p.payer_id !== userId && p.beneficiary_id !== userId)) return fail("NOT_FOUND", "Paiement introuvable.", 404);

  if (p.status === "pending" && p.payment_request_id && configured()
      && (!p.last_checked_at || Date.now() - new Date(p.last_checked_at).getTime() >= 10_000)) {
    await db.from("payments").update({ last_checked_at: new Date().toISOString() }).eq("reference", reference);
    const res = await fetch(`${JEKO_API}/payment_requests/${p.payment_request_id}`, { headers: jekoHeaders() });
    if (res.ok) {
      const pr = await res.json();
      if (pr.status === "success" && pr.transaction) {
        await db.rpc("_payment_success", { p_reference: reference, p_payment_request_id: pr.id,
          p_amount_cents: pr.transaction.amount?.amount ?? null, p_tx_id: pr.transaction.id ?? null, p_method: pr.paymentMethod ?? null });
      } else if (pr.status === "error") {
        await db.rpc("_payment_error", { p_reference: reference, p_reason: pr.errorReason ?? "error" });
      }
    }
  }
  const { data: fresh } = await db.from("payments").select("status, amount, error_reason, beneficiary_id").eq("reference", reference).single();
  const { data: w } = await db.from("wallets").select("balance").eq("user_id", userId).maybeSingle();
  return json({ ok: true, status: fresh.status, amount: fresh.amount, for_child: fresh.beneficiary_id !== userId,
                reason: fresh.error_reason, balance: w?.balance ?? null });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return fail("METHOD", "POST uniquement", 405);
  const user = await requestUser(req);
  if (!user) return fail("AUTH_REQUIRED", "Connexion requise.", 401);
  try {
    const body = await req.json().catch(() => ({}));
    if (body.action === "create") return await create(req, body);
    if (body.action === "status") return await status(user.id, body);
    return fail("ACTION", "Action inconnue.");
  } catch (e) {
    console.error("jeko-pay", e);
    return fail("ERROR", "Erreur inattendue. Réessayez.", 500);
  }
});
