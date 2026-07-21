import type { getSupabase } from "./supabase";
import { diaDelMesColombia } from "./agentTier";
import { EMPRESA_ID_ACTUAL } from "./empresaActual";

type Supabase = ReturnType<typeof getSupabase>;

// NOTA MIGRACION: por ahora se sigue usando id=1 como fila unica (todavia
// no se corrio la migracion que hace empresa_id la clave primaria de esta
// tabla) - este archivo se actualiza para usar empresa_id en el mismo paso
// en que se corre esa migracion (ver plan de multi-empresa), no antes,
// porque hasta ese momento la columna "id" todavia existe y es la clave.
const PAUTA_ROW_ID = 1;

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

async function leerEstado(supabase: Supabase): Promise<PautaEstadoRow> {
  const { data } = await supabase.from("pauta_estado").select("*").eq("id", PAUTA_ROW_ID).maybeSingle();
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
  supabase: Supabase
): Promise<{ diaDelMes: number; diasActivos: number; activa: boolean }> {
  const estado = await leerEstado(supabase);
  const diaDelMes = diaDelMesColombia();
  let diasInactivos = Number(estado.dias_inactivos_mes) || 0;
  if (!estado.activa) {
    const desdeMs = new Date(estado.desde).getTime();
    diasInactivos += Math.max(0, (Date.now() - desdeMs) / 86400000);
  }
  const diasActivos = Math.max(0, diaDelMes - diasInactivos);
  return { diaDelMes, diasActivos, activa: estado.activa };
}

export async function toggleActiva(supabase: Supabase): Promise<{ activa: boolean }> {
  const estado = await leerEstado(supabase);
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
    id: PAUTA_ROW_ID,
    empresa_id: EMPRESA_ID_ACTUAL,
    activa: nuevaActiva,
    desde: ahora.toISOString(),
    dias_inactivos_mes: diasInactivosMes,
    periodo: periodoActual,
  });
  if (error) throw new Error(`Error guardando estado de pauta: ${error.message}`);
  return { activa: nuevaActiva };
}
