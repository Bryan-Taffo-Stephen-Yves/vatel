// Ce qui ne convient pas à une personne dans un plat (même règle que _diet_conflicts / _severe_hits en base et src/lib/diet.ts).
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
