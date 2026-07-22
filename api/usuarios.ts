import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getSupabase } from "./_lib/supabase";
import { getAccessToken, requireAuth } from "./_lib/auth";

const LIMITE = 500;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const supabase = getSupabase();
  const auth = await requireAuth(supabase, getAccessToken(req));
  if (!auth.ok) {
    return res.status(auth.status).json({ error: auth.error });
  }
  const { empresaId, rol, agenteNombre: miNombre } = auth.ctx;

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
      .eq("empresa_id", empresaId)
      .not("contacto_id", "like", "baseline-%")
      .order("fecha", { ascending: false })
      .limit(LIMITE);
    // desde/hasta vienen del front como instante UTC completo (ya resuelto
    // desde el dia calendario LOCAL del director, no UTC) - si llegan como
    // fecha simple "YYYY-MM-DD" (uso directo de la API, sin el front), se
    // completa con el fin del dia en UTC como venia haciendose antes.
    if (desde) query = query.gte("fecha", desde);
    if (hasta) query = query.lte("fecha", hasta.includes("T") ? hasta : `${hasta}T23:59:59.999Z`);
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

    // La lista de agentes para el filtro tiene que ser el roster completo,
    // no solo los que tienen actividad en el rango filtrado - si no, con un
    // rango angosto el selector muestra solo un puñado de agentes.
    let agentesActivos: string[] = [];
    if (rol === "director") {
      const { data: agentesRows, error: agentesError } = await supabase
        .from("agentes")
        .select("nombre")
        .eq("activo", true)
        .eq("empresa_id", empresaId)
        .order("nombre");
      if (agentesError) throw new Error(`Error leyendo agentes: ${agentesError.message}`);
      agentesActivos = (agentesRows ?? []).map((a) => a.nombre);
    }

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({
      registros,
      ftds,
      rol,
      agentesActivos,
      actualizado: new Date().toISOString(),
      filtro: { desde: desde || null, hasta: hasta || null },
    });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || "Error leyendo usuarios" });
  }
}
