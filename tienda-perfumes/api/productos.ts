import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getSupabase } from "./_lib/supabase";

// Catálogo público: sin autenticación, igual que /metrics en el dashboard
// hermano. Solo muestra productos activos y con stock disponible en el
// proveedor.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("productos")
    .select("id, nombre, marca, descripcion, precio, imagen_url")
    .eq("activo", true)
    .eq("disponible", true)
    .order("nombre");

  if (error) {
    return res.status(500).json({ error: "Error obteniendo el catálogo" });
  }

  return res.status(200).json({ productos: data });
}
