// Régimes et allergies (guide Vatel) : ce que l'élève déclare, et ce qui ne lui convient pas dans un plat.
// Les 14 allergènes de la liste officielle internationale (même liste qu'en base : _allergen_list)
export const ALLERGIES = ["arachide", "gluten", "lait", "œuf", "poisson", "crustacés", "mollusques", "fruits à coque", "soja", "sésame", "moutarde", "céleri", "sulfites", "lupin"] as const;
export const DIETS = [
  { id: "vegetarien", label: "Végétarien" },
  { id: "sans_porc", label: "Sans porc" },
  { id: "sans_piment", label: "Pas pimenté" },
] as const;

type Person = { allergies?: string[] | null; diets?: string[] | null; severe_allergies?: string[] | null } | null | undefined;
type DishLike = { allergens?: string[] | null; traces?: string[] | null; diet_tags?: string[] | null } | null | undefined;

/** Allergènes déclarés GRAVES présents dans le plat (contient ou traces) : commande refusée */
export function severeHits(p: Person, d: DishLike): string[] {
  if (!p || !d) return [];
  return (p.severe_allergies ?? []).filter((a) => [...(d.allergens ?? []), ...(d.traces ?? [])].includes(a));
}

/** Raisons pour lesquelles le plat ne convient pas (liste vide = compatible). Même règle qu'en base (_diet_conflicts, _severe_hits). */
export function dietConflicts(p: Person, d: DishLike): string[] {
  if (!p || !d) return [];
  const severe = severeHits(p, d);
  const out = severe.map((a) => `⛔ allergie grave : ${a}`);
  for (const a of p.allergies ?? []) {
    if (severe.includes(a)) continue;
    if ((d.allergens ?? []).includes(a)) out.push(`contient ${a}`);
    else if ((d.traces ?? []).includes(a)) out.push(`traces possibles de ${a}`);
  }
  if ((p.diets ?? []).includes("vegetarien") && !(d.diet_tags ?? []).includes("vegetarien")) out.push("pas végétarien");
  if ((p.diets ?? []).includes("sans_porc") && !(d.diet_tags ?? []).includes("sans_porc")) out.push("contient du porc");
  if ((p.diets ?? []).includes("sans_piment") && (d.diet_tags ?? []).includes("pimente")) out.push("pimenté (demande-le sans piment)");
  return out;
}

/** Étiquettes qu'un chef peut poser sur un plat */
export const DISH_TAGS = [
  { id: "vegetarien", label: "Végétarien" },
  { id: "sans_porc", label: "Sans porc" },
  { id: "pimente", label: "Pimenté" },
] as const;

export const hasDietPrefs = (p: Person) => !!p && ((p.allergies?.length ?? 0) + (p.diets?.length ?? 0)) > 0;

// ─── Affichage en anglais (les identifiants restent en français en base) ───
const ALLERGEN_EN: Record<string, string> = {
  arachide: "peanut", gluten: "gluten", lait: "milk", "œuf": "egg", poisson: "fish", "crustacés": "crustaceans",
  mollusques: "molluscs", "fruits à coque": "tree nuts", soja: "soy", "sésame": "sesame", moutarde: "mustard",
  "céleri": "celery", sulfites: "sulphites", lupin: "lupin",
};
/** Nom d'allergène à afficher (l'identifiant stocké reste en français) */
export const allergenLabel = (a: string, lang: "fr" | "en") => (lang === "en" ? ALLERGEN_EN[a] ?? a : a);
/** Avertissement de dietConflicts traduit en anglais (phrase + nom d'allergène) */
export const warnEn = (w: string) => {
  const al = (s: string) => s.split(", ").map((x) => ALLERGEN_EN[x] ?? x).join(", ");
  return w.replace(/^⛔ allergie grave : (.+)$/, (_, a) => `⛔ severe allergy: ${al(a)}`)
    .replace(/^contient du porc$/, "contains pork")
    .replace(/^contient (.+)$/, (_, a) => `contains ${al(a)}`)
    .replace(/^traces possibles de (.+)$/, (_, a) => `may contain traces of ${al(a)}`)
    .replace(/^pas végétarien$/, "not vegetarian")
    .replace(/^pimenté \(demande-le sans piment\)$/, "spicy (ask for it without chili)");
};
