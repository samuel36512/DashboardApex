import type { getSupabase } from "./supabase";
import { diaDelMesColombia } from "./agentTier";

type Supabase = ReturnType<typeof getSupabase>;

function periodoActualColombia(): string {
  const ahoraCo = new Date(Date.now() - 5 * 60 * 60 * 1000);
  const anio = ahoraCo.getUTCFullYear();
  const mes = String(ahoraCo.getUTCMonth() + 1).padStart(2, "0");
  return `${anio}-${mes}`;
}

interface PautaEstadoRow {
  activa: boolean;
  desde: string;
  dias_inactivos_mes: number;
  periodo: string;
}

async function leerEstado(supabase: Supabase, empresaId: number): Promise<PautaEstadoRow> {
  const { data } = await supabase.from("pauta_estado").select("*").eq("empresa_id", empresaId).maybeSingle();
  const periodoActual = periodoActualColombia();
  if (!data) {
    return { activa: true, desde: new Date().toISOString(), dias_inactivos_mes: 0, periodo: periodoActual };
  }
  if (data.periodo !== periodoActual) {
    // Nuevo mes: se reinicia el contador de dias inactivos, pero se respeta
    // si la pauta seguia pausada desde el mes anterior.
    return { activa: data.activa, desde: new Date().toISOString(), dias_inactivos_mes: 0, periodo: periodoActual };
  }
  return data as PautaEstadoRow;
}

// Dias del mes en curso en los que la pauta estuvo REALMENTE activa (resta
// el tiempo pausado con el boton "Pauta desactivada"), para que el costo
// por FTD refleje la inversion real y no asuma que el anuncio corrio todos
// los dias del mes.
export async function getDiasActivosPautaMes(
  supabase: Supabase,
  empresaId: number
): Promise<{ diaDelMes: number; diasActivos: number; activa: boolean }> {
  const estado = await leerEstado(supabase, empresaId);
  const diaDelMes = diaDelMesColombia();
  let diasInactivos = Number(estado.dias_inactivos_mes) || 0;
  if (!estado.activa) {
    const desdeMs = new Date(estado.desde).getTime();
    diasInactivos += Math.max(0, (Date.now() - desdeMs) / 86400000);
  }
  const diasActivos = Math.max(0, diaDelMes - diasInactivos);
  return { diaDelMes, diasActivos, activa: estado.activa };
}

export async function toggleActiva(supabase: Supabase, empresaId: number): Promise<{ activa: boolean }> {
  const estado = await leerEstado(supabase, empresaId);
  const periodoActual = periodoActualColombia();
  const ahora = new Date();
  let diasInactivosMes = Number(estado.dias_inactivos_mes) || 0;

  if (!estado.activa) {
    // Se esta reactivando: se suma el tiempo que estuvo pausada.
    const desdeMs = new Date(estado.desde).getTime();
    diasInactivosMes += Math.max(0, (ahora.getTime() - desdeMs) / 86400000);
  }

  const nuevaActiva = !estado.activa;
  const { error } = await supabase.from("pauta_estado").upsert({
    empresa_id: empresaId,
    activa: nuevaActiva,
    desde: ahora.toISOString(),
    dias_inactivos_mes: diasInactivosMes,
    periodo: periodoActual,
  });
  if (error) throw new Error(`Error guardando estado de pauta: ${error.message}`);
  return { activa: nuevaActiva };
}
