/** Page où revenir après connexion/inscription (?next=…) : chemin interne uniquement, jamais un autre site. */
export function safeNext(raw: string | null | undefined): string | null {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\")) return null;
  // Tabulation, retour à la ligne, antislash… : le navigateur les retire et « /\t/site.tld » deviendrait « //site.tld »
  if (/[\u0000-\u001f\u007f\\]/.test(raw)) return null;
  try { if (new URL(raw, "https://interne.invalid").origin !== "https://interne.invalid") return null; } catch { return null; }
  if (raw.startsWith("/connexion") || raw.startsWith("/inscription")) return null;
  return raw;
}
export const nextFromUrl = () => (typeof window === "undefined" ? null : safeNext(new URLSearchParams(window.location.search).get("next")));
