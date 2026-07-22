import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getSupabase } from "../_lib/supabase";
import { getAccessToken, getEmpresaOverride, requireDirector } from "../_lib/auth";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const supabase = getSupabase();
  const auth = await requireDirector(supabase, getAccessToken(req), { empresaOverride: getEmpresaOverride(req) });
  if (!auth.ok) {
    return res.status(auth.status).json({ error: auth.error });
  }
  const { empresaId } = auth.ctx;

  const { data: agentesRows, error: agentesError } = await supabase
    .from("agentes")
    .select("id, nombre, email_personal")
    .eq("activo", true)
    .eq("empresa_id", empresaId)
    .order("nombre");
  if (agentesError) {
    return res.status(500).json({ error: "No se pudo leer agentes" });
  }

  const { data: perfilesRows, error: perfilesError } = await supabase
    .from("perfiles")
    .select("agente_id, email")
    .eq("rol", "agente")
    .eq("empresa_id", empresaId);
  if (perfilesError) {
    return res.status(500).json({ error: "No se pudo leer perfiles" });
  }

  const emailByAgenteId = new Map<number, string>(
    (perfilesRows ?? [])
      .filter((p) => p.agente_id !== null)
      .map((p) => [p.agente_id as number, p.email as string])
  );

  const agentes = (agentesRows ?? []).map((a) => ({
    id: a.id,
    nombre: a.nombre,
    tieneAcceso: emailByAgenteId.has(a.id),
    email: emailByAgenteId.get(a.id) ?? null,
    emailPersonal: a.email_personal ?? null,
  }));

  return res.status(200).json({ agentes });
}
