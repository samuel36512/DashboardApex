import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getSupabase } from "./_lib/supabase";
import { getDiasActivosPautaMes, toggleActiva } from "./_lib/pautaEstado";
import { getAccessToken, requireAuth } from "./_lib/auth";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const supabase = getSupabase();
  const auth = await requireAuth(supabase, getAccessToken(req), { role: "director" });
  if (!auth.ok) {
    return res.status(auth.status).json({ error: auth.error });
  }
  const { empresaId } = auth.ctx;

  if (req.method === "POST") {
    try {
      const { activa } = await toggleActiva(supabase, empresaId);
      res.setHeader("Cache-Control", "no-store");
      return res.status(200).json({ activa });
    } catch (err: any) {
      return res.status(500).json({ error: err?.message || "Error guardando el estado de la pauta" });
    }
  }

  const { diaDelMes, diasActivos, activa } = await getDiasActivosPautaMes(supabase, empresaId);
  res.setHeader("Cache-Control", "no-store");
  return res.status(200).json({ activa, diaDelMes, diasActivos });
}
