// Frais Mobile Money payés par l'élève — même calcul qu'en base (public._mobile_money_fee).
// total = arrondi au franc supérieur de montant / (1 − taux) : après la commission Jèko, la cantine reçoit le montant crédité.

/** Taux en % (0 à 10). 0 = la cantine absorbe les frais. */
export function mobileMoneyFee(amount: number, percent: number | null | undefined): number {
  const r = Math.min(Math.max(Number(percent) || 0, 0), 10);
  if (r <= 0 || !(amount > 0)) return 0;
  // calcul en entiers de centièmes de % pour éviter les erreurs d'arrondi (ex. 1,6 % → 160 / 10 000)
  const bp = Math.round(r * 100);
  return Math.ceil((amount * 10000) / (10000 - bp)) - amount;
}
