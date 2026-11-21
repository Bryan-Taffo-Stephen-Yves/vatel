// Sons et voix du scanner : générés par le navigateur (aucun fichier à télécharger, marche hors ligne).
import { tones } from "@/lib/sfx";

const PREF = "dabali:scan-audio"; // "on" (sons + voix) · "sound" (sons seuls) · "off"
export type AudioPref = "on" | "sound" | "off";

export function audioPref(): AudioPref {
  try { return (localStorage.getItem(PREF) as AudioPref) || "on"; } catch { return "on"; }
}
export function setAudioPref(p: AudioPref) { try { localStorage.setItem(PREF, p); } catch {} }

/** Ticket valide : « bip » de caisse net et court (+ petite note plus aiguë, agréable à entendre 300 fois par service). */
export function soundOk() {
  if (audioPref() === "off") return;
  tones([{ f: 1900, at: 0, dur: 0.11, type: "square", vol: 0.12 }, { f: 2530, at: 0.1, dur: 0.09, type: "sine", vol: 0.16 }]);
  navigator.vibrate?.(70);
}

/**
 * Refus. Deux sons bien différents, reconnaissables sans regarder l'écran :
 *  - ticket DÉJÀ UTILISÉ (tentative de resservir) : buzzer de jeu télé « bouuuh » qui descend, + trois « bip » graves ;
 *  - autres refus (expiré, QR invalide, mauvais service…) : double bourdonnement grave.
 */
export function soundError(code?: string) {
  if (audioPref() === "off") return;
  if (code === "ALREADY_USED") {
    tones([
      { f: 330, at: 0, dur: 0.55, type: "sawtooth", vol: 0.14, to: 110 },
      { f: 165, at: 0, dur: 0.55, type: "square", vol: 0.08, to: 70 },
      ...[0.65, 0.8, 0.95].map((at) => ({ f: 247, at, dur: 0.09, type: "square" as const, vol: 0.12 })),
    ]);
    navigator.vibrate?.([300, 80, 60, 60, 60]);
    return;
  }
  tones([{ f: 196, at: 0, dur: 0.2, type: "square", vol: 0.16 }, { f: 165, at: 0.24, dur: 0.32, type: "square", vol: 0.16 }]);
  navigator.vibrate?.([140, 70, 140]);
}

/** Plat enregistré : « clic » discret. */
export function soundServed() {
  if (audioPref() === "off") return;
  tones([{ f: 1760, at: 0, dur: 0.06, type: "triangle", vol: 0.2 }, { f: 2350, at: 0.06, dur: 0.12, type: "triangle", vol: 0.16 }]);
  navigator.vibrate?.(30);
}

/** Annonce vocale en français (si la voix est activée). */
export function say(text: string) {
  if (audioPref() !== "on" || !("speechSynthesis" in window)) return;
  try {
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = "fr-FR";
    u.rate = 1.08;
    const fr = window.speechSynthesis.getVoices().find((v) => v.lang.startsWith("fr"));
    if (fr) u.voice = fr;
    window.speechSynthesis.speak(u);
  } catch {}
}
