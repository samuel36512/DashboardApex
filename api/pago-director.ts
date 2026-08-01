import type { VercelRequest, VercelResponse } from "@vercel/node";
import crypto from "node:crypto";
import { getSupabase } from "./_lib/supabase";
import { tasaDiariaCOP } from "./_lib/agentTier";
import { getDiasActivosPautaMes } from "./_lib/pautaEstado";
import { getAccessToken, getEmpresaOverride, requireAuth } from "./_lib/auth";

const MESES_TAB_PAGO = [
  "Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio",
  "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre",
];

function parsePrecioPago(s: string): number {
  return Number(String(s).replace(/[^0-9.-]/g, "")) || 0;
}

function b64urlPago(input: Buffer | string): string {
  return Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Copia deliberada del mismo JWT-signing que ya usa ventas-sync.ts - no se
// toca ese archivo, asi el sync real en produccion no corre ningun riesgo.
async function getGoogleAccessTokenPago(credsJson: string): Promise<string> {
  const creds = JSON.parse(credsJson);
  const now = Math.floor(Date.now() / 1000);
  const header = b64urlPago(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64urlPago(
    JSON.stringify({
      iss: creds.client_email,
      scope: "https://www.googleapis.com/auth/spreadsheets.readonly",
      aud: creds.token_uri,
      exp: now + 3600,
      iat: now,
    })
  );
  const unsigned = `${header}.${claims}`;
  const signature = crypto.sign("RSA-SHA256", Buffer.from(unsigned), creds.private_key);
  const jwt = `${unsigned}.${b64urlPago(signature)}`;

  const r = await fetch(creds.token_uri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }).toString(),
  });
  if (!r.ok) throw new Error(`No se pudo autenticar con Google (${r.status})`);
  const data: any = await r.json();
  return data.access_token;
}

// Comision de ventas 100% real, leida directo del sheet (columna J, "DIRECTOR
// > Comision"), en vez de estimarla con facturacion x tasaComisionVentas.
// Solo se usa si la empresa tiene comision_ventas_real_emails configurado
// (hoy solo APEX PRINCIPAL) - unifica en un solo total lo que corresponde a
// cualquiera de los correos dados (ej. Samuel + Santiago, con o sin nombre
// en la celda), sin importar bajo que variante de texto aparezca cada fila.
async function comisionVentasRealDesdeSheet(
  sheetId: string,
  credsJson: string,
  emailsFiltro: string[],
  desde: string
): Promise<number> {
  const token = await getGoogleAccessTokenPago(credsJson);
  const fechaRef = desde ? new Date(desde) : new Date();
  const mesIdx = Number.isNaN(fechaRef.getTime()) ? new Date().getMonth() : fechaRef.getMonth();
  const tabName = `${MESES_TAB_PAGO[mesIdx]} ventas plataforma`;
  const range = encodeURIComponent(`${tabName}!A:J`);
  const valuesRes = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${range}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!valuesRes.ok) throw new Error(`Google Sheets respondio ${valuesRes.status} pidiendo "${tabName}"`);
  const valuesData: any = await valuesRes.json();
  const filas: any[][] = valuesData.values ?? [];
  const headerIdx = filas.findIndex((f) => f[0] === "FECHA" && f[6] === "AGENTE");
  if (headerIdx === -1) throw new Error(`No encontre encabezado en "${tabName}"`);

  const emailsSet = new Set(emailsFiltro.map((e) => e.toLowerCase()));
  let total = 0;
  for (let i = headerIdx + 2; i < filas.length; i++) {
    const fila = filas[i];
    if (!fila || fila.every((c: any) => !c)) continue;
    const cliente = (fila[1] || "").toString().trim();
    const precioCrudo = (fila[4] || "").toString().trim();
    const agenteSheet = (fila[6] || "").toString().trim();
    if (!cliente || !precioCrudo || !agenteSheet) continue;
    const directorRaw = (fila[8] || "").toString().trim();
    if (!directorRaw) continue;
    const directorEmail =
      directorRaw.split("\n").map((s: string) => s.trim()).filter(Boolean).pop()?.toLowerCase() || "";
    if (!emailsSet.has(directorEmail)) continue;
    total += parsePrecioPago((fila[9] || "").toString().trim());
  }
  return Math.round(total * 100) / 100;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const supabase = getSupabase();
  const auth = await requireAuth(supabase, getAccessToken(req), { role: "director", empresaOverride: getEmpresaOverride(req) });
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
  // "Dias activos de pauta" solo existe para el mes EN CURSO - si el
  // director elige un mes cerrado (ver selector de mes en Pago de
  // directores), el gasto/costo por FTD derivado de ese modelo no aplica y
  // se deja en null en vez de mostrar un numero inventado. La comision de
  // ventas real (columna J del sheet, cuando esta configurada) no depende de
  // esto - ya usa "desde" para elegir la pestaña del mes correcto.
  const ahoraCo = new Date(Date.now() - 5 * 60 * 60 * 1000);
  const desdeDate = desde ? new Date(desde) : null;
  const esMesActual =
    !desdeDate || (desdeDate.getUTCFullYear() === ahoraCo.getUTCFullYear() && desdeDate.getUTCMonth() === ahoraCo.getUTCMonth());

  const { data: agentesRows, error: agentesError } = await supabase
    .from("agentes")
    .select("nombre, tier")
    .eq("activo", true)
    .eq("empresa_id", empresaId);
  if (agentesError) {
    return res.status(500).json({ error: "Error leyendo agentes" });
  }
  const byAgent = new Map<string, { ftds: number; ventasUSD: number; leads: number }>();
  const tierByAgente = new Map<string, "ejecutivo" | "junior" | null>();
  for (const a of agentesRows ?? []) {
    byAgent.set(a.nombre, { ftds: 0, ventasUSD: 0, leads: 0 });
    tierByAgente.set(a.nombre, (a.tier as "ejecutivo" | "junior" | null) ?? null);
  }
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
  let comisionVentasUSD = facturacionEquipoUSD * TASA_COMISION_VENTAS;
  let comisionVentasFuente: "formula" | "real" = "formula";

  const { data: empresaCfgRow } = await supabase
    .from("empresas")
    .select("ventas_sheet_id, comision_ventas_real_emails")
    .eq("id", empresaId)
    .maybeSingle();
  const emailsFiltro = (empresaCfgRow?.comision_ventas_real_emails as string[] | null) ?? null;
  if (emailsFiltro && emailsFiltro.length > 0) {
    const sheetId = empresaCfgRow?.ventas_sheet_id as string | undefined;
    const credsJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
    if (sheetId && credsJson) {
      try {
        comisionVentasUSD = await comisionVentasRealDesdeSheet(sheetId, credsJson, emailsFiltro, desde);
        comisionVentasFuente = "real";
      } catch {
        // Si falla la lectura del sheet (Google caido, pestaña del mes
        // todavia no existe, etc.) no se rompe el pago del director - se
        // sigue mostrando la formula de siempre como respaldo silencioso.
      }
    }
  }

  const tasaPorFtd = teamFtds >= UMBRAL_FTD ? TASA_ALTA : TASA_BASE;
  const bonoFtdUSD = teamFtds * tasaPorFtd;
  const totalUSD = comisionVentasUSD + bonoFtdUSD;

  // Costo por FTD REAL (mismo modelo que /metrics, "Costo por FTD"): el gasto
  // de pauta de cada agente clasificado (tarifa diaria x dias activos) se
  // suma para tener el gasto real de la oficina, se divide entre el total de
  // leads del mes para el costo por lead, y ESE costo por lead x los leads
  // propios de cada agente da su gasto real - dividido entre sus FTD, el
  // costo por FTD real. Cuando desde/hasta son del mes en curso, a.ftds/a.leads
  // ya son los conteos reales del mes - para un mes cerrado (esMesActual
  // false) este modelo no aplica (ver arriba) y gastoPautaCOP queda null.
  const diasActivosPauta = esMesActual ? (await getDiasActivosPautaMes(supabase, empresaId)).diasActivos : 0;
  const tasasPauta = {
    ejecutivoCOP: auth.ctx.empresa.tasaPautaEjecutivoCOP,
    juniorCOP: auth.ctx.empresa.tasaPautaJuniorCOP,
  };
  const agentesBase = Array.from(byAgent.entries()).map(([agente, a]) => {
    const tasaDiaria = tasaDiariaCOP(tierByAgente.get(agente) ?? null, tasasPauta);
    const gastoPautaCOP = tasaDiaria !== null && esMesActual ? Math.round(tasaDiaria * diasActivosPauta) : null;
    return { agente, ftds: a.ftds, ventasUSD: a.ventasUSD, leads: a.leads, gastoPautaCOP };
  });
  const totalInvertidoCOP = agentesBase.reduce((acc, a) => acc + (a.gastoPautaCOP || 0), 0);
  const totalLeadsMes = agentesBase.reduce((acc, a) => acc + (a.leads || 0), 0);
  const costoPorLeadCOP =
    auth.ctx.empresa.costoPorLeadFijoCOP ?? (esMesActual && totalLeadsMes > 0 ? totalInvertidoCOP / totalLeadsMes : null);

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
    comisionVentasFuente,
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
    mesEsActual: esMesActual,
    actualizado: new Date().toISOString(),
    filtro: { desde: desde || null, hasta: hasta || null },
  });
}
