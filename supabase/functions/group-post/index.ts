// POST /functions/v1/group-post  { supply_event_id }  (en-tête x-jean-secret)
// Relaie une étape des appels fournisseurs dans le groupe WhatsApp de l'équipe (si « #vatel » a été envoyé dans un groupe).
import { adminClient, json } from "../_shared/http.ts";

const db = adminClient();
const SKIP = new Set(["dialogue"]); // la conversation détaillée reste dans l'appli

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ ok: false }, 405);
  const internal = req.headers.get("x-jean-secret");
  const { data: secret } = await db.rpc("_jean_secret");
  if (!internal || !secret || internal !== secret) return json({ ok: false }, 401);
  const body = await req.json().catch(() => ({}));
  const { data: e } = await db.from("supply_events").select("kind, message").eq("id", body.supply_event_id).maybeSingle();
  if (!e || SKIP.has(e.kind)) return json({ ok: true, skipped: true });
  const { data: s } = await db.from("settings").select("value").eq("key", "jean").single();
  const cfg = (s?.value ?? {}) as any;
  const token = Deno.env.get("GREEN_API_TOKEN_JEAN");
  if (!cfg.group_id || !cfg.green_api_url || !cfg.green_api_id || !token) return json({ ok: true, skipped: true });
  const message = `📞 *Appels fournisseurs*\n${e.message}`;
  await fetch(`${cfg.green_api_url}/waInstance${cfg.green_api_id}/sendMessage/${token}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chatId: cfg.group_id, message }),
  }).catch(() => {});
  await db.from("whatsapp_messages").insert({ phone: cfg.group_id, direction: "out", body: message.slice(0, 4000) });
  return json({ ok: true });
});
