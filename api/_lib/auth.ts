import type { SupabaseClient } from "@supabase/supabase-js";
import type { VercelRequest } from "@vercel/node";

export function getAccessToken(req: VercelRequest): string {
  const authHeader = req.headers.authorization ?? "";
  return authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
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
}

export interface AuthContext {
  userId: string;
  rol: "director" | "agente";
  empresaId: number;
  agenteId: number | null;
  agenteNombre: string | null;
  empresa: EmpresaRates;
}

type AuthResult = { ok: true; ctx: AuthContext } | { ok: false; status: number; error: string };

export async function requireAuth(
  supabase: SupabaseClient,
  accessToken: string,
  opts?: { role?: "director" }
): Promise<AuthResult> {
  if (!accessToken) return { ok: false, status: 401, error: "No autorizado" };

  const { data: userData, error: userError } = await supabase.auth.getUser(accessToken);
  if (userError || !userData?.user) {
    return { ok: false, status: 401, error: "Sesion invalida o vencida" };
  }

  // Una sola consulta resuelve rol + empresa + nombre de agente (si aplica)
  // + las tarifas de esa empresa - antes cada endpoint repetia por su cuenta
  // el getUser + la consulta a perfiles.
  const { data: perfil, error: perfilError } = await supabase
    .from("perfiles")
    .select(
      "rol, empresa_id, agente_id, agentes(nombre), empresas(tasa_pauta_ejecutivo_cop, tasa_pauta_junior_cop, comision_director_base_usd, comision_director_alta_usd, umbral_ftd_tasa_alta, tasa_comision_director_ventas, comision_por_ftd_usd, meta_ventas_usd)"
    )
    .eq("id", userData.user.id)
    .maybeSingle();

  if (perfilError || !perfil || !perfil.empresa_id) {
    return { ok: false, status: 403, error: "Tu cuenta no tiene un perfil asignado" };
  }
  if (opts?.role && perfil.rol !== opts.role) {
    return { ok: false, status: 403, error: "Solo el director puede hacer esto" };
  }

  const agenteRel = (perfil as any).agentes;
  const agenteNombre: string | null = Array.isArray(agenteRel) ? agenteRel[0]?.nombre ?? null : agenteRel?.nombre ?? null;
  const e = (perfil as any).empresas;
  const empresaRow = Array.isArray(e) ? e[0] : e;
  if (!empresaRow) {
    return { ok: false, status: 500, error: "No se encontro la configuracion de tu empresa" };
  }

  return {
    ok: true,
    ctx: {
      userId: userData.user.id,
      rol: perfil.rol as "director" | "agente",
      empresaId: perfil.empresa_id as number,
      agenteId: (perfil.agente_id as number | null) ?? null,
      agenteNombre,
      empresa: {
        tasaPautaEjecutivoCOP: Number(empresaRow.tasa_pauta_ejecutivo_cop),
        tasaPautaJuniorCOP: Number(empresaRow.tasa_pauta_junior_cop),
        comisionDirectorBaseUSD: Number(empresaRow.comision_director_base_usd),
        comisionDirectorAltaUSD: Number(empresaRow.comision_director_alta_usd),
        umbralFtdTasaAlta: Number(empresaRow.umbral_ftd_tasa_alta),
        tasaComisionDirectorVentas: Number(empresaRow.tasa_comision_director_ventas),
        comisionPorFtdUSD: Number(empresaRow.comision_por_ftd_usd),
        metaVentasUSD: Number(empresaRow.meta_ventas_usd),
      },
    },
  };
}

// Wrapper de compatibilidad para los endpoints que ya usaban requireDirector.
export async function requireDirector(supabase: SupabaseClient, accessToken: string): Promise<AuthResult> {
  return requireAuth(supabase, accessToken, { role: "director" });
}
