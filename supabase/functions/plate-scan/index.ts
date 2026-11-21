// POST /functions/v1/plate-scan  (JWT agent, chef ou admin)
// Gaspillage dans l'assiette : photo d'un plateau rendu → Claude reconnaît le plat parmi le menu du jour et estime,
// élément par élément, la part NON mangée. La photo n'est ni enregistrée ni gardée : seuls les chiffres le sont.
// Corps (équipe) : { image: base64 (sans préfixe data:), media_type: "image/jpeg" | "image/png" | "image/webp" }
// Corps (élève, photo jointe à son avis) : { ticket_id, photo_path } — photo déjà dans le stockage « reviews », plat connu par le ticket.
import Anthropic from "npm:@anthropic-ai/sdk";
import { encodeBase64 } from "jsr:@std/encoding@1/base64";
import { adminClient, corsHeaders, fail, json, requestUser } from "../_shared/http.ts";

const MODEL = "claude-opus-5-5";
const db = adminClient();

const SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["est_une_assiette", "photo_avant_repas", "menu_item_id", "plat", "elements", "reste_global_pct", "remarque"],
  properties: {
    est_une_assiette: { type: "boolean", description: "La photo montre bien une assiette / un plateau de repas" },
    photo_avant_repas: { type: "boolean", description: "true si c'est visiblement une assiette juste servie (bien dressée, aucune trace de repas), pas une assiette rendue" },
    menu_item_id: { type: ["string", "null"], description: "id du plat du menu du jour reconnu, ou null si aucun ne correspond" },
    plat: { type: "string", description: "Nom du plat reconnu (ou ce que tu vois)" },
    elements: { type: "array", description: "Composants visibles ou attendus du plat", items: {
      type: "object", additionalProperties: false, required: ["nom", "reste_pct"],
      properties: { nom: { type: "string", description: "ex. riz, poisson, sauce, alloco" }, reste_pct: { type: "integer", description: "0 = tout mangé, 100 = pas touché" } } } },
    reste_global_pct: { type: "integer", description: "Part du repas non mangée, 0 à 100" },
    remarque: { type: "string", description: "Une phrase utile pour le chef (ex. « le poisson est presque entier »), sans juger l'élève" },
  },
} as const;

const SYSTEM = `Tu aides la cuisine d'une cantine d'école hôtelière à Abidjan à mesurer le gaspillage DANS L'ASSIETTE.
On te montre la photo d'une assiette rendue après le repas. Repère le plat parmi les plats du menu du jour fournis, puis estime pour chaque composant (féculent, protéine, sauce, légumes, accompagnement) la part qui n'a PAS été mangée, en pourcentage de la portion servie.
Assiette vide ou presque : 0 à 10 %. Plat à peine touché : 80 à 100 %. Les os, arêtes et épluchures ne comptent pas comme reste.
Si la photo ne montre pas une assiette de repas, mets est_une_assiette à false. Si c'est visiblement une assiette juste servie (bien dressée, aucune trace de repas : couverts propres, pas de miettes ni de sauce étalée), mets photo_avant_repas à true. Réponds en français simple. N'invente pas un plat absent du menu : mets menu_item_id à null si aucun ne correspond.`;

const SERVICES = ["breakfast", "lunch", "snack", "dinner"];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return fail("METHOD", "POST uniquement", 405);
  const user = await requestUser(req);
  if (!user) return fail("AUTH_REQUIRED", "Connexion requise.", 401);
  const { data: me } = await db.from("profiles").select("role, is_blocked").eq("id", user.id).single();
  if (!me || me.is_blocked) return fail("FORBIDDEN", "Compte indisponible.", 403);
  const body = await req.json().catch(() => ({}));
  const today = new Date().toISOString().slice(0, 10); // Abidjan = UTC+0

  // ── Élève : photo jointe à son avis (son ticket, plat déjà connu) ──
  let image = String(body.image ?? "");
  let media = ["image/jpeg", "image/png", "image/webp"].includes(body.media_type) ? body.media_type : "image/jpeg";
  let ticket: any = null;
  if (body.ticket_id) {
    const { data: t } = await db.from("tickets").select("id, user_id, status, service, service_date, menu_item_id, dish_id, used_at").eq("id", body.ticket_id).maybeSingle();
    if (!t || t.user_id !== user.id || t.status !== "used" || !t.dish_id) return fail("FORBIDDEN", "Ticket introuvable.", 403);
    const path = String(body.photo_path ?? "");
    if (!path.startsWith(`${user.id}/`)) return fail("FORBIDDEN", "Photo introuvable.", 403);
    const { data: blob, error } = await db.storage.from("reviews").download(path);
    if (error || !blob) return fail("PHOTO", "Photo introuvable.", 404);
    if (blob.size > 4_500_000) return fail("TOO_BIG", "Photo trop lourde.");
    image = encodeBase64(new Uint8Array(await blob.arrayBuffer())); media = "image/jpeg"; ticket = t;
  } else if (!["agent", "chef", "admin"].includes(me.role)) return fail("FORBIDDEN", "Réservé à l'équipe.", 403);
  if (image.length < 1000) return fail("INVALID", "Photo manquante.");
  if (image.length > 6_000_000) return fail("TOO_BIG", "Photo trop lourde.");

  // Plats candidats : le plat du ticket (avis), sinon tous les plats du jour
  let q = db.from("menu_items").select("id, service, dish:dishes(id, name, composition), menu:menus!inner(status)").eq("menu.status", "published");
  q = ticket ? (ticket.menu_item_id ? q.eq("id", ticket.menu_item_id) : q.eq("dish_id", ticket.dish_id).limit(1)) : q.eq("service_date", today);
  const { data: menu } = await q;
  const items = (menu ?? []).map((m: any) => ({ menu_item_id: m.id, repas: m.service, plat: m.dish?.name, composition: m.dish?.composition }));

  const apiKey = Deno.env.get("ANTHROPIC_API_KEY") ?? (await db.rpc("_anthropic_key")).data ?? undefined;
  if (!apiKey) return fail("NO_KEY", "Clé Anthropic non configurée.", 500);
  let out: any;
  try {
    const res = await new Anthropic({ apiKey }).beta.messages.create({
      model: MODEL, max_tokens: 3000, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default",
      output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMA } }, system: SYSTEM,
      messages: [{ role: "user", content: [
        { type: "image", source: { type: "base64", media_type: media, data: image } },
        { type: "text", text: ticket ? `Plat servi à cet élève (photo jointe à son avis) :\n${JSON.stringify(items)}\nAnalyse son assiette.` : `Plats du menu d'aujourd'hui :\n${JSON.stringify(items)}\nAnalyse cette assiette rendue.` },
      ] }],
    } as any);
    const text = res.content.find((b: any) => b.type === "text") as { text: string } | undefined;
    if (res.stop_reason === "refusal" || !text) return fail("AI_EMPTY", "Analyse indisponible.", 502);
    out = JSON.parse(text.text);
  } catch (e) {
    console.error("plate-scan", e);
    return fail("AI_ERROR", "Analyse indisponible pour le moment.", 502);
  }
  if (!out.est_une_assiette) return json({ ok: false, code: "NOT_A_PLATE", message: "Je ne vois pas d'assiette sur la photo. Reprends-la de plus près, bien au-dessus." });

  const clamp = (n: unknown) => Math.max(0, Math.min(100, Math.round(Number(n) || 0)));
  const hit = (ticket ? (menu ?? [])[0] : (menu ?? []).find((m: any) => m.id === out.menu_item_id)) as any;
  const elements = (Array.isArray(out.elements) ? out.elements : []).slice(0, 8)
    .map((e: any) => ({ name: String(e.nom ?? "").trim().slice(0, 40), left_pct: clamp(e.reste_pct) })).filter((e: any) => e.name);
  const row = {
    service: hit?.service ?? (SERVICES.includes(body.service) ? body.service : null),
    menu_item_id: hit?.id ?? null, dish_id: hit?.dish?.id ?? null,
    left_pct: clamp(out.reste_global_pct), items: elements, note: String(out.remarque ?? "").slice(0, 300), created_by: user.id,
    ...(ticket ? { ticket_id: ticket.id, source: "avis", service: ticket.service, service_date: ticket.service_date ?? String(ticket.used_at).slice(0, 10),
      dish_id: ticket.dish_id, before_meal: !!out.photo_avant_repas } : {}),
  };
  const { data: saved, error } = ticket
    ? await db.from("plate_scans").upsert(row, { onConflict: "ticket_id" }).select("id").single()
    : await db.from("plate_scans").insert(row).select("id").single();
  if (error) { console.error("plate-scan insert", error); return fail("SAVE", "Analyse faite, mais pas enregistrée.", 500); }

  // Moyenne du jour pour ce plat (pour situer cette assiette)
  let avg: number | null = null;
  if (row.dish_id) {
    const { data: same } = await db.from("plate_scans").select("left_pct").eq("dish_id", row.dish_id).eq("service_date", (row as any).service_date ?? today).eq("before_meal", false);
    if ((same ?? []).length > 1) avg = Math.round((same ?? []).reduce((a: number, s: any) => a + s.left_pct, 0) / (same ?? []).length);
  }
  return json({ ok: true, id: saved.id, dish: hit?.dish?.name ?? out.plat, recognized: !!hit, left_pct: row.left_pct,
    items: elements, note: row.note, today_avg: avg, before_meal: !!out.photo_avant_repas });
});
