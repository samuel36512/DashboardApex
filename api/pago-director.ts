import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getSupabase } from "./_lib/supabase";

// Tasa por FTD del equipo que gana el director, y el umbral (FTD del mes)
// a partir del cual sube de $3 a $4 por FTD. Configurables por si cambian.
const TASA_BASE = Number(process.env.COMISION_DIRECTOR_BASE_USD ?? 3);
const TASA_ALTA = Number(process.env.COMISION_DIRECTOR_ALTA_USD ?? 4);
const UMBRAL_FTD = Number(process.env.UMBRAL_FTD_TASA_ALTA ?? 1000);
// El director gana este porcentaje de TODA la facturacion del equipo
// (suma de ventas de todos los agentes), sin importar quien la cerro.
const TASA_COMISION_VENTAS = Number(process.env.TASA_COMISION_DIRECTOR_VENTAS ?? 0.15);

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
    .select("rol")
    .eq("id", userData.user.id)
    .maybeSingle();
  if (perfilError || !perfil) {
    return res.status(403).json({ error: "Tu cuenta no tiene un perfil asignado" });
  }
  const rol = (perfil as any).rol as string;
  if (rol !== "director") {
    return res.status(403).json({ error: "Esta informacion es solo para el director" });
  }

  const desde = typeof req.query.desde === "string" ? req.query.desde : "";
  const hasta = typeof req.query.hasta === "string" ? req.query.hasta : "";
  if ((desde && Number.isNaN(Date.parse(desde))) || (hasta && Number.isNaN(Date.parse(hasta)))) {
    return res.status(400).json({ error: "desde/hasta deben ser fechas validas" });
  }

  const { data: agentesRows, error: agentesError } = await supabase
    .from("agentes")
    .select("nombre")
    .eq("activo", true);
  if (agentesError) {
    return res.status(500).json({ error: "Error leyendo agentes" });
  }
  const byAgent = new Map<string, { ftds: number; ventasUSD: number }>();
  for (const a of agentesRows ?? []) byAgent.set(a.nombre, { ftds: 0, ventasUSD: 0 });

  // FTD y facturacion del equipo en el rango, desglosados por agente en una
  // sola pasada. FTD incluye TODO (tambien el historico sembrado a mano)
  // porque esto es un total real del mes, no un listado contacto por
  // contacto como en "Registros y FTD".
  const PAGE = 1000;
  for (let offset = 0; ; offset += PAGE) {
    let query = supabase
      .from("eventos")
      .select("agente, tipo, monto")
      .in("tipo", ["ftd", "venta"])
      .range(offset, offset + PAGE - 1);
    if (desde) query = query.gte("fecha", desde);
    if (hasta) query = query.lte("fecha", hasta.includes("T") ? hasta : `${hasta}T23:59:59.999Z`);
    const { data: page, error } = await query;
    if (error) {
      return res.status(500).json({ error: "Error leyendo la actividad del equipo" });
    }
    for (const row of page ?? []) {
      if (!byAgent.has(row.agente)) byAgent.set(row.agente, { ftds: 0, ventasUSD: 0 });
      const agg = byAgent.get(row.agente)!;
      if (row.tipo === "ftd") agg.ftds++;
      else if (row.tipo === "venta") agg.ventasUSD += Number(row.monto ?? 0);
    }
    if (!page || page.length < PAGE) break;
  }

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

  const agentesArr = Array.from(byAgent.entries()).map(([agente, a]) => ({
    agente,
    ftds: a.ftds,
    ventasUSD: a.ventasUSD,
  }));
  const estrellaFtd = agentesArr.slice().sort((a, b) => b.ftds - a.ftds)[0] ?? null;
  const estrellaVentas = agentesArr.slice().sort((a, b) => b.ventasUSD - a.ventasUSD)[0] ?? null;
  const necesitaAtencion =
    agentesArr
      .slice()
      .sort((a, b) => a.ftds - b.ftds || a.ventasUSD - b.ventasUSD)[0] ?? null;

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
    estrellaFtd,
    estrellaVentas,
    necesitaAtencion,
    actualizado: new Date().toISOString(),
    filtro: { desde: desde || null, hasta: hasta || null },
  });
}
