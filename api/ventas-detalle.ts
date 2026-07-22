import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getSupabase } from "./_lib/supabase";
import { getAccessToken, getEmpresaOverride, requireAuth } from "./_lib/auth";

const LIMITE = 500;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const supabase = getSupabase();
  const auth = await requireAuth(supabase, getAccessToken(req), { empresaOverride: getEmpresaOverride(req) });
  if (!auth.ok) {
    return res.status(auth.status).json({ error: auth.error });
  }
  const { empresaId, rol, agenteNombre: miNombre } = auth.ctx;

  const desde = typeof req.query.desde === "string" ? req.query.desde : "";
  const hasta = typeof req.query.hasta === "string" ? req.query.hasta : "";
  if ((desde && Number.isNaN(Date.parse(desde))) || (hasta && Number.isNaN(Date.parse(hasta)))) {
    return res.status(400).json({ error: "desde/hasta deben ser fechas validas" });
  }
  const agenteFiltro = typeof req.query.agente === "string" ? req.query.agente.trim() : "";

  let query = supabase
    .from("eventos")
    .select("contacto_nombre, agente, producto, monto, comision, fecha")
    .eq("tipo", "venta")
    .eq("empresa_id", empresaId)
    .order("fecha", { ascending: false })
    .limit(LIMITE);
  if (desde) query = query.gte("fecha", desde);
  if (hasta) query = query.lte("fecha", hasta.includes("T") ? hasta : `${hasta}T23:59:59.999Z`);
  if (rol === "agente") query = query.eq("agente", miNombre ?? "");
  else if (agenteFiltro) query = query.eq("agente", agenteFiltro);

  const { data, error } = await query;
  if (error) {
    return res.status(500).json({ error: "Error leyendo ventas" });
  }

  let agentesActivos: string[] = [];
  if (rol === "director") {
    const { data: agentesRows, error: agentesError } = await supabase
      .from("agentes")
      .select("nombre")
      .eq("activo", true)
      .eq("empresa_id", empresaId)
      .order("nombre");
    if (agentesError) {
      return res.status(500).json({ error: "Error leyendo agentes" });
    }
    agentesActivos = (agentesRows ?? []).map((a) => a.nombre);
  }

  const ventas = (data ?? []).map((r) => ({
    cliente: r.contacto_nombre || null,
    agente: r.agente,
    producto: r.producto || null,
    monto: Number(r.monto ?? 0),
    comision: Number(r.comision ?? 0),
    fecha: r.fecha,
  }));

  res.setHeader("Cache-Control", "no-store");
  return res.status(200).json({
    rol,
    ventas,
    agentesActivos,
    actualizado: new Date().toISOString(),
    filtro: { desde: desde || null, hasta: hasta || null, agente: agenteFiltro || null },
  });
}
