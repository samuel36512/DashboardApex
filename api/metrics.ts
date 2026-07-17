import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getSupabase } from "./_lib/supabase";

interface AgentAgg {
  leads: number;
  registros: number;
  ftds: number;
  ventasUSD: number;
}

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

  const desde = typeof req.query.desde === "string" ? req.query.desde : "";
  const hasta = typeof req.query.hasta === "string" ? req.query.hasta : "";
  if ((desde && Number.isNaN(Date.parse(desde))) || (hasta && Number.isNaN(Date.parse(hasta)))) {
    return res.status(400).json({ error: "desde/hasta deben ser fechas validas (YYYY-MM-DD)" });
  }

  // Registro y ftd ahora se sincronizan completos con fecha real (por etapa
  // del pipeline), asi que ya no hace falta sumar un total manual aparte -
  // todo sale de eventos, igual que lead/venta.
  const { data: agentesRows, error: agentesError } = await supabase
    .from("agentes")
    .select("nombre")
    .eq("activo", true);
  if (agentesError) {
    return res.status(500).json({ error: "Error leyendo agentes" });
  }

  const byAgent = new Map<string, AgentAgg>();
  for (const a of agentesRows ?? []) {
    byAgent.set(a.nombre, { leads: 0, registros: 0, ftds: 0, ventasUSD: 0 });
  }

  // Supabase/PostgREST limita cada consulta a un maximo de filas (tipicamente
  // 1000), asi que con una tabla grande hay que paginar explicitamente para
  // traer todo, si no los conteos quedan cortados.
  const PAGE = 1000;
  for (let offset = 0; ; offset += PAGE) {
    let query = supabase.from("eventos").select("agente, tipo, monto").range(offset, offset + PAGE - 1);
    // desde/hasta vienen del front como instante UTC completo (ya resuelto
    // desde el dia calendario LOCAL del director, no UTC) - si llegan como
    // fecha simple "YYYY-MM-DD" (uso directo de la API, sin el front), se
    // completa con el fin del dia en UTC como venia haciendose antes.
    if (desde) query = query.gte("fecha", desde);
    if (hasta) query = query.lte("fecha", hasta.includes("T") ? hasta : `${hasta}T23:59:59.999Z`);

    const { data: page, error } = await query;
    if (error) {
      return res.status(500).json({ error: "Error leyendo los datos" });
    }
    for (const row of page ?? []) {
      if (!byAgent.has(row.agente)) {
        byAgent.set(row.agente, { leads: 0, registros: 0, ftds: 0, ventasUSD: 0 });
      }
      const agg = byAgent.get(row.agente)!;
      if (row.tipo === "lead") agg.leads++;
      else if (row.tipo === "registro") agg.registros++;
      else if (row.tipo === "ftd") agg.ftds++;
      else if (row.tipo === "venta") agg.ventasUSD += Number(row.monto ?? 0);
    }
    if (!page || page.length < PAGE) break;
  }

  // El historial reciente de conversion (registro/ftd) se calcula SIEMPRE sin
  // el filtro de fecha activo, para que la alerta de inactividad tenga
  // sentido sin importar que vista de fechas este mirando el director. Se
  // manda la lista completa de fechas (no solo la ultima) porque la alerta
  // necesita comprobar dias puntuales (hoy, ayer, hace 3 dias...) y un rango
  // personalizado, y un agente puede haber tenido actividad en varios dias a
  // la vez - quedarse solo con la mas reciente esconde las demas. Se
  // excluyen las filas "baseline-*" (el historico sembrado a mano, sin fecha
  // real) y se limita a un mes para no mandar de mas (igual no hay datos
  // reales de antes del corte).
  const unMesAtras = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const conversionesRecientes = new Map<string, { fecha: string; tipo: "registro" | "ftd" }[]>();
  for (let offset = 0; ; offset += PAGE) {
    const { data: page, error } = await supabase
      .from("eventos")
      .select("agente, fecha, tipo")
      .in("tipo", ["registro", "ftd"])
      .not("contacto_id", "like", "baseline-%")
      .gte("fecha", unMesAtras)
      .range(offset, offset + PAGE - 1);
    if (error) {
      return res.status(500).json({ error: "Error leyendo actividad reciente" });
    }
    for (const row of page ?? []) {
      if (!conversionesRecientes.has(row.agente)) conversionesRecientes.set(row.agente, []);
      conversionesRecientes.get(row.agente)!.push({ fecha: row.fecha, tipo: row.tipo as "registro" | "ftd" });
    }
    if (!page || page.length < PAGE) break;
  }

  const pct = (num: number, den: number) => (den > 0 ? Math.round((num / den) * 10000) / 100 : 0);

  const agentes = Array.from(byAgent.entries())
    .map(([agente, a]) => ({
      agente,
      leads: a.leads,
      registros: a.registros,
      ftds: a.ftds,
      ventasUSD: a.ventasUSD,
      conversionesRecientes: conversionesRecientes.get(agente) || [],
      conversion: {
        leadToRegistro: pct(a.registros, a.leads),
        registroToFtd: pct(a.ftds, a.registros),
        leadToFtd: pct(a.ftds, a.leads),
      },
    }))
    .sort((a, b) => a.agente.localeCompare(b.agente));

  const rol = (perfil as any).rol as string;
  const agenteRel = (perfil as any).agentes;
  const miNombre: string | undefined = Array.isArray(agenteRel) ? agenteRel[0]?.nombre : agenteRel?.nombre;

  const agentesFiltrados = rol === "agente" ? agentes.filter((a) => a.agente === miNombre) : agentes;

  res.setHeader("Cache-Control", "no-store");
  return res.status(200).json({
    agentes: agentesFiltrados,
    metaVentasUSD: Number(process.env.META_VENTAS_USD ?? 2400),
    actualizado: new Date().toISOString(),
    rol,
    filtro: { desde: desde || null, hasta: hasta || null },
  });
}
