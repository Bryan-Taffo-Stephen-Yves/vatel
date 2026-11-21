"use client";
// Menu en image (à garder dans la galerie du téléphone ou à poster en statut WhatsApp).
// Dessiné dans le téléphone avec <canvas> : aucune bibliothèque, aucun serveur. Ce fichier n'est chargé
// que lorsqu'on touche « Télécharger le menu » (import dynamique) : il n'alourdit pas l'appli.
import type { MenuItem, ServiceKind } from "@/lib/types";
import { SERVICES } from "@/lib/types";
import { chefSvg } from "@/lib/chefs-svg";
import { APP_NAME } from "@/lib/config";

type Svc = { label: string; start: string; end: string; price: number };
export type MenuImageInput = { date: string; items: MenuItem[]; services: Partial<Record<ServiceKind, Svc>> | null; lang?: "fr" | "en" };

const W = 1080;
const C = { ink: "#16181d", ink2: "#3a3f4b", muted: "#5b6270", lime: "#c8f135", limeSoft: "#eefbc4", canvas: "#f6f7f9", card: "#ffffff", line: "#e7e9ee" };
const F = '"Plus Jakarta Sans Variable", "Plus Jakarta Sans", system-ui, sans-serif';
// Une mascotte par service (les mêmes personnages que dans l'appli)
const CHEF: Record<ServiceKind, string> = { breakfast: "louche", lunch: "fouet", snack: "cupcakes", dinner: "chef" };
const SVC_FR: Record<ServiceKind, string> = { breakfast: "Petit-déjeuner", lunch: "Déjeuner", snack: "Goûter", dinner: "Dîner" };
const SVC_EN: Record<ServiceKind, string> = { breakfast: "Breakfast", lunch: "Lunch", snack: "Snack", dinner: "Dinner" };
const PALETTES = [["#FDE68A", "#F59E0B"], ["#FECACA", "#EF4444"], ["#D9F99D", "#65A30D"], ["#FED7AA", "#EA580C"], ["#BFDBFE", "#2563EB"], ["#E9D5FF", "#9333EA"], ["#A7F3D0", "#059669"], ["#FBCFE8", "#DB2777"]];

const fcfa = (n: number) => `${new Intl.NumberFormat("fr-FR").format(n).replace(/ | /g, " ")} F`;
const hm = (s: string) => s.slice(0, 5).replace(":", "h");
function longDate(d: string, en: boolean) {
  const s = new Date(`${d}T12:00:00Z`).toLocaleDateString(en ? "en-GB" : "fr-FR", { weekday: "long", day: "numeric", month: "long", timeZone: "Africa/Abidjan" });
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function load(src: string): Promise<HTMLImageElement | null> {
  return new Promise((ok) => {
    const im = new Image();
    im.crossOrigin = "anonymous"; // photos Supabase : servies avec CORS, sinon l'image ne pourrait pas être exportée
    im.onload = () => ok(im);
    im.onerror = () => ok(null);
    im.src = src;
  });
}

function wrap(ctx: CanvasRenderingContext2D, text: string, max: number, lines: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const out: string[] = [];
  let cur = "";
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (ctx.measureText(next).width <= max) { cur = next; continue; }
    if (cur) out.push(cur);
    cur = w;
    if (out.length === lines) break;
  }
  if (out.length < lines && cur) out.push(cur);
  if (out.length > lines) out.length = lines;
  const used = out.join(" ").split(/\s+/).length;
  if (used < words.length && out.length) {
    let last = out[out.length - 1];
    while (last && ctx.measureText(`${last}…`).width > max) last = last.slice(0, -1);
    out[out.length - 1] = `${last.trimEnd()}…`;
  }
  return out;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

/** Bulle en forme de nuage (bosses sur le haut et le bas) + deux petites bulles qui mènent à la mascotte. */
export function drawCloud(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, tail: { x: number; y: number } | null, text: string, size = 38) {
  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.20)";
  ctx.shadowBlur = 28;
  ctx.shadowOffsetY = 10;
  ctx.fillStyle = "#fff";
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, Math.min(h / 2, 48));
  const n = Math.max(3, Math.round(w / 110));
  for (let i = 0; i < n; i++) {
    const cx = x + ((i + 0.5) * w) / n, r = h * (0.3 + 0.08 * ((i * 7) % 3));
    ctx.moveTo(cx + r, y + h * 0.18); ctx.arc(cx, y + h * 0.18, r, 0, Math.PI * 2);
  }
  for (let i = 0; i < n - 1; i++) {
    const cx = x + ((i + 1) * w) / n, r = h * (0.26 + 0.06 * ((i * 5) % 3));
    ctx.moveTo(cx + r, y + h * 0.84); ctx.arc(cx, y + h * 0.84, r, 0, Math.PI * 2);
  }
  if (tail) {
    // petites bulles de « pensée » vers la mascotte
    const bx = x + w * (tail.x > x + w / 2 ? 0.85 : 0.15), by = tail.y < y ? y : y + h;
    for (const [k, r] of [[0.35, 16], [0.7, 10]] as const) {
      const cx = bx + (tail.x - bx) * k, cy = by + (tail.y - by) * k;
      ctx.moveTo(cx + r, cy); ctx.arc(cx, cy, r, 0, Math.PI * 2);
    }
  }
  ctx.fill();
  ctx.restore();
  ctx.fillStyle = C.ink;
  ctx.font = `800 ${size}px ${F}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const lines = wrap(ctx, text, w - 70, 2);
  lines.forEach((l, i) => ctx.fillText(l, x + w / 2, y + h / 2 + (i - (lines.length - 1) / 2) * size * 1.22));
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
}

function dishFallback(ctx: CanvasRenderingContext2D, name: string, x: number, y: number, s: number) {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) | 0;
  const [a, b] = PALETTES[Math.abs(h) % PALETTES.length];
  const g = ctx.createRadialGradient(x + s * 0.2, y + s * 0.1, 0, x + s * 0.2, y + s * 0.1, s * 1.2);
  g.addColorStop(0, a); g.addColorStop(1, b);
  ctx.fillStyle = g;
  ctx.fillRect(x, y, s, s);
  ctx.fillStyle = "#fff";
  ctx.font = `800 ${s * 0.32}px ${F}`;
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText(name.split(/\s+/).filter((w) => w.length > 2).slice(0, 2).map((w) => w[0]).join("").toUpperCase(), x + s / 2, y + s / 2);
  ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
}

/** Dessine le menu d'un jour (tous les services) et le renvoie en JPEG. */
export async function menuImage({ date, items, services, lang = "fr" }: MenuImageInput): Promise<Blob> {
  const en = lang === "en";
  await document.fonts?.load(`800 40px "Plus Jakarta Sans Variable"`).catch(() => {});
  const day = items.filter((i) => i.service_date === date);
  const svcs = SERVICES.filter((s) => day.some((i) => i.service === s));
  const chefs: Record<string, HTMLImageElement | null> = {};
  // Les bitmojis 2D de l'équipe, dessinés en SVG (sans animation pour l'image fixe)
  await Promise.all((["louche", "fouet", "cupcakes", "chef"] as const).map(async (k) => {
    chefs[k] = await load(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(chefSvg(k, k === "cupcakes" ? "laugh" : "happy", false))}`);
  }));
  const photos = new Map<string, HTMLImageElement | null>();
  await Promise.all(day.map(async (i) => { if (i.dish.photo_url) photos.set(i.id, await load(i.dish.photo_url)); }));

  // Mise en page : hauteur calculée d'après le nombre de plats (au moins un format « story » 1080 × 1920)
  const HEAD = 580, SEC = 160, ROW = 190, GAP = 22, FOOT = 400;
  const body = svcs.reduce((h, s) => h + SEC + day.filter((i) => i.service === s).length * (ROW + GAP) + 40, 0);
  const H = Math.max(1920, HEAD + body + FOOT);

  const cv = document.createElement("canvas");
  cv.width = W; cv.height = H;
  const ctx = cv.getContext("2d")!;
  ctx.fillStyle = C.canvas;
  ctx.fillRect(0, 0, W, H);

  // En-tête noir : date + mascotte qui présente son plateau + nuage
  ctx.fillStyle = C.ink;
  roundRect(ctx, 0, -60, W, HEAD + 60, 70); ctx.fill();
  ctx.fillStyle = C.lime;
  ctx.font = `800 34px ${F}`;
  ctx.fillText(en ? "ON THE MENU" : "AU MENU", 70, 120);
  ctx.fillStyle = "#fff";
  ctx.font = `800 70px ${F}`;
  wrap(ctx, longDate(date, en), 640, 2).forEach((l, i) => ctx.fillText(l, 70, 205 + i * 80));
  ctx.fillStyle = "rgba(255,255,255,0.6)";
  ctx.font = `700 30px ${F}`;
  ctx.fillText(en ? `${APP_NAME} · your canteen` : `${APP_NAME} · ta cantine`, 70, 340);
  const star = day.find((i) => i.service === "lunch") ?? day[0];
  const hi = chefs.cupcakes;
  if (hi) ctx.drawImage(hi, W - 70 - (hi.width * 440) / hi.height, 70, (hi.width * 440) / hi.height, 440);
  drawCloud(ctx, 60, 400, 620, 110, { x: W - 250, y: 330 },
    star ? (en ? `Today: ${star.dish.name}! 😋` : `Aujourd'hui : ${star.dish.name} ! 😋`) : (en ? "Enjoy your meal! 😋" : "Bon appétit ! 😋"), 36);

  let y = HEAD + 70;
  for (const s of svcs) {
    const cfg = services?.[s];
    const list = day.filter((i) => i.service === s);
    // Titre du service + mascotte du service
    const m = chefs[CHEF[s]];
    if (m) { const h = 170, w = (m.width * h) / m.height; ctx.drawImage(m, W - 80 - w, y - 20, w, h); }
    ctx.fillStyle = C.lime;
    const label = en ? SVC_EN[s] : cfg?.label ?? SVC_FR[s];
    ctx.font = `800 44px ${F}`;
    const lw = ctx.measureText(label).width;
    roundRect(ctx, 60, y, lw + 60, 76, 38); ctx.fill();
    ctx.fillStyle = C.ink;
    ctx.fillText(label, 90, y + 53);
    if (cfg) {
      ctx.fillStyle = C.muted;
      ctx.font = `700 30px ${F}`;
      ctx.fillText(`${hm(cfg.start)} – ${hm(cfg.end)} · ${en ? "ticket" : "ticket"} ${fcfa(cfg.price)}`, 60, y + 118);
    }
    y += SEC;
    for (const i of list) {
      ctx.save();
      ctx.shadowColor = "rgba(22,24,29,0.08)"; ctx.shadowBlur = 24; ctx.shadowOffsetY = 6;
      ctx.fillStyle = C.card;
      roundRect(ctx, 60, y, W - 120, ROW, 40); ctx.fill();
      ctx.restore();
      // Photo du plat (ou visuel de repli)
      const s2 = ROW - 36, px = 78, py = y + 18;
      ctx.save();
      roundRect(ctx, px, py, s2, s2, 30); ctx.clip();
      const ph = photos.get(i.id);
      if (ph) {
        const k = Math.max(s2 / ph.width, s2 / ph.height);
        ctx.drawImage(ph, px + (s2 - ph.width * k) / 2, py + (s2 - ph.height * k) / 2, ph.width * k, ph.height * k);
      } else dishFallback(ctx, i.dish.name, px, py, s2);
      ctx.restore();
      const tx = px + s2 + 30, tw = W - 120 - (tx - 60) - 30;
      ctx.fillStyle = C.ink;
      ctx.font = `800 42px ${F}`;
      const name = wrap(ctx, i.dish.name, tw, 1)[0] ?? "";
      ctx.fillText(name, tx, y + 68);
      ctx.fillStyle = C.muted;
      ctx.font = `600 27px ${F}`;
      wrap(ctx, i.dish.composition ?? i.dish.description ?? "", tw, 2).forEach((l, k) => ctx.fillText(l, tx, y + 112 + k * 34));
      if (i.dish.kcal) {
        ctx.fillStyle = C.ink2;
        ctx.font = `700 24px ${F}`;
        const t = `🔥 ${i.dish.kcal} kcal`;
        ctx.fillText(t, W - 80 - ctx.measureText(t).width, y + 66);
      }
      y += ROW + GAP;
    }
    y += 40;
  }

  // Pied : le chef + nuage « commande à l'avance »
  const fy = H - FOOT;
  ctx.fillStyle = C.ink;
  roundRect(ctx, 0, fy + 40, W, FOOT, 70); ctx.fill();
  const ch = chefs.chef;
  if (ch) { const h = 380, w = (ch.width * h) / ch.height; ctx.drawImage(ch, 60, H - h, w, h); }
  drawCloud(ctx, 330, fy + 100, 690, 120, { x: 240, y: fy + 160 }, en ? `Order ahead on ${APP_NAME} 📲` : `Commande à l'avance sur ${APP_NAME} 📲`, 36);
  ctx.fillStyle = C.lime;
  ctx.font = `800 34px ${F}`;
  ctx.fillText(location.host, 380, fy + 300);
  ctx.fillStyle = "rgba(255,255,255,0.55)";
  ctx.font = `600 24px ${F}`;
  ctx.fillText(en ? "Menu subject to change · dishes may sell out" : "Menu susceptible d'évoluer · plats dans la limite des stocks", 380, fy + 345);

  return new Promise((ok, ko) => cv.toBlob((b) => (b ? ok(b) : ko(new Error("image"))), "image/jpeg", 0.86));
}

/** Enregistre dans le téléphone : feuille de partage (« Enregistrer l'image ») si possible, sinon téléchargement. */
export async function saveImages(files: File[]): Promise<"shared" | "downloaded" | "cancelled"> {
  const nav = navigator as Navigator & { canShare?: (d: { files: File[] }) => boolean };
  if (nav.canShare?.({ files }) && navigator.share) {
    try { await navigator.share({ files }); return "shared"; }
    catch (e) { if ((e as Error).name === "AbortError") return "cancelled"; }
  }
  for (const f of files) {
    const url = URL.createObjectURL(f);
    const a = document.createElement("a");
    a.href = url; a.download = f.name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    await new Promise((r) => setTimeout(r, 400));
  }
  return "downloaded";
}
