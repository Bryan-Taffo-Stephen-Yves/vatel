// POST /functions/v1/supplier-call
// Agent vocal « l'appeleur » : il appelle un fournisseur au nom de la cantine (Retell), demande prix et livraison,
// et l'appli décide (règles en base : _supplier_call_action). Accent et façon de parler ivoiriens.
//  - { action: "setup" }                          (chef/admin) crée / met à jour l'agent Retell « Dabali – Achats »
//  - { action: "call", order_id, simulate?, scenario? }  (chef/admin) appel réel, ou simulation (ok | cher | coursier)
//  - ?token=JEAN_VOICE_TOKEN&hook=tool            fonctions appelées par l'agent pendant l'appel (Retell)
//  - ?token=JEAN_VOICE_TOKEN&hook=event           fin d'appel / analyse (webhook Retell)
// Secrets : CLI_ANHTROPIC (ou RETELL_API_KEY) = clé Retell ; JEAN_VOICE_TOKEN.
import { adminClient, corsHeaders, fail, json, requestUser } from "../_shared/http.ts";

const db = adminClient();
const API = "https://api.retellai.com";
const FN = "https://punghxwtknejxkedaoty.supabase.co/functions/v1/supplier-call";
const AGENT_NAME = "Dabali – Achats fournisseurs";
const retellKey = () => Deno.env.get("RETELL_API_KEY") ?? Deno.env.get("CLI_ANHTROPIC") ?? "";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** « 1 sac de riz » plutôt que « 1 sacs de riz » */
const sing = (q: number, l: string) => (Number(q) <= 1 ? l.replace(/^(\S+?)eaux(\s|$)/, "$1eau$2").replace(/^(\S+?[^s])s(\s|$)/, "$1$2") : l);
const fcfa = (n: number) => `${Math.round(n).toLocaleString("fr-FR").replace(/ /g, " ")} francs`;

async function retell(path: string, init: RequestInit = {}) {
  const r = await fetch(`${API}${path}`, { ...init, headers: { Authorization: `Bearer ${retellKey()}`, "Content-Type": "application/json", ...(init.headers ?? {}) } });
  const t = await r.text(); let body: any = t; try { body = JSON.parse(t); } catch { /* texte */ }
  return { status: r.status, body };
}

const PROMPT = `Tu es l'assistant de la cantine Dabali (école hôtelière d'Abidjan). Tu appelles {{fournisseur}}, un fournisseur habituel, pour passer une commande. Tu es Ivoirien : tu parles le français d'Abidjan, chaleureux, poli et direct, comme au marché. Phrases courtes, une question à la fois. Tu peux dire « Bonjour, ça va un peu ? », « On va faire comment pour le prix ? », « Y a pas de problème », « Merci beaucoup, on est ensemble ». Tu comprends le nouchi. Tu vouvoies au début, tu peux tutoyer si le fournisseur tutoie.

Dès le début : présente-toi (« l'assistant de la cantine Dabali ») et dis que l'appel est enregistré.

La commande (prix habituels de la cantine, pour t'aider à négocier) :
{{articles}}
Total habituel : {{budget}}. Paiement : {{paiement}}.

Déroulé :
1. Annonce la commande clairement, article par article.
2. Demande le prix total. Si c'est plus cher que d'habitude, négocie UNE fois poliment en citant le prix habituel (« d'habitude on prend à … chez vous, vous pouvez faire un effort ? »). Puis appelle record_quote avec le dernier prix total annoncé.
3. Suis la consigne renvoyée par record_quote : si le prix est accepté, demande quand il peut livrer à la cantine (Cocody) et appelle confirm_order. Si on doit vérifier, dis que tu vérifies avec l'équipe et que tu rappelles très vite : ne confirme rien.
4. S'il ne peut pas livrer (pas de moto, pas de carburant…), appelle cannot_deliver : la cantine envoie un coursier.
5. Un article manque : item_unavailable. Il demande de rappeler plus tard : call_back_at. Il refuse : refuse.
6. Remercie et raccroche (raccrocher).

Règles strictes : tu ne paies jamais et tu ne donnes aucun numéro de compte ; tu ne commandes que les articles de la liste ; tu n'inventes aucun prix ; tu dis les montants en francs CFA, à l'oral (« cinquante-six mille francs »).`;

const BEGIN = "Allô, bonjour ! Ici l'assistant de la cantine Dabali, l'école hôtelière. Je vous appelle pour notre commande, l'appel est enregistré. Ça va un peu ?";

const TOOLS = (url: string) => [
  { type: "end_call", name: "raccrocher", description: "Raccroche quand la conversation est terminée." },
  ...[
    { name: "record_quote", description: "Enregistre le prix TOTAL proposé par le fournisseur pour toute la commande. Renvoie la décision de la cantine (accepter ou vérifier).",
      parameters: { type: "object", properties: { total: { type: "number", description: "Prix total en francs CFA" }, details: { type: "string", description: "Prix par article si donnés" } }, required: ["total"] }, speak: "Je note." },
    { name: "confirm_order", description: "Confirme la commande après un prix accepté.",
      parameters: { type: "object", properties: { delivery_at: { type: "string", description: "Quand il livre, ex. demain 9h" },
        delivery_mode: { type: "string", enum: ["fournisseur", "coursier", "retrait"] }, payment: { type: "string", description: "ex. Wave à la livraison" } }, required: ["delivery_at"] } },
    { name: "cannot_deliver", description: "Le fournisseur ne peut pas livrer : la cantine enverra un coursier.",
      parameters: { type: "object", properties: { raison: { type: "string" } }, required: [] } },
    { name: "item_unavailable", description: "Un article de la liste n'est pas disponible.",
      parameters: { type: "object", properties: { article: { type: "string" } }, required: ["article"] } },
    { name: "call_back_at", description: "Le fournisseur demande de rappeler plus tard.",
      parameters: { type: "object", properties: { heure: { type: "string" } }, required: ["heure"] } },
    { name: "refuse", description: "Le fournisseur refuse la commande.",
      parameters: { type: "object", properties: { raison: { type: "string" } }, required: [] } },
  ].map((f) => ({ type: "custom", name: f.name, description: f.description, url, method: "POST", parameters: f.parameters,
    speak_during_execution: !!f.speak, ...(f.speak ? { execution_message_description: f.speak } : {}), speak_after_execution: true, timeout_ms: 15000 })),
];

/** Voix : d'abord un accent ivoirien, sinon africain francophone, sinon français ; sinon la voix de Jean */
function pickVoice(voices: any[]): { chosen: any | null; candidates: any[] } {
  const txt = (v: any) => `${v.voice_name ?? ""} ${v.accent ?? ""} ${v.description ?? ""} ${(v.labels && JSON.stringify(v.labels)) ?? ""}`.toLowerCase();
  const tiers = [/ivoir|ivory|abidjan|côte d|cote d/, /african|afrique|africain|senegal|sénégal|cameroun|cameroon|nigerian|ghana|west/, /french|français|france/];
  for (const re of tiers) {
    const c = voices.filter((v) => re.test(txt(v)));
    if (c.length) return { chosen: c.find((v) => /male|homme/.test(txt(v)) && !/female|femme/.test(txt(v))) ?? c[0], candidates: c.slice(0, 8) };
  }
  return { chosen: null, candidates: [] };
}

async function setup() {
  const key = retellKey();
  if (!key) return { ok: false, erreur: "Clé Retell manquante (secret CLI_ANHTROPIC ou RETELL_API_KEY)." };
  const token = Deno.env.get("JEAN_VOICE_TOKEN");
  if (!token) return { ok: false, erreur: "Secret JEAN_VOICE_TOKEN manquant." };
  const { data: s } = await db.from("settings").select("value").eq("key", "supplier_calls").single();
  const cfg = (s?.value ?? {}) as any;

  // Modèle et voix de Jean comme référence
  const agents = await retell("/v2/list-agents", { method: "POST", body: "{}" });
  const all: any[] = Array.isArray(agents.body) ? agents.body : (agents.body?.items ?? []);
  const jean = all.filter((a) => a.agent_name === "Dabalix - Réservation de repas").sort((a, b) => (b.version ?? 0) - (a.version ?? 0))[0];
  let model: string | undefined; let jeanVoice: string | undefined;
  if (jean) {
    const full = jean.response_engine ? jean : (await retell(`/get-agent/${jean.agent_id}`)).body;
    jeanVoice = full?.voice_id;
    if (full?.response_engine?.llm_id) model = (await retell(`/get-retell-llm/${full.response_engine.llm_id}`)).body?.model;
  }
  const voicesRes = await retell("/list-voices");
  const voices: any[] = Array.isArray(voicesRes.body) ? voicesRes.body : (voicesRes.body?.items ?? []);
  const { chosen, candidates } = pickVoice(voices);
  const voiceId = cfg.voice_id ?? chosen?.voice_id ?? jeanVoice;

  const llmBody = { general_prompt: PROMPT, begin_message: BEGIN, general_tools: TOOLS(`${FN}?token=${token}&hook=tool`), start_speaker: "agent", ...(model ? { model } : {}) };
  let llmId: string | undefined = cfg.llm_id;
  const llm = llmId ? await retell(`/update-retell-llm/${llmId}`, { method: "PATCH", body: JSON.stringify(llmBody) })
                    : await retell("/create-retell-llm", { method: "POST", body: JSON.stringify(llmBody) });
  if (llm.status >= 300) return { ok: false, etape: "llm", ...llm };
  llmId = llm.body?.llm_id ?? llmId;

  const agentBody = { agent_name: AGENT_NAME, response_engine: { type: "retell-llm", llm_id: llmId }, voice_id: voiceId, language: "fr-FR",
    webhook_url: `${FN}?token=${token}&hook=event` };
  let agentId: string | undefined = cfg.agent_id;
  const ag = agentId ? await retell(`/update-agent/${agentId}`, { method: "PATCH", body: JSON.stringify(agentBody) })
                     : await retell("/create-agent", { method: "POST", body: JSON.stringify(agentBody) });
  if (ag.status >= 300) return { ok: false, etape: "agent", ...ag, voix_proposees: candidates.map((v) => ({ id: v.voice_id, nom: v.voice_name, accent: v.accent })) };
  agentId = ag.body?.agent_id ?? agentId;

  await db.from("settings").update({ value: { ...cfg, agent_id: agentId, llm_id: llmId, voice_id: cfg.voice_id ?? null, voice_used: voiceId } }).eq("key", "supplier_calls");
  return { ok: true, agent_id: agentId, llm_id: llmId, modele: llm.body?.model ?? model, voix: voiceId,
    voix_choisie: chosen ? { id: chosen.voice_id, nom: chosen.voice_name, accent: chosen.accent } : "voix de Jean (aucune voix africaine trouvée)",
    voix_proposees: candidates.map((v) => ({ id: v.voice_id, nom: v.voice_name, accent: v.accent, genre: v.gender })) };
}

function articlesText(items: any[]) {
  return items.map((i) => `- ${String(i.qty).replace(".", ",")} ${sing(i.qty, i.label)} (d'habitude ${fcfa(i.usual_price)} l'unité${i.last_price ? `, dernier achat ${fcfa(i.last_price)}` : ""})`).join("\n");
}

async function realCall(order: any) {
  const { data: s } = await db.from("settings").select("value").eq("key", "supplier_calls").single();
  const cfg = (s?.value ?? {}) as any;
  if (!cfg.agent_id) return { ok: false, message: "Agent pas encore configuré : clique d'abord « Configurer l'agent »." };
  if (!cfg.from_number) return { ok: false, message: "Numéro Retell pas encore réglé (Paramètres de la page)." };
  const r = await retell("/v2/create-phone-call", { method: "POST", body: JSON.stringify({
    from_number: cfg.from_number, to_number: order.call_phone, override_agent_id: cfg.agent_id,
    metadata: { order_id: order.id },
    retell_llm_dynamic_variables: { fournisseur: order.supplier_name, articles: articlesText(order.items), budget: fcfa(order.budget), paiement: "Wave à la livraison", order_id: order.id },
  }) });
  if (r.status >= 300) return { ok: false, message: `Retell refuse l'appel (${r.status}) : ${typeof r.body === "string" ? r.body.slice(0, 200) : JSON.stringify(r.body).slice(0, 300)}` };
  const st = await db.rpc("_supplier_call_started", { p_order: order.id, p_call_id: r.body?.call_id ?? null, p_mode: "reel" });
  return (st.data as any)?.ok ? { ok: true, call_id: r.body?.call_id } : { ok: false, message: (st.data as any)?.message };
}

/** Appel simulé (démo sans numéro) : dialogue réaliste + mêmes règles de décision */
async function simulate(order: any, scenario: string) {
  const say = (who: string, t: string) => db.from("supply_events").insert({ order_id: order.id, kind: "dialogue", message: `${who} ${t}` });
  const act = (a: string, args: unknown) => db.rpc("_supplier_call_action", { p_order: order.id, p_action: a, p_args: args });
  const items = order.items as any[];
  const quote = scenario === "cher" ? Math.round(order.budget * 1.25 / 500) * 500 : Math.round(order.budget * 1.04 / 500) * 500;
  await sleep(2500);
  await say("🤖", "Allô, bonjour ! Ici l'assistant de la cantine Dabali. Je vous appelle pour notre commande, l'appel est enregistré. Ça va un peu ?");
  await sleep(3000); await say("👤", "Ça va oh, merci. C'est quoi on va vous donner aujourd'hui ?");
  await sleep(3000); await say("🤖", `On voudrait ${items.map((i) => `${String(i.qty).replace(".", ",")} ${sing(i.qty, i.label)}`).join(", ")}. Ça fait combien en tout ?`);
  await sleep(3500); await say("👤", `Pour tout ça là, c'est ${fcfa(scenario === "cher" ? Math.round(quote * 1.08 / 500) * 500 : quote)}.`);
  if (scenario === "cher") {
    await sleep(3000); await say("🤖", `Hum, d'habitude on prend à ${fcfa(order.budget)} chez vous. Vous pouvez faire un effort ?`);
    await sleep(3000); await say("👤", `Tout a augmenté cette semaine, je peux descendre à ${fcfa(quote)}, pas moins.`);
  }
  await sleep(2000);
  const q = (await act("record_quote", { total: quote })).data as any;
  if (q?.decision === "verifier") {
    await sleep(2500); await say("🤖", "D'accord, je vérifie avec l'équipe et je vous rappelle très vite. Merci beaucoup, on est ensemble !");
  } else if (scenario === "coursier") {
    await sleep(3000); await say("👤", "C'est bon pour le prix. Mais ma moto est en panne, je ne peux pas livrer aujourd'hui.");
    await act("cannot_deliver", { raison: "moto en panne" });
    await sleep(2500); await say("🤖", "Y a pas de problème, on vous envoie un coursier. Préparez tout, il arrive. Merci beaucoup !");
  } else {
    await sleep(3000); await say("🤖", "C'est bon pour nous. Vous pouvez livrer quand à la cantine, à Cocody ?");
    await sleep(3000); await say("👤", "Demain matin vers 9h, je vous apporte ça.");
    await act("confirm_order", { delivery_at: "demain vers 9h", delivery_mode: "fournisseur", payment: "Wave à la livraison" });
    await sleep(2500); await say("🤖", "Parfait. Le paiement se fait par Wave à la livraison. Merci beaucoup, on est ensemble !");
  }
  await sleep(1500);
  await db.rpc("_supplier_call_ended", { p_order: order.id, p_reason: null, p_recording: null,
    p_summary: q?.decision === "verifier" ? `Prix proposé ${fcfa(quote)}, au-dessus du budget : à valider par le chef.`
      : scenario === "coursier" ? `Prix ${fcfa(quote)} accepté ; le fournisseur ne peut pas livrer, un coursier va récupérer la commande.`
      : `Prix ${fcfa(quote)} accepté ; livraison demain vers 9h, paiement Wave.` });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return fail("METHOD", "POST uniquement", 405);
  const url = new URL(req.url);
  const hook = url.searchParams.get("hook");

  // ─── Appels de Retell (jeton dans l'adresse) ───
  if (hook) {
    const expected = Deno.env.get("JEAN_VOICE_TOKEN");
    if (!expected || url.searchParams.get("token") !== expected) return new Response("unauthorized", { status: 401 });
    const body = await req.json().catch(() => ({}));
    const call = body.call ?? {};
    const orderId = call.metadata?.order_id ?? call.retell_llm_dynamic_variables?.order_id;
    if (!orderId) return json({ erreur: "Appel sans commande associée." });
    if (hook === "tool") {
      const { data, error } = await db.rpc("_supplier_call_action", { p_order: orderId, p_action: String(body.name ?? ""), p_args: body.args ?? {} });
      return json(error ? { erreur: "Service indisponible, dis que tu rappelles." } : data);
    }
    if (hook === "event") {
      if (body.event === "call_ended") await db.rpc("_supplier_call_ended", { p_order: orderId, p_summary: null, p_recording: call.recording_url ?? null, p_reason: call.disconnection_reason ?? null });
      if (body.event === "call_analyzed") await db.rpc("_supplier_call_ended", { p_order: orderId, p_summary: call.call_analysis?.call_summary ?? null, p_recording: call.recording_url ?? null, p_reason: null });
      return json({ ok: true });
    }
    return json({ ok: false }, 400);
  }

  // ─── Actions de l'appli (chef / admin) ───
  const internal = req.headers.get("x-jean-secret");
  if (internal) {
    const { data: secret } = await db.rpc("_jean_secret");
    if (!secret || internal !== secret) return fail("FORBIDDEN", "Secret invalide.", 401);
  } else {
    const user = await requestUser(req);
    if (!user) return fail("AUTH_REQUIRED", "Connexion requise.", 401);
    const { data: me } = await db.from("profiles").select("role, is_blocked").eq("id", user.id).single();
    if (!me || me.is_blocked || !["chef", "admin"].includes(me.role)) return fail("FORBIDDEN", "Réservé à la cuisine.", 403);
  }
  const body = await req.json().catch(() => ({}));

  if (body.action === "setup") return json(await setup());

  if (body.action === "call") {
    const { data: order } = await db.from("supplier_orders").select("*").eq("id", String(body.order_id ?? "")).maybeSingle();
    if (!order) return fail("NOT_FOUND", "Commande introuvable.", 404);
    if (!body.simulate) {
      const r = await realCall(order);
      return r.ok ? json(r) : fail("CALL", r.message ?? "Appel impossible.");
    }
    const st = await db.rpc("_supplier_call_started", { p_order: order.id, p_call_id: `sim_${crypto.randomUUID()}`, p_mode: "simulation" });
    if (!(st.data as any)?.ok) return fail("CALL", (st.data as any)?.message ?? "Appel impossible.");
    // @ts-ignore EdgeRuntime existe dans Supabase
    EdgeRuntime.waitUntil(simulate(order, ["ok", "cher", "coursier"].includes(body.scenario) ? body.scenario : "ok").catch((e) => console.error("sim", e)));
    return json({ ok: true, simulation: true });
  }
  return fail("ACTION", "Action inconnue.");
});
