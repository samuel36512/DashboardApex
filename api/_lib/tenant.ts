import type { getSupabase } from "./supabase";
import { timingSafeEqual } from "./validation";

type Supabase = ReturnType<typeof getSupabase>;

export interface EmpresaConfig {
  id: number;
  nombre: string;
  ghlApiToken: string | null;
  ghlLocationId: string | null;
  ghlPipelineId: string | null;
  ghlRegistradoStageId: string | null;
  ghlFtdStageId: string | null;
  ventasSheetId: string | null;
}

// Identifica de que empresa es una llamada externa (ghl-sync, ghl-debug,
// ventas-sync, el webhook de GHL) por su webhook_secret - reemplaza el
// EMPRESA_ID_ACTUAL fijo para que cada director pueda usar su propio
// secreto sin tocar codigo. Comparacion en tiempo constante contra cada
// empresa activa (son pocas, un por-director), igual que ya se hacia para
// el webhook original.
export async function resolveEmpresaFromSecret(
  supabase: Supabase,
  providedSecret: string
): Promise<EmpresaConfig | null> {
  if (!providedSecret) return null;

  const { data, error } = await supabase
    .from("empresas")
    .select(
      "id, nombre, webhook_secret, ghl_api_token, ghl_location_id, ghl_pipeline_id, ghl_registrado_stage_id, ghl_ftd_stage_id, ventas_sheet_id"
    )
    .eq("activo", true);
  if (error || !data) return null;

  for (const row of data) {
    const secretoEmpresa = row.webhook_secret as string | null;
    if (secretoEmpresa && timingSafeEqual(providedSecret, secretoEmpresa)) {
      return {
        id: row.id as number,
        nombre: row.nombre as string,
        ghlApiToken: (row.ghl_api_token as string | null) ?? null,
        ghlLocationId: (row.ghl_location_id as string | null) ?? null,
        ghlPipelineId: (row.ghl_pipeline_id as string | null) ?? null,
        ghlRegistradoStageId: (row.ghl_registrado_stage_id as string | null) ?? null,
        ghlFtdStageId: (row.ghl_ftd_stage_id as string | null) ?? null,
        ventasSheetId: (row.ventas_sheet_id as string | null) ?? null,
      };
    }
  }
  return null;
}
