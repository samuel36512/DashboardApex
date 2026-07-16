import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getSupabase } from "../_lib/supabase";
import { getAccessToken, requireDirector } from "../_lib/auth";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const supabase = getSupabase();
  const auth = await requireDirector(supabase, getAccessToken(req));
  if (!auth.ok) {
    return res.status(auth.status).json({ error: auth.error });
  }

  const { data: agentesRows, error: agentesError } = await supabase
    .from("agentes")
    .select("id, nombre, registro_manual")
    .eq("activo", true)
    .order("nombre");
  if (agentesError) {
    return res.status(500).json({ error: "No se pudo leer agentes" });
  }

  const { data: perfilesRows, error: perfilesError } = await supabase
    .from("perfiles")
    .select("agente_id, email")
    .eq("rol", "agente");
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
    registroManual: a.registro_manual ?? 0,
    tieneAcceso: emailByAgenteId.has(a.id),
    email: emailByAgenteId.get(a.id) ?? null,
  }));

  return res.status(200).json({ agentes });
}
