// POST /functions/v1/jeko-webhook — confirmation définitive des paiements Jèko.
// À déclarer chez Jèko (Dashboard Business → Paramètres → API & Webhooks → Webhooks par magasin, magasin « Vatel ») :
//   https://punghxwtknejxkedaoty.supabase.co/functions/v1/jeko-webhook
// Secret de ce webhook : JEKO_WEBHOOK_SECRET. Déployée SANS vérification JWT : la sécurité vient de la signature HMAC.
import { adminClient } from "../_shared/http.ts";

const db = adminClient();
const enc = new TextEncoder();

// HMAC-SHA256 du corps brut, en hexadécimal minuscule
async function hmacHex(secret: string, raw: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(raw));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
function same(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method !== "POST") return reply({ error: "Method not allowed" }, 405);
  const secret = Deno.env.get("JEKO_WEBHOOK_SECRET")?.trim(); // un espace collé avec le secret ne casse pas tout
  if (!secret) { console.error("JEKO_WEBHOOK_SECRET manquant"); return reply({ error: "Not configured" }, 500); }

  const raw = await req.text(); // la signature porte sur le corps brut, avant JSON.parse
  const sig = (req.headers.get("Jeko-Signature") ?? "").trim().toLowerCase();
  if (!sig || !same(sig, await hmacHex(secret, raw))) return reply({ error: "Invalid signature" }, 401);

  const event = req.headers.get("Jeko-Event");
  if (event !== "TRANSACTION_COMPLETED") return reply({ received: true, ignored: event });

  let tx: any;
  try { tx = JSON.parse(raw); } catch { return reply({ error: "Invalid JSON" }, 400); }

  const reference = tx?.transactionDetails?.reference;
  // Le franc CFA uniquement (un montant dans une autre devise ne doit jamais créditer)
  const currency = tx?.amount?.currency ?? tx?.currency;
  if (currency && currency !== "XOF") {
    console.error("jeko-webhook: devise inattendue", reference, currency);
    return reply({ received: true, ignored: "currency" });
  }
  if (tx?.transactionType === "payment" && tx?.status === "success" && typeof reference === "string" && reference.startsWith("VAT-")) {
    const { data, error } = await db.rpc("_payment_success", {
      p_reference: reference, p_payment_request_id: tx.transactionDetails?.id ?? null,
      p_amount_cents: tx.amount?.amount ?? null, p_tx_id: tx.id ?? null, p_method: tx.paymentMethod ?? null,
    });
    if (error) { console.error("jeko-webhook", reference, error.message); return reply({ error: "retry" }, 500); } // Jèko réessaie
    console.log("jeko-webhook", reference, data?.code);
  }
  return reply({ received: true });
});
