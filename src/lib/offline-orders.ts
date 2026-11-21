"use client";
// Commandes préparées SANS réseau : gardées sur le téléphone, envoyées toutes seules au retour du réseau.
// Rien n'est validé sur le téléphone : le serveur (place_order_offline) revérifie menu, stock, allergies, plage,
// solde et PIN au moment de l'envoi. Chaque commande a sa clé : un envoi rejoué ne crée jamais de doublon.
//
// Le code PIN tapé hors ligne doit attendre le réseau : il est chiffré (AES-GCM) avec une clé NON exportable gardée
// dans IndexedDB (jamais en clair dans le stockage), et effacé dès que la commande est envoyée ou abandonnée.
import { rpc } from "@/lib/supabase/client";
import { todayISO } from "@/lib/format";

export type QueuedOrder = {
  key: string;                       // clé d'idempotence (uuid)
  user_id: string;
  items: { menu_item_id: string; qty: number }[];
  extras: { extra_id: string; qty: number }[];
  pickup_pref: string | null;        // heure souhaitée (ISO) ; le serveur prend la plus proche libre
  date: string;                      // jour du repas
  summary: string;                   // « 2 × Garba + Salade de fruits »
  total: number;                     // estimation affichée (le serveur recalcule)
  created_at: string;
  pin: { iv: string; data: string };
};
export type FlushResult =
  | { kind: "sent"; order: QueuedOrder; order_no: number; pickup_at: string; ticket_id: string }
  | { kind: "refused"; order: QueuedOrder; message: string; code: string };

const KEY = "vatel:order-queue";
const MAX_QUEUED = 3;
const MAX_AGE_MS = 12 * 3600_000;

// ───────── Chiffrement du PIN ─────────
const b64 = (buf: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(buf instanceof Uint8Array ? buf : new Uint8Array(buf))));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

function idb(): Promise<IDBDatabase> {
  return new Promise((ok, ko) => {
    const r = indexedDB.open("vatel-offline", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("keys");
    r.onsuccess = () => ok(r.result);
    r.onerror = () => ko(r.error);
  });
}
async function pinKey(): Promise<CryptoKey> {
  const db = await idb();
  const get = <T,>(k: string) => new Promise<T | undefined>((ok, ko) => {
    const q = db.transaction("keys").objectStore("keys").get(k); q.onsuccess = () => ok(q.result as T); q.onerror = () => ko(q.error);
  });
  let key = await get<CryptoKey>("pin");
  if (!key) {
    key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]); // non exportable
    await new Promise<void>((ok, ko) => {
      const tx = db.transaction("keys", "readwrite"); tx.objectStore("keys").put(key, "pin"); tx.oncomplete = () => ok(); tx.onerror = () => ko(tx.error);
    });
  }
  return key;
}
async function sealPin(pin: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await pinKey(), new TextEncoder().encode(pin));
  return { iv: b64(iv), data: b64(data) };
}
async function openPin(p: QueuedOrder["pin"]) {
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(p.iv) }, await pinKey(), unb64(p.data));
  return new TextDecoder().decode(plain);
}

// ───────── File ─────────
function read(): QueuedOrder[] {
  try { return JSON.parse(localStorage.getItem(KEY) ?? "[]"); } catch { return []; }
}
function write(list: QueuedOrder[]) {
  try { localStorage.setItem(KEY, JSON.stringify(list)); } catch {}
  window.dispatchEvent(new Event("vatel:order-queue"));
}
const expired = (o: QueuedOrder, now = Date.now()) => o.date < todayISO() || now - new Date(o.created_at).getTime() > MAX_AGE_MS;

/** Commandes en attente d'envoi pour ce compte (les trop vieilles sont retirées). */
export function queuedOrders(userId?: string | null): QueuedOrder[] {
  const list = read();
  const fresh = list.filter((o) => !expired(o));
  if (fresh.length !== list.length) write(fresh);
  return userId ? fresh.filter((o) => o.user_id === userId) : fresh;
}

/** Garde une commande sur le téléphone (PIN chiffré). */
export async function queueOrder(o: Omit<QueuedOrder, "key" | "created_at" | "pin">, pin: string): Promise<{ ok: true } | { ok: false; message: string }> {
  if (queuedOrders(o.user_id).length >= MAX_QUEUED) {
    return { ok: false, message: `Déjà ${MAX_QUEUED} commandes en attente : attends le retour du réseau.` };
  }
  if (typeof crypto?.subtle === "undefined" || typeof indexedDB === "undefined") {
    return { ok: false, message: "Ce téléphone ne permet pas de commander hors ligne." };
  }
  try {
    const entry: QueuedOrder = { ...o, key: crypto.randomUUID(), created_at: new Date().toISOString(), pin: await sealPin(pin) };
    write([...read(), entry]);
    return { ok: true };
  } catch {
    return { ok: false, message: "Impossible de garder la commande sur ce téléphone." };
  }
}

let flushing = false;
/**
 * Envoie les commandes en attente (une à la fois). Réseau encore absent ou instable : elles restent dans la file.
 * Réponse définitive du serveur (acceptée ou refusée) : retirée de la file, PIN effacé.
 */
export async function flushOrders(userId: string): Promise<FlushResult[]> {
  if (flushing || typeof navigator === "undefined" || !navigator.onLine) return [];
  flushing = true;
  const out: FlushResult[] = [];
  try {
    for (const o of queuedOrders(userId)) {
      let pin: string;
      try { pin = await openPin(o.pin); } catch {
        write(read().filter((x) => x.key !== o.key));
        out.push({ kind: "refused", order: o, code: "PIN_LOST", message: "Code PIN illisible sur ce téléphone : refais la commande." });
        continue;
      }
      const r = await rpc<{ order_no: number; pickup_at: string; ticket_id: string }>("place_order_offline", {
        p_key: o.key, p_items: o.items, p_pickup_at: o.pickup_pref, p_extras: o.extras, p_pin: pin,
      });
      if (!r.ok && ["NETWORK", "OFFLINE", "IN_PROGRESS"].includes(r.code)) break; // on réessaiera
      write(read().filter((x) => x.key !== o.key));
      out.push(r.ok
        ? { kind: "sent", order: o, order_no: r.order_no, pickup_at: r.pickup_at, ticket_id: r.ticket_id }
        : { kind: "refused", order: o, code: r.code, message: r.message });
    }
  } finally {
    flushing = false;
  }
  return out;
}

/** Retire une commande en attente (l'élève l'annule avant l'envoi). */
export function dropQueued(key: string) {
  write(read().filter((x) => x.key !== key));
}
