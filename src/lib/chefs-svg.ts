// L'équipe de la cantine en bitmojis 2D, dessinés en SVG : corps entier (toque → chaussures), rien de coupé.
// Inspirés de l'illustration de l'équipe (tabliers bleus, toques), visages dans le style des bitmojis de l'appli.
// Chaque personnage a un geste de cuisine animé en CSS (fouet qui remue, louche qui tourne, plateau qui danse,
// chef qui fait « non ») et cligne des yeux. Aucune image à télécharger : quelques Ko de texte.
import { brows, eyes, mouth, type Mood } from "@/lib/bitmoji";

export type ChefWho = "chef" | "fouet" | "cupcakes" | "louche";
export const CHEF_VIEWBOX = { w: 200, h: 462 };
// Tête agrandie (proportions « bitmoji ») autour du cou
const BIG = `translate(100 122) scale(1.22) translate(-100 -122)`;

const INK = "#1b1110";
const BLUE = "#1f5fbf", BLUE_D = "#174a96", BLUE_L = "#4f8be0";
const WHITE = "#ffffff", WHITE_S = "#e3e8f0";
const SHOE_W = "#f4f5f7";
const OUT = "#c3ccd9"; // contour des éléments blancs (sinon invisibles sur fond blanc)

type P = [number, number];
type Arm = { s: P; e: P; h: P; sleeve: string; cuff?: string; bare?: number; anim?: string };

/** Bras : manche (haut du bras + une partie de l'avant-bras), poignet, main. */
function arm(a: Arm, skin: string) {
  const f = a.bare ?? 0.45; // part de l'avant-bras qui reste nue
  const m: P = [a.e[0] + (a.h[0] - a.e[0]) * (1 - f), a.e[1] + (a.h[1] - a.e[1]) * (1 - f)];
  const c0: P = [a.e[0] + (m[0] - a.e[0]) * 0.55, a.e[1] + (m[1] - a.e[1]) * 0.55];
  const cuff = a.cuff ? `<path d="M${c0[0]} ${c0[1]} L${m[0]} ${m[1]}" stroke="${a.cuff}" stroke-width="20" stroke-linecap="round"/><path d="M${c0[0]} ${c0[1]} L${m[0]} ${m[1]}" stroke="${BLUE}" stroke-width="20" stroke-linecap="round" stroke-dasharray="2 4" opacity="0.6"/>` : "";
  const edge = a.sleeve === WHITE ? OUT : "rgba(22,24,29,0.22)";
  return `<path d="M${a.s[0]} ${a.s[1]} L${a.e[0]} ${a.e[1]} L${m[0]} ${m[1]}" stroke="${edge}" stroke-width="24" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
<path d="M${m[0]} ${m[1]} L${a.h[0]} ${a.h[1]}" stroke="rgba(22,24,29,0.18)" stroke-width="16" stroke-linecap="round"/><circle cx="${a.h[0]}" cy="${a.h[1]}" r="10.5" fill="rgba(22,24,29,0.18)"/>
<path d="M${a.s[0]} ${a.s[1]} L${a.e[0]} ${a.e[1]}" stroke="${a.sleeve}" stroke-width="21" stroke-linecap="round"/>
<path d="M${a.e[0]} ${a.e[1]} L${m[0]} ${m[1]}" stroke="${a.sleeve}" stroke-width="19" stroke-linecap="round"/>${cuff}
<path d="M${m[0]} ${m[1]} L${a.h[0]} ${a.h[1]}" stroke="${skin}" stroke-width="13" stroke-linecap="round"/>
<circle cx="${a.h[0]}" cy="${a.h[1]}" r="9" fill="${skin}"/>`;
}

const ring = (cx: number, cy: number) =>
  `<circle cx="${cx}" cy="${cy}" r="13" fill="${WHITE}" stroke="${BLUE_D}" stroke-width="2"/><path d="M${cx - 6} ${cy - 5} L${cx} ${cy + 6} L${cx + 6} ${cy - 5}" fill="none" stroke="${BLUE}" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/><path d="M${cx - 8} ${cy + 9} h16" stroke="#f2b632" stroke-width="2" stroke-linecap="round"/>`;

/** Bande à motif losanges (toques) */
const band = (x: number, y: number, w: number, h: number, bg: string, fg: string) => {
  let d = "";
  for (let i = x + 4; i < x + w - 2; i += 10) d += `M${i} ${y + h / 2} l5 -${h / 2 - 2} l5 ${h / 2 - 2} l-5 ${h / 2 - 2} z `;
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${h / 2}" fill="${bg}"/><path d="${d}" fill="none" stroke="${fg}" stroke-width="1.6"/>`;
};

const toqueShape = (f: string, st = "") => `<circle cx="78" cy="22" r="17" fill="${f}"${st}/><circle cx="100" cy="12" r="22" fill="${f}"${st}/><circle cx="122" cy="22" r="17" fill="${f}"${st}/><rect x="66" y="18" width="68" height="24" fill="${f}"${st}/>`;
const toque = (bandBg: string, bandFg: string) =>
  `<g>${toqueShape(OUT, ` stroke="${OUT}" stroke-width="4"`)}${toqueShape(WHITE)}
<path d="M70 30 Q100 22 130 30" stroke="${WHITE_S}" stroke-width="3" fill="none"/>
<path d="M84 20 Q86 30 84 40 M116 20 Q114 30 116 40" stroke="${WHITE_S}" stroke-width="2" fill="none"/>
${band(64, 36, 72, 16, bandBg, bandFg)}</g>`;

/** Visage (yeux qui clignent, sourcils, bouche selon l'humeur), repris des bitmojis de l'appli */
function face(skin: string, mood: Mood, hairColor: string, extra = "") {
  return `<g transform="translate(22 8.5) scale(1.3)">
<ellipse cx="34" cy="57" rx="5" ry="7" fill="${skin}"/><ellipse cx="86" cy="57" rx="5" ry="7" fill="${skin}"/>
<ellipse cx="60" cy="55" rx="26" ry="29" fill="${skin}"/>
<ellipse cx="43" cy="65" rx="4.5" ry="2.8" fill="#ff7a7a" opacity="0.28"/><ellipse cx="77" cy="65" rx="4.5" ry="2.8" fill="#ff7a7a" opacity="0.28"/>
${brows(mood, hairColor)}
<g class="cs-blink">${eyes(mood)}</g>
<path d="M58 60 Q60 64 62 60" stroke="rgba(0,0,0,0.35)" stroke-width="2" stroke-linecap="round" fill="none"/>
${extra}
${mouth(mood)}
</g>`;
}

const legs = (pants: string, shoe: string, sole: string, from = 318) =>
  `<rect x="79" y="${from}" width="19" height="${392 - from}" rx="8" fill="${pants}"/><rect x="102" y="${from}" width="19" height="${392 - from}" rx="8" fill="${pants}"/>
<path d="M72 398 Q72 386 84 386 L96 386 Q100 386 100 392 L100 404 L72 404 Z" fill="${shoe}" stroke="${OUT}" stroke-width="1.5"/><path d="M128 398 Q128 386 116 386 L104 386 Q100 386 100 392 L100 404 L128 404 Z" fill="${shoe}" stroke="${OUT}" stroke-width="1.5"/>
<rect x="70" y="402" width="31" height="5" rx="2.5" fill="${sole}"/><rect x="99" y="402" width="31" height="5" rx="2.5" fill="${sole}"/>`;

const jacket = (c: string, bottom = 242, buttons = "", trim = "") =>
  `<path d="M62 146 Q62 126 82 124 L118 124 Q138 126 138 146 L134 ${bottom} Q100 ${bottom + 6} 66 ${bottom} Z" fill="${c}" stroke="${c === WHITE ? OUT : "rgba(22,24,29,0.2)"}" stroke-width="2.5"/>
<path d="M86 124 L100 140 L114 124 Z" fill="${trim || c}" opacity="0.9"/>${buttons}`;

const longApron = (c: string, edge: string, withRing = true) =>
  `<path d="M90 126 L84 152 M110 126 L116 152" stroke="${c}" stroke-width="4" stroke-linecap="round"/>
<path d="M82 150 L118 150 L120 214 Q136 220 140 326 Q100 334 60 326 Q64 220 80 214 Z" fill="${c}" stroke="${c === WHITE ? OUT : "rgba(22,24,29,0.2)"}" stroke-width="2.5"/>
<path d="M126 222 Q134 270 134 322" stroke="rgba(22,24,29,0.08)" stroke-width="8" fill="none"/>
<path d="M60 326 Q100 334 140 326" stroke="${edge}" stroke-width="4" fill="none"/>
<path d="M78 214 L122 214" stroke="${edge}" stroke-width="5" stroke-linecap="round"/>${withRing ? ring(100, 262) : ""}`;

const shadow = `<ellipse cx="100" cy="410" rx="46" ry="7" fill="rgba(0,0,0,0.12)"/>`;

function build(who: ChefWho, mood: Mood) {
  switch (who) {
    // Le chef : toque blanche, bouc, bras croisés, grand tablier bleu
    case "chef": {
      const skin = "#5a3420";
      const beard = `<path d="M47 66 Q60 94 73 66 Q66 76 60 76 Q54 76 47 66 Z" fill="${INK}"/><path d="M49 63.5 Q60 58.5 71 63.5 Q60 66 49 63.5 Z" fill="${INK}"/>`;
      return `${shadow}${legs("#2b2f3a", "#16181d", "#000")}
${jacket(WHITE, 242, `<circle cx="90" cy="160" r="2.5" fill="${INK}"/><circle cx="110" cy="160" r="2.5" fill="${INK}"/>`)}
${longApron(BLUE, BLUE_D)}
<rect x="91" y="106" width="18" height="22" rx="7" fill="${skin}"/>
<path d="M86 124 L100 134 L114 124 L112 120 L88 120 Z" fill="${WHITE}" stroke="${OUT}" stroke-width="1.5"/>
<g transform="${BIG}"><g class="cs-head" style="transform-origin:100px 118px">
${face(skin, mood, INK, beard)}
<path d="M66 60 Q66 40 100 40 Q134 40 134 60 Q120 50 100 50 Q80 50 66 60 Z" fill="${INK}"/>
${toque(BLUE, "#9cc3ff")}</g></g>
<g class="cs-breathe" style="transform-origin:100px 200px">
${arm({ s: [68, 140], e: [54, 198], h: [128, 192], sleeve: WHITE, bare: 0.62 }, skin)}
${arm({ s: [132, 140], e: [146, 200], h: [72, 206], sleeve: WHITE, bare: 0.62 }, skin)}
<path d="M54 186 L58 210 M146 188 L142 212" stroke="${WHITE_S}" stroke-width="2"/></g>`;
    }
    // La pâtissière au fouet : toque bleue bouffante, cheveux longs, tablier blanc, fouet qui remue
    case "fouet": {
      const skin = "#8d5524", hair = "#2b1a12";
      const whisk = `<g class="cs-whisk" style="transform-origin:96px 212px">
<path d="M96 212 L118 172" stroke="#c7893f" stroke-width="6" stroke-linecap="round"/>
<g fill="none" stroke="#9aa3b2" stroke-width="2.2"><ellipse cx="128" cy="152" rx="9" ry="22" transform="rotate(30 128 152)"/><ellipse cx="128" cy="152" rx="4" ry="22" transform="rotate(30 128 152)"/><ellipse cx="128" cy="152" rx="13" ry="21" transform="rotate(30 128 152)"/></g></g>`;
      return `${shadow}
<g transform="${BIG}"><path d="M64 52 Q54 120 58 186 Q70 192 82 184 Q74 120 80 70 Z M136 52 Q146 120 142 186 Q130 192 118 184 Q126 120 120 70 Z" fill="${hair}"/></g>
${legs(BLUE_D, SHOE_W, "#cfd5de")}
${jacket(BLUE, 242)}
${longApron(WHITE, BLUE)}
<rect x="91" y="106" width="18" height="22" rx="7" fill="${skin}"/>
<path d="M86 124 L100 136 L114 124 L112 119 L88 119 Z" fill="${BLUE_L}"/>
<g transform="${BIG}"><g class="cs-head" style="transform-origin:100px 118px">
${face(skin, mood, hair)}
<path d="M64 74 Q60 44 100 42 Q140 44 136 74 Q128 54 100 54 Q72 54 64 74 Z" fill="${hair}"/>
<ellipse cx="100" cy="22" rx="46" ry="26" fill="${BLUE}"/><ellipse cx="86" cy="16" rx="18" ry="10" fill="${BLUE_L}" opacity="0.45"/>
${band(62, 36, 76, 17, WHITE, BLUE)}</g></g>
${arm({ s: [132, 140], e: [146, 200], h: [126, 226], sleeve: BLUE, cuff: "#cfe0ff" }, skin)}
<g class="cs-stir" style="transform-origin:68px 140px">
${arm({ s: [68, 140], e: [58, 204], h: [96, 212], sleeve: BLUE, cuff: "#cfe0ff" }, skin)}
${whisk}</g>`;
    }
    // La pâtissière aux cupcakes : toque blanche, cheveux longs ondulés, veste courte, plateau qui danse
    case "cupcakes": {
      const skin = "#6b3e26", hair = "#1f1410";
      const cake = (x: number, liner: string, top: string) =>
        `<path d="M${x - 9} 100 L${x + 9} 100 L${x + 6} 113 L${x - 6} 113 Z" fill="${liner}"/><path d="M${x - 7} 100 v12 M${x - 2} 100 v13 M${x + 3} 100 v13" stroke="rgba(0,0,0,0.12)" stroke-width="1.4"/>
<path d="M${x - 11} 101 Q${x - 12} 90 ${x - 4} 88 Q${x} 80 ${x + 5} 88 Q${x + 12} 90 ${x + 11} 101 Z" fill="${top}"/>
<circle cx="${x - 3}" cy="93" r="1.3" fill="#e11d48"/><circle cx="${x + 4}" cy="95" r="1.3" fill="#16a34a"/><circle cx="${x + 1}" cy="90" r="1.3" fill="#2563eb"/>`;
      const tray = `<g class="cs-tray" style="transform-origin:156px 128px"><g transform="translate(-3 0)">
${cake(140, "#2dd4bf", "#fde68a")}${cake(160, "#fb923c", "#fbcfe8")}${cake(180, "#f472b6", "#fed7aa")}
<ellipse cx="160" cy="116" rx="38" ry="7" fill="#b8c0cc"/><ellipse cx="160" cy="114" rx="38" ry="6" fill="#dde2ea"/></g></g>`;
      return `${shadow}
<g transform="${BIG}"><path d="M62 54 Q46 110 54 200 Q64 196 70 206 Q78 194 84 198 Q76 120 80 70 Z M138 54 Q154 110 146 200 Q136 196 130 206 Q122 194 116 198 Q124 120 120 70 Z" fill="${hair}"/>
<path d="M58 120 q8 8 0 16 q-8 8 0 16 M142 120 q-8 8 0 16 q8 8 0 16" stroke="#3a2618" stroke-width="2" fill="none"/></g>
<path d="M80 286 L98 286 L96 390 L84 390 Z M102 286 L120 286 L116 390 L104 390 Z" fill="${skin}"/>${legs("transparent", SHOE_W, "#cfd5de", 386)}
<rect x="72" y="198" width="56" height="30" rx="10" fill="${skin}"/>
${jacket(BLUE, 206, [150, 168, 186].map((y) => `<circle cx="91" cy="${y}" r="2.6" fill="#f2b632"/><circle cx="109" cy="${y}" r="2.6" fill="#f2b632"/>`).join(""))}
<path d="M68 222 L132 222 L138 294 Q100 300 62 294 Z" fill="${WHITE}" stroke="${OUT}" stroke-width="2.5"/>
<rect x="80" y="244" width="40" height="34" rx="5" fill="none" stroke="${BLUE}" stroke-width="3"/>${ring(100, 261)}
<path d="M70 223 L130 223" stroke="#f2b632" stroke-width="5" stroke-linecap="round"/><path d="M100 224 l-11 -7 v14 z M100 224 l11 -7 v14 z" fill="#f2b632"/><circle cx="100" cy="224" r="3.4" fill="#d89b1d"/>
<rect x="91" y="106" width="18" height="22" rx="7" fill="${skin}"/>
<path d="M86 124 L100 136 L114 124 L112 119 L88 119 Z" fill="${BLUE_D}"/>
<g transform="${BIG}"><g class="cs-head" style="transform-origin:100px 118px">
${face(skin, mood, hair)}
<path d="M64 76 Q60 44 100 42 Q140 44 136 76 Q126 54 100 54 Q74 54 64 76 Z" fill="${hair}"/>
${toque(BLUE, "#9cc3ff")}</g></g>
${arm({ s: [68, 140], e: [44, 186], h: [72, 214], sleeve: BLUE, bare: 0.5 }, skin)}
<g class="cs-lift" style="transform-origin:132px 140px">
${tray}
${arm({ s: [132, 140], e: [164, 176], h: [156, 128], sleeve: BLUE, bare: 0.5 }, skin)}</g>`;
    }
    // La cuisinière à la louche : bandeau bleu, chignon de locks, veste blanche, louche qui tourne
    case "louche": {
      const skin = "#a0662f", hair = "#24160f";
      const curls = [[64, 66], [62, 82], [138, 66], [140, 82], [66, 98], [134, 98]].map(([x, y]) => `<circle cx="${x}" cy="${y}" r="6.5" fill="${hair}"/>`).join("");
      const bun = Array.from({ length: 9 }, (_, i) => { const t = (i / 9) * Math.PI * 2; return `<circle cx="${(100 + Math.cos(t) * 14).toFixed(1)}" cy="${(24 + Math.sin(t) * 11).toFixed(1)}" r="8" fill="${hair}"/>`; }).join("");
      const ladle = `<path d="M146 246 L120 300" stroke="#9aa3b2" stroke-width="5" stroke-linecap="round"/>
<path d="M100 300 Q100 322 116 322 Q132 322 132 300 Z" fill="#b8c0cc"/><ellipse cx="116" cy="300" rx="16" ry="5" fill="#dde2ea"/>`;
      return `${shadow}
${legs("#6b7280", SHOE_W, "#cfd5de")}
${jacket(WHITE, 242, `<circle cx="91" cy="160" r="2.5" fill="${BLUE}"/><circle cx="109" cy="160" r="2.5" fill="${BLUE}"/>`)}
${longApron(BLUE, BLUE_D)}
<rect x="91" y="106" width="18" height="22" rx="7" fill="${skin}"/>
<path d="M86 124 L100 134 L114 124 L112 119 L88 119 Z" fill="${WHITE}" stroke="${OUT}" stroke-width="1.5"/>
<g transform="${BIG}"><g class="cs-head" style="transform-origin:100px 118px">
${bun}${curls}
${face(skin, mood, hair)}
<path d="M64 70 Q62 40 100 40 Q138 40 136 70 Q126 52 100 52 Q74 52 64 70 Z" fill="${hair}"/>
<path d="M63 58 Q100 40 137 58 L137 68 Q100 50 63 68 Z" fill="${BLUE}"/><path d="M134 60 l14 -6 l-4 12 z M134 62 l12 10 l-12 0 z" fill="${BLUE_D}"/></g></g>
${arm({ s: [68, 140], e: [60, 200], h: [70, 250], sleeve: WHITE, bare: 0.4 }, skin)}
<g class="cs-ladle" style="transform-origin:132px 140px">
${ladle}
${arm({ s: [132, 140], e: [150, 198], h: [146, 246], sleeve: WHITE, bare: 0.4 }, skin)}</g>`;
    }
  }
}

/** SVG complet d'un personnage. `anim` active les gestes (classes CSS cs-*). */
export function chefSvg(who: ChefWho, mood: Mood = "happy", anim = true) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${CHEF_VIEWBOX.w} ${CHEF_VIEWBOX.h}" width="${CHEF_VIEWBOX.w}" height="${CHEF_VIEWBOX.h}" class="${anim ? "cs-anim" : ""}" role="img" aria-hidden="true"><g transform="translate(0 44)">${build(who, mood)}</g></svg>`;
}
