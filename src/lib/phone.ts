// Numéros mobiles ivoiriens (10 chiffres : 01 Moov, 05 MTN, 07 Orange).

/** "+225 07 01 02 03 04", "00225…", "07 01…" -> "0701020304" (chiffres seulement, indicatif retiré) */
export function phoneDigits(raw: string | null | undefined): string {
  let d = String(raw ?? "").replace(/\D/g, "");
  if (d.length > 10 && d.startsWith("00225")) d = d.slice(5);
  else if (d.length > 10 && d.startsWith("225")) d = d.slice(3);
  return d;
}

/**
 * Nouvelle valeur d'un champ téléphone après une frappe ou un collage.
 * Plus de 10 chiffres (une frappe de trop dans un champ plein) : la frappe est ignorée,
 * au lieu de décaler ou de couper le numéro déjà saisi.
 */
export function nextPhone(raw: string, prev: string): string {
  const d = phoneDigits(raw);
  return d.length > 10 ? prev : d;
}

/** "0701020304" -> "07 01 02 03 04" */
export const formatPhone = (digits: string) => digits.replace(/(\d{2})(?=\d)/g, "$1 ");
