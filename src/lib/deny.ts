// « Pimpim » : refus d'une action (plat interdit pour allergie grave…) — l'élément tremble, deux bips, le téléphone vibre.
// L'iPhone ne laisse pas vibrer une page web : le tremblement et le son suffisent à faire comprendre le blocage.
let ctx: AudioContext | null = null;

function beep(at: number, f: number) {
  const C = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  ctx ??= new C();
  if (ctx.state === "suspended") ctx.resume();
  const o = ctx.createOscillator(), g = ctx.createGain(), t = ctx.currentTime + at;
  o.type = "triangle"; o.frequency.value = f;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.22, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.11);
  o.connect(g).connect(ctx.destination);
  o.start(t); o.stop(t + 0.13);
}

/** Fait trembler l'élément (et le relance si on retape), bip-bip et vibration. */
export function deny(el?: Element | null) {
  if (el) {
    el.classList.remove("animate-shake");
    void (el as HTMLElement).offsetWidth; // relance l'animation
    el.classList.add("animate-shake");
    setTimeout(() => el.classList.remove("animate-shake"), 500);
  }
  try { beep(0, 880); beep(0.15, 880); } catch {}
  try { navigator.vibrate?.([70, 50, 70]); } catch {}
}
