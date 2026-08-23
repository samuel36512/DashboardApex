import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getSupabase } from "../_lib/supabase";
import { isAdminAuthorized } from "../_lib/auth";

// GET /admin/pedidos — lista pedidos, más nuevos primero. ?estado=pagado
// filtra por estado (útil para ver solo lo que falta despachar).
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  if (!isAdminAuthorized(req)) {
    return res.status(401).json({ error: "No autorizado" });
  }

  const supabase = getSupabase();
  let query = supabase.from("pedidos").select("*").order("creado_en", { ascending: false }).limit(200);

  const estado = req.query.estado;
  if (typeof estado === "string" && estado) {
    query = query.eq("estado", estado);
  }

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: "Error obteniendo pedidos" });
  return res.status(200).json({ pedidos: data });
}
