/** Page où revenir après connexion/inscription (?next=…) : chemin interne uniquement, jamais un autre site. */
export function safeNext(raw: string | null | undefined): string | null {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\")) return null;
  if (raw.startsWith("/connexion") || raw.startsWith("/inscription")) return null;
  return raw;
}
export const nextFromUrl = () => (typeof window === "undefined" ? null : safeNext(new URLSearchParams(window.location.search).get("next")));
