// "Hoy" y "dia del mes" segun la hora de Colombia (UTC-5), para que el
// gasto de pauta acumulado (que se paga por dia calendario) no dependa de
// en que zona horaria corre el server.
export function diaDelMesColombia(): number {
  const ahoraCo = new Date(Date.now() - 5 * 60 * 60 * 1000);
  return ahoraCo.getUTCDate();
}

export function tasaDiariaCOP(
  tier: "ejecutivo" | "junior" | null,
  tasas: { ejecutivoCOP: number; juniorCOP: number }
): number | null {
  if (!tier) return null;
  return tier === "ejecutivo" ? tasas.ejecutivoCOP : tasas.juniorCOP;
}
