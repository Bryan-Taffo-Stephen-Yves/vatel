/** Texte saisi par un utilisateur, rendu sûr avant de l'écrire dans du HTML (reçus, cartes imprimées). */
export const escapeHtml = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
