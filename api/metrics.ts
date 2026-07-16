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

  // Supabase/PostgREST limita cada consulta a un maximo de filas (tipicamente
  // 1000), asi que con una tabla grande hay que paginar explicitamente para
  // traer todo, si no los conteos quedan cortados.
  const PAGE = 1000;
  const allRows: { agente: string; tipo: string; monto: number | null }[] = [];
  for (let offset = 0; ; offset += PAGE) {
    let query = supabase.from("eventos").select("agente, tipo, monto").range(offset, offset + PAGE - 1);
    if (desde) query = query.gte("fecha", desde);
    if (hasta) query = query.lte("fecha", `${hasta}T23:59:59.999Z`);

    const { data: page, error } = await query;
    if (error) {
      return res.status(500).json({ error: "Error leyendo los datos" });
    }
    allRows.push(...(page ?? []));
    if (!page || page.length < PAGE) break;
  }

  const byAgent = new Map<string, AgentAgg>();
  for (const row of allRows) {
    if (!byAgent.has(row.agente)) {
      byAgent.set(row.agente, { leads: 0, registros: 0, ftds: 0, ventasUSD: 0 });
    }
    const agg = byAgent.get(row.agente)!;
    if (row.tipo === "lead") agg.leads++;
    else if (row.tipo === "registro") agg.registros++;
    else if (row.tipo === "ftd") agg.ftds++;
    else if (row.tipo === "venta") agg.ventasUSD += Number(row.monto ?? 0);
  }

  const pct = (num: number, den: number) => (den > 0 ? Math.round((num / den) * 10000) / 100 : 0);

  const agentes = Array.from(byAgent.entries())
    .map(([agente, a]) => ({
      agente,
      leads: a.leads,
      registros: a.registros,
      ftds: a.ftds,
      ventasUSD: a.ventasUSD,
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
