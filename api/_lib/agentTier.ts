// Categoria de pauta por agente (ejecutivo/junior), confirmada por el
// director - define cuanto se le invierte por dia en publicidad. Los
// agentes activos que no aparecen aca todavia no tienen categoria
// asignada, asi que quedan afuera de cualquier calculo de costo por FTD.
export const AGENTE_TIER: Record<string, "ejecutivo" | "junior"> = {
  "Angela Galindez": "ejecutivo",
  "Fernando Sandoval": "ejecutivo",
  "Henry Andrés Correa": "ejecutivo",
  "Jhon Camacho": "ejecutivo",
  "Juanita Sánchez": "ejecutivo",
  "Luis Gómez": "ejecutivo",
  "Nicolás Correa": "ejecutivo",
  "Sergio Gallo": "junior",
  "Santiago Charry": "junior",
  "María Paula Guevara": "junior",
  "Luna Sandoval": "junior",
  "Luis Felipe Charry": "junior",
  "Juan Ceballos": "junior",
  "Gabriel Alejandro Monteverde": "junior",
  "Diego Alejandro Mora": "junior",
  "Daniela Charry": "junior",
  "Ana Sánchez": "junior",
  "Laura Charry": "junior",
  "Andry Camacho": "junior",
};

export const TASA_EJECUTIVO_COP = Number(process.env.TASA_PAUTA_EJECUTIVO_COP ?? 100000);
export const TASA_JUNIOR_COP = Number(process.env.TASA_PAUTA_JUNIOR_COP ?? 50000);

// "Hoy" y "dia del mes" segun la hora de Colombia (UTC-5), para que el
// gasto de pauta acumulado (que se paga por dia calendario) no dependa de
// en que zona horaria corre el server.
export function diaDelMesColombia(): number {
  const ahoraCo = new Date(Date.now() - 5 * 60 * 60 * 1000);
  return ahoraCo.getUTCDate();
}

export function tasaDiariaCOP(agente: string): number | null {
  const tier = AGENTE_TIER[agente];
  if (!tier) return null;
  return tier === "ejecutivo" ? TASA_EJECUTIVO_COP : TASA_JUNIOR_COP;
}
