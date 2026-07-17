import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getSupabase } from "./_lib/supabase";

const LIMITE = 500;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
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
    .select("rol, agentes(nombre)")
    .eq("id", userData.user.id)
    .maybeSingle();
  if (perfilError || !perfil) {
    return res.status(403).json({ error: "Tu cuenta no tiene un perfil asignado" });
  }

  const rol = (perfil as any).rol as string;
  const agenteRel = (perfil as any).agentes;
  const miNombre: string | undefined = Array.isArray(agenteRel) ? agenteRel[0]?.nombre : agenteRel?.nombre;

  const desde = typeof req.query.desde === "string" ? req.query.desde : "";
  const hasta = typeof req.query.hasta === "string" ? req.query.hasta : "";
  if ((desde && Number.isNaN(Date.parse(desde))) || (hasta && Number.isNaN(Date.parse(hasta)))) {
    return res.status(400).json({ error: "desde/hasta deben ser fechas validas (YYYY-MM-DD)" });
  }

  async function traer(tipo: "registro" | "ftd") {
    // Se excluyen las filas "baseline-*" (historico sembrado a mano, sin
    // contactId ni nombre reales) porque no representan un cliente puntual
    // que se pueda mostrar en este panel.
    let query = supabase
      .from("eventos")
      .select("contacto_id, contacto_nombre, contacto_telefono, agente, fecha")
      .eq("tipo", tipo)
      .not("contacto_id", "like", "baseline-%")
      .order("fecha", { ascending: false })
      .limit(LIMITE);
    if (desde) query = query.gte("fecha", desde);
    if (hasta) query = query.lte("fecha", `${hasta}T23:59:59.999Z`);
    if (rol === "agente") query = query.eq("agente", miNombre ?? "");

    const { data, error } = await query;
    if (error) throw new Error(`Error leyendo ${tipo}: ${error.message}`);
    return (data ?? []).map((r) => ({
      contactoId: r.contacto_id,
      nombre: r.contacto_nombre || null,
      telefono: r.contacto_telefono || null,
      agente: r.agente,
      fecha: r.fecha,
    }));
  }

  try {
    const [registros, ftds] = await Promise.all([traer("registro"), traer("ftd")]);
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({
      registros,
      ftds,
      rol,
      actualizado: new Date().toISOString(),
      filtro: { desde: desde || null, hasta: hasta || null },
    });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || "Error leyendo usuarios" });
  }
}
