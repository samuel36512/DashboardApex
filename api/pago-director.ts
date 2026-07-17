import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getSupabase } from "./_lib/supabase";

// Tasa por FTD del equipo que gana el director, y el umbral (FTD del mes)
// a partir del cual sube de $3 a $4 por FTD. Configurables por si cambian.
const TASA_BASE = Number(process.env.COMISION_DIRECTOR_BASE_USD ?? 3);
const TASA_ALTA = Number(process.env.COMISION_DIRECTOR_ALTA_USD ?? 4);
const UMBRAL_FTD = Number(process.env.UMBRAL_FTD_TASA_ALTA ?? 1000);

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

  // La comision de venta del director se acumula del lado del sync de
  // ventas (ventas-sync.ts), sumada mes a mes en sync_state - ahi ya se
  // filtro solo por las filas donde la columna DIRECTOR del sheet coincide
  // con el director configurado.
  const ahora = new Date();
  const mesKey = `${ahora.getFullYear()}-${String(ahora.getMonth() + 1).padStart(2, "0")}`;
  const { data: comisionRow, error: comisionError } = await supabase
    .from("sync_state")
    .select("value")
    .eq("key", `comision_director_${mesKey}`)
    .maybeSingle();
  if (comisionError) {
    return res.status(500).json({ error: "Error leyendo comision de ventas" });
  }
  const comisionVentasUSD = Number((comisionRow?.value as any)?.total ?? 0);

  let ftdQuery = supabase
    .from("eventos")
    .select("*", { count: "exact", head: true })
    .eq("tipo", "ftd")
    .not("contacto_id", "like", "baseline-%");
  if (desde) ftdQuery = ftdQuery.gte("fecha", desde);
  if (hasta) ftdQuery = ftdQuery.lte("fecha", hasta.includes("T") ? hasta : `${hasta}T23:59:59.999Z`);
  const { count, error: ftdError } = await ftdQuery;
  if (ftdError) {
    return res.status(500).json({ error: "Error leyendo FTD del equipo" });
  }
  const teamFtds = count ?? 0;

  const tasaPorFtd = teamFtds >= UMBRAL_FTD ? TASA_ALTA : TASA_BASE;
  const bonoFtdUSD = teamFtds * tasaPorFtd;
  const totalUSD = comisionVentasUSD + bonoFtdUSD;

  res.setHeader("Cache-Control", "no-store");
  return res.status(200).json({
    rol,
    comisionVentasUSD,
    teamFtds,
    tasaBase: TASA_BASE,
    tasaAlta: TASA_ALTA,
    tasaPorFtd,
    umbralFtd: UMBRAL_FTD,
    bonoFtdUSD,
    totalUSD,
    actualizado: new Date().toISOString(),
    filtro: { desde: desde || null, hasta: hasta || null },
  });
}
