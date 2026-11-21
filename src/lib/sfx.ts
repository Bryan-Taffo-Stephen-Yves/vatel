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

/** Son métallique (cloche, couverts) : plusieurs harmoniques non entières qui s'éteignent lentement. */
export function metal(f: number, at = 0, decay = 1.1, vol = 0.22, ratios = [1, 2.76, 5.4, 8.93]) {
  try {
    const c = audio(), t = c.currentTime + at;
    ratios.forEach((r, i) => {
      const o = c.createOscillator(), g = c.createGain();
      o.type = "sine"; o.frequency.setValueAtTime(f * r, t);
      const v = vol / (1 + i * 1.6), d = decay / (1 + i * 0.7);
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(v, t + 0.004); g.gain.exponentialRampToValueAtTime(0.0001, t + d);
      o.connect(g).connect(c.destination); o.start(t); o.stop(t + d + 0.05);
    });
  } catch { /* audio indisponible */ }
}

/** Bruit filtré (grésillement de poêle, tiroir-caisse, frottement). */
export function noise(at: number, dur: number, opts: { type?: BiquadFilterType; freq?: number; q?: number; vol?: number; crackle?: boolean } = {}) {
  try {
    const c = audio(), t = c.currentTime + at;
    const buf = c.createBuffer(1, Math.ceil(c.sampleRate * dur), c.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (opts.crackle && Math.random() < 0.015 ? 3 : 1);
    const src = c.createBufferSource(); src.buffer = buf;
    const f = c.createBiquadFilter(); f.type = opts.type ?? "bandpass"; f.frequency.value = opts.freq ?? 3000; f.Q.value = opts.q ?? 0.8;
    const g = c.createGain(); g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(opts.vol ?? 0.2, t + Math.min(0.04, dur / 4)); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(c.destination); src.start(t); src.stop(t + dur + 0.02);
  } catch { /* audio indisponible */ }
}

/** Sons de cuisine, communs à l'appli élève et au comptoir */
export const kitchen = {
  /** Cloche de comptoir « service ! » (ding-ding) */
  bell: () => { metal(1318, 0, 1.4, 0.24); metal(1318, 0.32, 1.6, 0.24); },
  /** Couverts qui tintent sur une assiette (ticket servi) */
  clink: () => { metal(2650, 0, 0.32, 0.16, [1, 1.52, 2.33]); metal(3180, 0.11, 0.42, 0.14, [1, 1.47, 2.4]); noise(0, 0.03, { type: "highpass", freq: 5000, vol: 0.06 }); },
  /** Tiroir-caisse « ka-ching » (achat) */
  register: () => {
    noise(0, 0.035, { type: "bandpass", freq: 1800, q: 2, vol: 0.25 });            // clic du bouton
    noise(0.05, 0.16, { type: "bandpass", freq: 900, q: 1.2, vol: 0.12 });         // le tiroir glisse
    metal(2093, 0.17, 0.9, 0.18, [1, 2.5, 4.1]); metal(2637, 0.21, 1.0, 0.16, [1, 2.5, 4.1]); // « ching »
  },
  /** Grésillement de poêle (la cuisine commence à préparer) */
  sizzle: () => noise(0, 0.9, { type: "highpass", freq: 3500, vol: 0.09, crackle: true }),
};

const vibrate = (p: number | number[]) => { try { navigator.vibrate?.(p); } catch {} };
const play = (notes: Note[], vib?: number | number[]) => { if (!sfxOn()) return; tones(notes); if (vib) vibrate(vib); };

export const sfx = {
  /** Petit « pop » de bouton */
  tap: () => play([{ f: 880, at: 0, dur: 0.06, type: "triangle", vol: 0.12, to: 1320 }]),
  /** Achat d'un ticket ou commande passée : tiroir-caisse « ka-ching » */
  purchase: () => { if (!sfxOn()) return; kitchen.register(); vibrate([20, 60, 40]); },
  /** Réussite (avis, image du menu…) : arpège joyeux */
  success: () => play([523, 659, 784, 1046].map((f, i) => ({ f, at: i * 0.08, dur: i === 3 ? 0.35 : 0.14, type: "triangle" as const, vol: 0.2 })), [20, 60, 40]),
  /** Recharge : pièces qui tintent */
  coin: () => play([{ f: 988, at: 0, dur: 0.08, type: "square", vol: 0.1 }, { f: 1319, at: 0.08, dur: 0.35, type: "square", vol: 0.1 }], 40),
  /** La cuisine commence à préparer : grésillement de poêle */
  preparing: () => { if (!sfxOn()) return; kitchen.sizzle(); vibrate(40); },
  /** Commande prête : cloche de comptoir « service ! » */
  ready: () => { if (!sfxOn()) return; kitchen.bell(); vibrate([80, 60, 80]); },
  /** Ticket scanné côté client : couverts qui tintent sur l'assiette */
  served: () => { if (!sfxOn()) return; kitchen.clink(); vibrate(120); },
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
