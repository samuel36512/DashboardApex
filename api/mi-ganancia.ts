import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getSupabase } from "./_lib/supabase";

// Mismo estimado por FTD que se usa en "Ranking mejores pagos" para que
// los dos numeros del agente coincidan.
const COMISION_POR_FTD = Number(process.env.COMISION_POR_FTD_USD ?? 8);

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
  if (!miNombre) {
    return res.status(403).json({ error: "Tu cuenta no tiene un agente asociado" });
  }

  const desde = typeof req.query.desde === "string" ? req.query.desde : "";
  const hasta = typeof req.query.hasta === "string" ? req.query.hasta : "";
  if ((desde && Number.isNaN(Date.parse(desde))) || (hasta && Number.isNaN(Date.parse(hasta)))) {
    return res.status(400).json({ error: "desde/hasta deben ser fechas validas" });
  }

  let ftds = 0;
  let ventasUSD = 0;
  let comisionUSD = 0;
  const byProducto = new Map<string, { cantidad: number; ventasUSD: number }>();

  // FTD incluye el historico sembrado a mano (ya viene atribuido a este
  // agente puntual), porque es un total real del mes, no un listado
  // contacto por contacto.
  const PAGE = 1000;
  for (let offset = 0; ; offset += PAGE) {
    let query = supabase
      .from("eventos")
      .select("tipo, monto, comision, producto")
      .eq("agente", miNombre)
      .in("tipo", ["ftd", "venta"])
      .range(offset, offset + PAGE - 1);
    if (desde) query = query.gte("fecha", desde);
    if (hasta) query = query.lte("fecha", hasta.includes("T") ? hasta : `${hasta}T23:59:59.999Z`);
    const { data: page, error } = await query;
    if (error) {
      return res.status(500).json({ error: "Error leyendo tu actividad" });
    }
    for (const row of page ?? []) {
      if (row.tipo === "ftd") {
        ftds++;
      } else if (row.tipo === "venta") {
        ventasUSD += Number(row.monto ?? 0);
        comisionUSD += Number(row.comision ?? 0);
        const producto = row.producto || "Sin especificar";
        if (!byProducto.has(producto)) byProducto.set(producto, { cantidad: 0, ventasUSD: 0 });
        const agg = byProducto.get(producto)!;
        agg.cantidad++;
        agg.ventasUSD += Number(row.monto ?? 0);
      }
    }
    if (!page || page.length < PAGE) break;
  }

  const bonoFtdUSD = ftds * COMISION_POR_FTD;
  const totalUSD = comisionUSD + bonoFtdUSD;

  const productos = Array.from(byProducto.entries())
    .map(([producto, p]) => ({ producto, cantidad: p.cantidad, ventasUSD: p.ventasUSD }))
    .sort((a, b) => b.cantidad - a.cantidad);

  res.setHeader("Cache-Control", "no-store");
  return res.status(200).json({
    rol,
    agente: miNombre,
    ftds,
    ventasUSD,
    comisionUSD,
    comisionPorFtd: COMISION_POR_FTD,
    bonoFtdUSD,
    totalUSD,
    productos,
    actualizado: new Date().toISOString(),
    filtro: { desde: desde || null, hasta: hasta || null },
  });
}
