import type { SupabaseClient } from "@supabase/supabase-js";
import type { VercelRequest } from "@vercel/node";

export function getAccessToken(req: VercelRequest): string {
  const authHeader = req.headers.authorization ?? "";
  return authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
}

// req.query.empresa solo tiene efecto si el perfil autenticado es
// superadmin (se valida server-side, nunca confiando en el rol que venga
// del cliente) - para director/agente este valor se ignora siempre.
export function getEmpresaOverride(req: VercelRequest): number | undefined {
  const raw = req.query.empresa;
  const valor = typeof raw === "string" ? Number(raw) : NaN;
  return Number.isFinite(valor) ? valor : undefined;
}

export interface EmpresaRates {
  tasaPautaEjecutivoCOP: number;
  tasaPautaJuniorCOP: number;
  comisionDirectorBaseUSD: number;
  comisionDirectorAltaUSD: number;
  umbralFtdTasaAlta: number;
  tasaComisionDirectorVentas: number;
  comisionPorFtdUSD: number;
  metaVentasUSD: number;
  costoPorLeadFijoCOP: number | null;
  abonosMontoUSD: number;
  abonosCantidad: number;
  abonosActualizadoEn: string | null;
}

export interface AuthContext {
  userId: string;
  rol: "director" | "agente" | "superadmin";
  empresaId: number;
  empresaNombre: string;
  agenteId: number | null;
  agenteNombre: string | null;
  empresa: EmpresaRates;
}

type AuthResult = { ok: true; ctx: AuthContext } | { ok: false; status: number; error: string };

const EMPRESA_COLUMNS =
  "id, nombre, tasa_pauta_ejecutivo_cop, tasa_pauta_junior_cop, comision_director_base_usd, comision_director_alta_usd, umbral_ftd_tasa_alta, tasa_comision_director_ventas, comision_por_ftd_usd, meta_ventas_usd, costo_por_lead_fijo_cop, abonos_monto_usd, abonos_cantidad, abonos_actualizado_en";

function empresaRatesDesde(empresaRow: any): EmpresaRates {
  return {
    tasaPautaEjecutivoCOP: Number(empresaRow.tasa_pauta_ejecutivo_cop),
    tasaPautaJuniorCOP: Number(empresaRow.tasa_pauta_junior_cop),
    comisionDirectorBaseUSD: Number(empresaRow.comision_director_base_usd),
    comisionDirectorAltaUSD: Number(empresaRow.comision_director_alta_usd),
    umbralFtdTasaAlta: Number(empresaRow.umbral_ftd_tasa_alta),
    tasaComisionDirectorVentas: Number(empresaRow.tasa_comision_director_ventas),
    comisionPorFtdUSD: Number(empresaRow.comision_por_ftd_usd),
    metaVentasUSD: Number(empresaRow.meta_ventas_usd),
    costoPorLeadFijoCOP:
      empresaRow.costo_por_lead_fijo_cop === null || empresaRow.costo_por_lead_fijo_cop === undefined
        ? null
        : Number(empresaRow.costo_por_lead_fijo_cop),
    abonosMontoUSD: Number(empresaRow.abonos_monto_usd ?? 0),
    abonosCantidad: Number(empresaRow.abonos_cantidad ?? 0),
    abonosActualizadoEn: empresaRow.abonos_actualizado_en ?? null,
  };
}

export async function requireAuth(
  supabase: SupabaseClient,
  accessToken: string,
  opts?: { role?: "director"; empresaOverride?: number }
): Promise<AuthResult> {
  if (!accessToken) return { ok: false, status: 401, error: "No autorizado" };

  const { data: userData, error: userError } = await supabase.auth.getUser(accessToken);
  if (userError || !userData?.user) {
    return { ok: false, status: 401, error: "Sesion invalida o vencida" };
  }

  // Una sola consulta resuelve rol + empresa + nombre de agente (si aplica)
  // + las tarifas de esa empresa - antes cada endpoint repetia por su cuenta
  // el getUser + la consulta a perfiles. Para superadmin, empresa_id viene
  // null (no pertenece a una empresa fija) - su empresa efectiva se resuelve
  // aparte, mas abajo, a partir de opts.empresaOverride.
  const { data: perfil, error: perfilError } = await supabase
    .from("perfiles")
    .select(`rol, empresa_id, agente_id, agentes(nombre), empresas(${EMPRESA_COLUMNS})`)
    .eq("id", userData.user.id)
    .maybeSingle();

  if (perfilError || !perfil) {
    return { ok: false, status: 403, error: "Tu cuenta no tiene un perfil asignado" };
  }
  const rol = perfil.rol as "director" | "agente" | "superadmin";
  if (rol !== "superadmin" && !perfil.empresa_id) {
    return { ok: false, status: 403, error: "Tu cuenta no tiene un perfil asignado" };
  }
  if (opts?.role && rol !== opts.role && rol !== "superadmin") {
    return { ok: false, status: 403, error: "Solo el director puede hacer esto" };
  }

  const agenteRel = (perfil as any).agentes;
  const agenteNombre: string | null = Array.isArray(agenteRel) ? agenteRel[0]?.nombre ?? null : agenteRel?.nombre ?? null;

  let empresaRow: any;
  if (rol === "superadmin") {
    // El superadmin no tiene empresa propia - la elige por request via
    // ?empresa=ID, validada contra una empresa real y activa. Nunca se
    // confia en un rol enviado por el cliente: rol siempre sale de la
    // consulta a perfiles de arriba, resuelta server-side.
    if (!opts?.empresaOverride) {
      return { ok: false, status: 400, error: "Elegi una empresa (parametro ?empresa=)" };
    }
    const { data: empresaData, error: empresaError } = await supabase
      .from("empresas")
      .select(EMPRESA_COLUMNS)
      .eq("id", opts.empresaOverride)
      .eq("activo", true)
      .maybeSingle();
    if (empresaError || !empresaData) {
      return { ok: false, status: 404, error: "Esa empresa no existe o no esta activa" };
    }
    empresaRow = empresaData;
  } else {
    const e = (perfil as any).empresas;
    empresaRow = Array.isArray(e) ? e[0] : e;
    if (!empresaRow) {
      return { ok: false, status: 500, error: "No se encontro la configuracion de tu empresa" };
    }
  }

  return {
    ok: true,
    ctx: {
      userId: userData.user.id,
      rol,
      empresaId: empresaRow.id as number,
      empresaNombre: (empresaRow.nombre as string) ?? "",
      agenteId: (perfil.agente_id as number | null) ?? null,
      agenteNombre,
      empresa: empresaRatesDesde(empresaRow),
    },
  };
}

// Wrapper de compatibilidad para los endpoints que ya usaban requireDirector.
export async function requireDirector(
  supabase: SupabaseClient,
  accessToken: string,
  opts?: { empresaOverride?: number }
): Promise<AuthResult> {
  return requireAuth(supabase, accessToken, { role: "director", empresaOverride: opts?.empresaOverride });
}
