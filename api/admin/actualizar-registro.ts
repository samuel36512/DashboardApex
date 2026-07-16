import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getSupabase } from "../_lib/supabase";
import { getAccessToken, requireDirector } from "../_lib/auth";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const supabase = getSupabase();
  const auth = await requireDirector(supabase, getAccessToken(req));
  if (!auth.ok) {
    return res.status(auth.status).json({ error: auth.error });
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const agenteId = Number(body.agenteId);
  const registro = Number(body.registro);
  if (!agenteId || !Number.isFinite(registro) || registro < 0) {
    return res.status(400).json({ error: "Faltan agenteId o registro (numero >= 0)" });
  }

  const { data: agente, error } = await supabase
    .from("agentes")
    .update({ registro_manual: Math.round(registro) })
    .eq("id", agenteId)
    .select("id, nombre, registro_manual")
    .maybeSingle();
  if (error || !agente) {
    return res.status(400).json({ error: error?.message || "Agente no encontrado" });
  }

  return res.status(200).json({ ok: true, agente });
}
