import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getSupabase } from "./_lib/supabase";
import { tasaDiariaCOP } from "./_lib/agentTier";
import { getDiasActivosPautaMes } from "./_lib/pautaEstado";
import { getAccessToken, requireAuth } from "./_lib/auth";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const supabase = getSupabase();
  const auth = await requireAuth(supabase, getAccessToken(req), { role: "director" });
  if (!auth.ok) {
    return res.status(auth.status).json({ error: auth.error });
  }
  const { empresaId, rol } = auth.ctx;
  // Tasa por FTD del equipo que gana el director, y el umbral (FTD del mes)
  // a partir del cual sube de $3 a $4 por FTD - configurables por empresa.
  const TASA_BASE = auth.ctx.empresa.comisionDirectorBaseUSD;
  const TASA_ALTA = auth.ctx.empresa.comisionDirectorAltaUSD;
  const UMBRAL_FTD = auth.ctx.empresa.umbralFtdTasaAlta;
  // El director gana este porcentaje de TODA la facturacion del equipo
  // (suma de ventas de todos los agentes), sin importar quien la cerro.
  const TASA_COMISION_VENTAS = auth.ctx.empresa.tasaComisionDirectorVentas;

  const desde = typeof req.query.desde === "string" ? req.query.desde : "";
  const hasta = typeof req.query.hasta === "string" ? req.query.hasta : "";
  if ((desde && Number.isNaN(Date.parse(desde))) || (hasta && Number.isNaN(Date.parse(hasta)))) {
    return res.status(400).json({ error: "desde/hasta deben ser fechas validas" });
  }

  const { data: agentesRows, error: agentesError } = await supabase
    .from("agentes")
    .select("nombre")
    .eq("activo", true)
    .eq("empresa_id", empresaId);
  if (agentesError) {
    return res.status(500).json({ error: "Error leyendo agentes" });
  }
  const byAgent = new Map<string, { ftds: number; ventasUSD: number; leads: number }>();
  for (const a of agentesRows ?? []) byAgent.set(a.nombre, { ftds: 0, ventasUSD: 0, leads: 0 });
  const byProducto = new Map<string, { cantidad: number; ventasUSD: number }>();

  // FTD, leads y facturacion del equipo en el rango, desglosados por agente y
  // por producto en una sola pasada. FTD incluye TODO (tambien el historico
  // sembrado a mano) porque esto es un total real del mes, no un listado
  // contacto por contacto como en "Registros y FTD". Los leads se necesitan
  // para el costo por FTD real (ver mas abajo, mismo modelo que en /metrics).
  const PAGE = 1000;
  for (let offset = 0; ; offset += PAGE) {
    let query = supabase
      .from("eventos")
      .select("agente, tipo, monto, producto")
      .in("tipo", ["ftd", "venta", "lead"])
      .eq("empresa_id", empresaId)
      .range(offset, offset + PAGE - 1);
    if (desde) query = query.gte("fecha", desde);
    if (hasta) query = query.lte("fecha", hasta.includes("T") ? hasta : `${hasta}T23:59:59.999Z`);
    const { data: page, error } = await query;
    if (error) {
      return res.status(500).json({ error: "Error leyendo la actividad del equipo" });
    }
    for (const row of page ?? []) {
      if (!byAgent.has(row.agente)) byAgent.set(row.agente, { ftds: 0, ventasUSD: 0, leads: 0 });
      const agg = byAgent.get(row.agente)!;
      if (row.tipo === "ftd") agg.ftds++;
      else if (row.tipo === "lead") agg.leads++;
      else if (row.tipo === "venta") {
        agg.ventasUSD += Number(row.monto ?? 0);
        const producto = row.producto || "Sin especificar";
        if (!byProducto.has(producto)) byProducto.set(producto, { cantidad: 0, ventasUSD: 0 });
        const prodAgg = byProducto.get(producto)!;
        prodAgg.cantidad++;
        prodAgg.ventasUSD += Number(row.monto ?? 0);
      }
    }
    if (!page || page.length < PAGE) break;
  }

  const productos = Array.from(byProducto.entries())
    .map(([producto, p]) => ({ producto, cantidad: p.cantidad, ventasUSD: p.ventasUSD }))
    .sort((a, b) => b.cantidad - a.cantidad);

  let facturacionEquipoUSD = 0;
  let teamFtds = 0;
  for (const a of byAgent.values()) {
    facturacionEquipoUSD += a.ventasUSD;
    teamFtds += a.ftds;
  }
  const comisionVentasUSD = facturacionEquipoUSD * TASA_COMISION_VENTAS;

  const tasaPorFtd = teamFtds >= UMBRAL_FTD ? TASA_ALTA : TASA_BASE;
  const bonoFtdUSD = teamFtds * tasaPorFtd;
  const totalUSD = comisionVentasUSD + bonoFtdUSD;

  // Costo por FTD REAL (mismo modelo que /metrics, "Costo por FTD"): el gasto
  // de pauta de cada agente clasificado (tarifa diaria x dias activos) se
  // suma para tener el gasto real de la oficina, se divide entre el total de
  // leads del mes para el costo por lead, y ESE costo por lead x los leads
  // propios de cada agente da su gasto real - dividido entre sus FTD, el
  // costo por FTD real. Como desde/hasta ya vienen fijados al mes en curso
  // para esta vista, a.ftds/a.leads ya son los conteos reales del mes.
  const { diasActivos: diasActivosPauta } = await getDiasActivosPautaMes(supabase, empresaId);
  const agentesBase = Array.from(byAgent.entries()).map(([agente, a]) => {
    const tasaDiaria = tasaDiariaCOP(agente);
    const gastoPautaCOP = tasaDiaria !== null ? Math.round(tasaDiaria * diasActivosPauta) : null;
    return { agente, ftds: a.ftds, ventasUSD: a.ventasUSD, leads: a.leads, gastoPautaCOP };
  });
  const totalInvertidoCOP = agentesBase.reduce((acc, a) => acc + (a.gastoPautaCOP || 0), 0);
  const totalLeadsMes = agentesBase.reduce((acc, a) => acc + (a.leads || 0), 0);
  const costoPorLeadCOP = totalLeadsMes > 0 ? totalInvertidoCOP / totalLeadsMes : null;

  const agentesArr = agentesBase.map((a) => {
    const gastoRealCOP = costoPorLeadCOP !== null ? Math.round(costoPorLeadCOP * a.leads) : null;
    const costoPorFtdCOP = gastoRealCOP !== null && a.ftds > 0 ? Math.round(gastoRealCOP / a.ftds) : null;
    return { agente: a.agente, ftds: a.ftds, ventasUSD: a.ventasUSD, costoPorFtdCOP };
  });
  const estrellaFtd = agentesArr.slice().sort((a, b) => b.ftds - a.ftds)[0] ?? null;
  const estrellaVentas = agentesArr.slice().sort((a, b) => b.ventasUSD - a.ventasUSD)[0] ?? null;
  const necesitaAtencion =
    agentesArr
      .slice()
      .sort((a, b) => a.ftds - b.ftds || a.ventasUSD - b.ventasUSD)[0] ?? null;
  const conCosto = agentesArr.filter((a) => a.costoPorFtdCOP !== null);
  const estrellaCosto = conCosto.slice().sort((a, b) => (a.costoPorFtdCOP as number) - (b.costoPorFtdCOP as number))[0] ?? null;

  res.setHeader("Cache-Control", "no-store");
  return res.status(200).json({
    rol,
    facturacionEquipoUSD,
    tasaComisionVentas: TASA_COMISION_VENTAS,
    comisionVentasUSD,
    teamFtds,
    tasaBase: TASA_BASE,
    tasaAlta: TASA_ALTA,
    tasaPorFtd,
    umbralFtd: UMBRAL_FTD,
    bonoFtdUSD,
    totalUSD,
    agentes: agentesArr,
    productos,
    estrellaFtd,
    estrellaVentas,
    estrellaCosto,
    necesitaAtencion,
    actualizado: new Date().toISOString(),
    filtro: { desde: desde || null, hasta: hasta || null },
  });
}
