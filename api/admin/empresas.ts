import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getSupabase } from "../_lib/supabase";
import { getAccessToken } from "../_lib/auth";

// Lista de oficinas para el selector del superadmin - no toma
// empresaOverride (no hace falta elegir una empresa para pedir la lista de
// empresas), solo exige que el rol sea superadmin.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const supabase = getSupabase();
  const { data: userData, error: userError } = await supabase.auth.getUser(getAccessToken(req));
  if (userError || !userData?.user) {
    return res.status(401).json({ error: "Sesion invalida o vencida" });
  }
  const { data: perfil, error: perfilError } = await supabase
    .from("perfiles")
    .select("rol")
    .eq("id", userData.user.id)
    .maybeSingle();
  if (perfilError || !perfil || perfil.rol !== "superadmin") {
    return res.status(403).json({ error: "Solo el superadmin puede ver esto" });
  }

  const { data, error } = await supabase
    .from("empresas")
    .select("id, nombre")
    .eq("activo", true)
    .order("nombre");
  if (error) {
    return res.status(500).json({ error: "Error leyendo empresas" });
  }

  res.setHeader("Cache-Control", "no-store");
  return res.status(200).json({ empresas: data ?? [] });
}
