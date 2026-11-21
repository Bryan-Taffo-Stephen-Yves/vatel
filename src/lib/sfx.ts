// Effets sonores de l'appli client : synthétisés par le navigateur (Web Audio).
// Aucun fichier son à télécharger → 0 Ko de plus, marche hors ligne. Coupables dans Profil.
const PREF = "dabali:sfx"; // "on" | "off"

export function sfxOn(): boolean {
  try { return localStorage.getItem(PREF) !== "off"; } catch { return true; }
}
export function setSfx(on: boolean) { try { localStorage.setItem(PREF, on ? "on" : "off"); } catch {} }

let ctx: AudioContext | null = null;
function audio() {
  const C = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  ctx ??= new C();
  if (ctx.state === "suspended") ctx.resume();
  return ctx;
}

export type Note = { f: number; at: number; dur: number; type?: OscillatorType; vol?: number; to?: number };

/** Joue une suite de notes (f = fréquence, to = glissando vers cette fréquence). */
export function tones(notes: Note[]) {
  try {
    const c = audio();
    for (const n of notes) {
      const o = c.createOscillator(), g = c.createGain();
      o.type = n.type ?? "sine";
      const t = c.currentTime + n.at;
      o.frequency.setValueAtTime(n.f, t);
      if (n.to) o.frequency.exponentialRampToValueAtTime(n.to, t + n.dur);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(n.vol ?? 0.25, t + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t + n.dur);
      o.connect(g).connect(c.destination);
      o.start(t);
      o.stop(t + n.dur + 0.03);
    }
  } catch { /* audio indisponible : on reste silencieux */ }
}

const vibrate = (p: number | number[]) => { try { navigator.vibrate?.(p); } catch {} };
const play = (notes: Note[], vib?: number | number[]) => { if (!sfxOn()) return; tones(notes); if (vib) vibrate(vib); };

export const sfx = {
  /** Petit « pop » de bouton */
  tap: () => play([{ f: 880, at: 0, dur: 0.06, type: "triangle", vol: 0.12, to: 1320 }]),
  /** Commande passée / achat réussi : arpège joyeux */
  success: () => play([523, 659, 784, 1046].map((f, i) => ({ f, at: i * 0.08, dur: i === 3 ? 0.35 : 0.14, type: "triangle" as const, vol: 0.2 })), [20, 60, 40]),
  /** Recharge : pièces qui tintent */
  coin: () => play([{ f: 988, at: 0, dur: 0.08, type: "square", vol: 0.1 }, { f: 1319, at: 0.08, dur: 0.35, type: "square", vol: 0.1 }], 40),
  /** La cuisine commence à préparer : petit « toc toc » de cuillère */
  preparing: () => play([{ f: 660, at: 0, dur: 0.07, type: "triangle", vol: 0.18 }, { f: 784, at: 0.12, dur: 0.1, type: "triangle", vol: 0.18 }], 40),
  /** Commande prête : cloche de comptoir « ding-ding » */
  ready: () => play([
    { f: 1568, at: 0, dur: 0.7, vol: 0.22 }, { f: 3136, at: 0, dur: 0.4, vol: 0.05 },
    { f: 1568, at: 0.28, dur: 0.9, vol: 0.22 }, { f: 3136, at: 0.28, dur: 0.5, vol: 0.05 },
  ], [80, 60, 80]),
  /** Ticket scanné côté client : « bon appétit » */
  served: () => play([{ f: 784, at: 0, dur: 0.12, type: "triangle", vol: 0.2 }, { f: 1175, at: 0.1, dur: 0.4, type: "triangle", vol: 0.2 }], 120),
  /** Annulation : deux notes qui descendent, sans dramatiser */
  cancel: () => play([{ f: 587, at: 0, dur: 0.16, type: "triangle", vol: 0.2 }, { f: 392, at: 0.15, dur: 0.32, type: "triangle", vol: 0.2 }], [40, 40, 40]),
  /** Note d'un plat : son qui suit l'humeur (1 = grognon → 5 = ravi) */
  mood: (n: number) => {
    const by: Record<number, Note[]> = {
      1: [{ f: 220, at: 0, dur: 0.35, type: "sawtooth", vol: 0.12, to: 140 }],
      2: [{ f: 330, at: 0, dur: 0.25, type: "triangle", vol: 0.16, to: 247 }],
      3: [{ f: 523, at: 0, dur: 0.15, type: "triangle", vol: 0.16 }],
      4: [{ f: 659, at: 0, dur: 0.1, type: "triangle", vol: 0.18 }, { f: 880, at: 0.08, dur: 0.2, type: "triangle", vol: 0.18 }],
      5: [{ f: 784, at: 0, dur: 0.09, type: "triangle", vol: 0.18 }, { f: 988, at: 0.07, dur: 0.09, type: "triangle", vol: 0.18 }, { f: 1319, at: 0.14, dur: 0.3, type: "triangle", vol: 0.18 }],
    };
    play(by[n] ?? by[3], n <= 2 ? [60, 40, 60] : 25);
  },
};
