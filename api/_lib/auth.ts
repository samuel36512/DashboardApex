import type { SupabaseClient } from "@supabase/supabase-js";
import type { VercelRequest } from "@vercel/node";

export function getAccessToken(req: VercelRequest): string {
  const authHeader = req.headers.authorization ?? "";
  return authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
}

export async function requireDirector(
  supabase: SupabaseClient,
  accessToken: string
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  if (!accessToken) return { ok: false, status: 401, error: "No autorizado" };

  const { data: userData, error: userError } = await supabase.auth.getUser(accessToken);
  if (userError || !userData?.user) {
    return { ok: false, status: 401, error: "Sesion invalida o vencida" };
  }

  const { data: perfil, error: perfilError } = await supabase
    .from("perfiles")
    .select("rol")
    .eq("id", userData.user.id)
    .maybeSingle();

  if (perfilError || !perfil || perfil.rol !== "director") {
    return { ok: false, status: 403, error: "Solo el director puede hacer esto" };
  }

  return { ok: true };
}
