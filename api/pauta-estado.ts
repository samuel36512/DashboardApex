import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getSupabase } from "./_lib/supabase";
import { getDiasActivosPautaMes, toggleActiva } from "./_lib/pautaEstado";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const authHeader = req.headers.authorization ?? "";
  const accessToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (!accessToken) {
    return res.status(401).json({ error: "No autorizado" });
  }

  const supabase = getSupabase();

  const { data: userData, error: userError } = await supabase.auth.getUser(accessToken);
  if (userError || !userData?.user) {
    return res.status(401).json({ error: "Sesion invalida o vencida" });
  }

  const { data: perfil, error: perfilError } = await supabase
    .from("perfiles")
    .select("rol")
    .eq("id", userData.user.id)
    .maybeSingle();
  if (perfilError || !perfil) {
    return res.status(403).json({ error: "Tu cuenta no tiene un perfil asignado" });
  }
  const rol = (perfil as any).rol as string;
  if (rol !== "director") {
    return res.status(403).json({ error: "Esta informacion es solo para el director" });
  }

  if (req.method === "POST") {
    try {
      const { activa } = await toggleActiva(supabase);
      res.setHeader("Cache-Control", "no-store");
      return res.status(200).json({ activa });
    } catch (err: any) {
      return res.status(500).json({ error: err?.message || "Error guardando el estado de la pauta" });
    }
  }

  const { diaDelMes, diasActivos, activa } = await getDiasActivosPautaMes(supabase);
  res.setHeader("Cache-Control", "no-store");
  return res.status(200).json({ activa, diaDelMes, diasActivos });
}
