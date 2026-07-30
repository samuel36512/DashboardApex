import type { VercelRequest, VercelResponse } from "@vercel/node";
import crypto from "node:crypto";
import { getSupabase } from "./_lib/supabase";
import { tasaDiariaCOP } from "./_lib/agentTier";
import { getDiasActivosPautaMes } from "./_lib/pautaEstado";
import { getAccessToken, getEmpresaOverride, requireDirector } from "./_lib/auth";

const MESES_TAB_TEST = [
  "Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio",
  "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre",
];

function parsePrecioTest(s: string): number {
  return Number(String(s).replace(/[^0-9.-]/g, "")) || 0;
}

function b64urlTest(input: Buffer | string): string {
  return Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Copia deliberada del mismo JWT-signing que ya usa ventas-sync.ts (no se
// toca ese archivo para este endpoint de solo-lectura/prueba, asi el sync
// real en produccion no corre ningun riesgo).
async function getGoogleAccessTokenTest(credsJson: string): Promise<string> {
  const creds = JSON.parse(credsJson);
  const now = Math.floor(Date.now() / 1000);
  const header = b64urlTest(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64urlTest(
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
  const jwt = `${unsigned}.${b64urlTest(signature)}`;

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

// Los endpoints de /api/admin/* se consolidaron en un solo archivo (con un
// dispatcher por ?accion=) porque el plan gratuito de Vercel tiene un
// limite de 12 Serverless Functions por deployment - separados, sumaban
// mas que eso y los builds empezaron a fallar en silencio (Vercel seguia
// sirviendo el ultimo deploy bueno, asi que ningun fix nuevo se notaba).

async function handleAgentes(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  const supabase = getSupabase();
  const auth = await requireDirector(supabase, getAccessToken(req), { empresaOverride: getEmpresaOverride(req) });
  if (!auth.ok) {
    return res.status(auth.status).json({ error: auth.error });
  }
  const { empresaId } = auth.ctx;

  const { data: agentesRows, error: agentesError } = await supabase
    .from("agentes")
    .select("id, nombre, email_personal")
    .eq("activo", true)
    .eq("empresa_id", empresaId)
    .order("nombre");
  if (agentesError) {
    return res.status(500).json({ error: "No se pudo leer agentes" });
  }

  const { data: perfilesRows, error: perfilesError } = await supabase
    .from("perfiles")
    .select("agente_id, email")
    .eq("rol", "agente")
    .eq("empresa_id", empresaId);
  if (perfilesError) {
    return res.status(500).json({ error: "No se pudo leer perfiles" });
  }

  const emailByAgenteId = new Map<number, string>(
    (perfilesRows ?? [])
      .filter((p) => p.agente_id !== null)
      .map((p) => [p.agente_id as number, p.email as string])
  );

  const agentes = (agentesRows ?? []).map((a) => ({
    id: a.id,
    nombre: a.nombre,
    tieneAcceso: emailByAgenteId.has(a.id),
    email: emailByAgenteId.get(a.id) ?? null,
    emailPersonal: a.email_personal ?? null,
  }));

  return res.status(200).json({ agentes });
}

const TIPOS_VALIDOS_AJUSTE = ["lead", "registro", "ftd"] as const;
const MODOS_VALIDOS_AJUSTE = ["sumar", "restar"] as const;
const CANTIDAD_MAXIMA_AJUSTE = 200;

// Fecha en Colombia (UTC-5): si el director elige un dia puntual se usa la
// medianoche de ese dia en Colombia (mismo criterio que el historico
// sembrado a mano), y si no elige nada se usa el instante actual.
function fechaColombia(fechaStr: string): string | null {
  const m = fechaStr.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const [, anio, mes, dia] = m;
  return new Date(Date.UTC(Number(anio), Number(mes) - 1, Number(dia), 5, 0, 0)).toISOString();
}

async function handleAjusteManual(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  const supabase = getSupabase();
  const auth = await requireDirector(supabase, getAccessToken(req), { empresaOverride: getEmpresaOverride(req) });
  if (!auth.ok) {
    return res.status(auth.status).json({ error: auth.error });
  }
  const { empresaId } = auth.ctx;

  const body = (req.body ?? {}) as Record<string, unknown>;
  const agenteId = Number(body.agenteId);
  const tipo = typeof body.tipo === "string" ? body.tipo : "";
  const modo = typeof body.modo === "string" && body.modo ? body.modo : "sumar";
  const cantidad = Math.trunc(Number(body.cantidad));
  const fechaInput = typeof body.fecha === "string" ? body.fecha.trim() : "";

  if (!agenteId) {
    return res.status(400).json({ error: "Falta el agente" });
  }
  if (!TIPOS_VALIDOS_AJUSTE.includes(tipo as (typeof TIPOS_VALIDOS_AJUSTE)[number])) {
    return res.status(400).json({ error: "Tipo invalido - debe ser lead, registro o ftd" });
  }
  if (!MODOS_VALIDOS_AJUSTE.includes(modo as (typeof MODOS_VALIDOS_AJUSTE)[number])) {
    return res.status(400).json({ error: "Modo invalido - debe ser sumar o restar" });
  }
  if (!Number.isFinite(cantidad) || cantidad < 1 || cantidad > CANTIDAD_MAXIMA_AJUSTE) {
    return res.status(400).json({ error: `La cantidad debe ser un numero entre 1 y ${CANTIDAD_MAXIMA_AJUSTE}` });
  }

  let fecha: string;
  if (fechaInput) {
    const fechaResuelta = fechaColombia(fechaInput);
    if (!fechaResuelta) {
      return res.status(400).json({ error: "Fecha invalida - usa el formato AAAA-MM-DD" });
    }
    fecha = fechaResuelta;
  } else {
    fecha = new Date().toISOString();
  }

  const { data: agente, error: agenteError } = await supabase
    .from("agentes")
    .select("id, nombre")
    .eq("id", agenteId)
    .eq("activo", true)
    .eq("empresa_id", empresaId)
    .maybeSingle();
  if (agenteError || !agente) {
    return res.status(400).json({ error: "Agente no encontrado" });
  }

  if (modo === "restar") {
    // Solo se puede restar de lo que se sumo con este mismo boton (prefijo
    // "ajuste-") - nunca de actividad real sincronizada desde GHL, para no
    // arriesgar borrar historial real por error. Se quitan las mas
    // recientes primero (lo mas probable que sea el ajuste equivocado).
    const { data: candidatos, error: candidatosError } = await supabase
      .from("eventos")
      .select("id")
      .eq("agente", agente.nombre)
      .eq("tipo", tipo)
      .eq("empresa_id", empresaId)
      .like("contacto_id", "ajuste-%")
      .order("creado_en", { ascending: false })
      .limit(cantidad);
    if (candidatosError) {
      return res.status(500).json({ error: "Error buscando ajustes para restar: " + candidatosError.message });
    }
    const ids = (candidatos ?? []).map((c) => c.id);
    if (ids.length === 0) {
      return res.status(400).json({
        error: `No hay ajustes manuales de ${tipo} para ${agente.nombre} que se puedan restar`,
      });
    }
    const { error: deleteError } = await supabase.from("eventos").delete().in("id", ids);
    if (deleteError) {
      return res.status(500).json({ error: "Error restando el ajuste: " + deleteError.message });
    }
    return res.status(200).json({
      ok: true,
      agente: agente.nombre,
      tipo,
      modo,
      cantidadPedida: cantidad,
      cantidadRestada: ids.length,
      incompleto: ids.length < cantidad,
    });
  }

  // contacto_id con prefijo "ajuste-" para poder distinguir estos registros
  // de los que llegan realmente sincronizados desde GHL, en caso de que
  // despues haga falta auditar o revertir un ajuste puntual.
  const filas = Array.from({ length: cantidad }, () => ({
    contacto_id: `ajuste-${crypto.randomUUID()}`,
    agente: agente.nombre,
    tipo,
    fecha,
    empresa_id: empresaId,
  }));

  const { error: insertError } = await supabase.from("eventos").upsert(filas, { onConflict: "empresa_id,contacto_id,tipo" });
  if (insertError) {
    return res.status(500).json({ error: "Error guardando el ajuste: " + insertError.message });
  }

  return res.status(201).json({ ok: true, agente: agente.nombre, tipo, modo, cantidad, fecha });
}

function randomPassword(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  const bytes = crypto.randomBytes(14);
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += chars[bytes[i] % chars.length];
  return out;
}

async function handleCrearLoginAgente(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  const supabase = getSupabase();
  const auth = await requireDirector(supabase, getAccessToken(req), { empresaOverride: getEmpresaOverride(req) });
  if (!auth.ok) {
    return res.status(auth.status).json({ error: auth.error });
  }
  const { empresaId } = auth.ctx;

  const body = (req.body ?? {}) as Record<string, unknown>;
  const agenteId = Number(body.agenteId);
  const email = typeof body.email === "string" ? body.email.trim() : "";
  if (!agenteId || !email) {
    return res.status(400).json({ error: "Faltan agenteId o email" });
  }

  const { data: agente, error: agenteError } = await supabase
    .from("agentes")
    .select("id, nombre")
    .eq("id", agenteId)
    .eq("empresa_id", empresaId)
    .maybeSingle();
  if (agenteError || !agente) {
    return res.status(400).json({ error: "Agente no encontrado" });
  }

  const { data: existente } = await supabase
    .from("perfiles")
    .select("id")
    .eq("agente_id", agenteId)
    .maybeSingle();
  if (existente) {
    return res.status(409).json({ error: "Este agente ya tiene un acceso creado" });
  }

  const password = randomPassword();
  const { data: created, error: createError } = await supabase.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (createError || !created?.user) {
    return res.status(400).json({ error: createError?.message || "No se pudo crear el usuario" });
  }

  const { error: perfilError } = await supabase.from("perfiles").insert({
    id: created.user.id,
    rol: "agente",
    agente_id: agente.id,
    email,
    empresa_id: empresaId,
  });
  if (perfilError) {
    return res.status(500).json({
      error: "El usuario se creo pero no se pudo vincular el perfil: " + perfilError.message,
    });
  }

  return res.status(201).json({ ok: true, email, password, agente: agente.nombre });
}

// Editar abonos: a diferencia del ajuste manual (que suma/resta de a poco),
// acá el director manda el total correcto y ese valor REEMPLAZA por completo
// lo que había antes - no se acumula. Pensado para reflejar el estado real
// de abonos pendientes de cobro (ej. un cliente termina de pagar y el total
// baja), no un historial de movimientos.
async function handleAbonos(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  const supabase = getSupabase();
  const auth = await requireDirector(supabase, getAccessToken(req), { empresaOverride: getEmpresaOverride(req) });
  if (!auth.ok) {
    return res.status(auth.status).json({ error: auth.error });
  }
  const { empresaId } = auth.ctx;

  const body = (req.body ?? {}) as Record<string, unknown>;
  const montoUSD = Number(body.montoUSD);
  const cantidad = Math.trunc(Number(body.cantidad));

  if (!Number.isFinite(montoUSD) || montoUSD < 0) {
    return res.status(400).json({ error: "El monto debe ser un número mayor o igual a 0" });
  }
  if (!Number.isFinite(cantidad) || cantidad < 0) {
    return res.status(400).json({ error: "La cantidad de abonos debe ser un número mayor o igual a 0" });
  }

  const actualizadoEn = new Date().toISOString();
  const { error: updateError } = await supabase
    .from("empresas")
    .update({ abonos_monto_usd: montoUSD, abonos_cantidad: cantidad, abonos_actualizado_en: actualizadoEn })
    .eq("id", empresaId);
  if (updateError) {
    return res.status(500).json({ error: "Error guardando los abonos: " + updateError.message });
  }

  return res.status(200).json({ ok: true, montoUSD, cantidad, actualizadoEn });
}

// SOLO LECTURA - no guarda nada, no toca eventos ni empresas. Compara, fila
// por fila del sheet de ventas del mes en curso, la comision real de cada
// director (columna J, "DIRECTOR > Comision") contra lo que da la formula
// actual (facturacion del director x tasaComisionDirectorVentas, hoy 15%
// fijo para todos). Sirve para decidir si conviene reemplazar esa formula
// por el dato real de la hoja - no cambia nada hasta que se decida a mano.
async function handleTestComisionDirector(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  const supabase = getSupabase();
  const auth = await requireDirector(supabase, getAccessToken(req), { empresaOverride: getEmpresaOverride(req) });
  if (!auth.ok) {
    return res.status(auth.status).json({ error: auth.error });
  }
  const { empresaId } = auth.ctx;
  const tasaComisionVentas = auth.ctx.empresa.tasaComisionDirectorVentas;

  const { data: empresaRow, error: empresaError } = await supabase
    .from("empresas")
    .select("ventas_sheet_id")
    .eq("id", empresaId)
    .maybeSingle();
  if (empresaError || !empresaRow?.ventas_sheet_id) {
    return res.status(500).json({ error: "Esta empresa no tiene ventas_sheet_id configurado" });
  }
  const sheetId = empresaRow.ventas_sheet_id as string;

  const credsJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!credsJson) {
    return res.status(500).json({ error: "Falta GOOGLE_SERVICE_ACCOUNT_JSON en Vercel" });
  }

  try {
    const token = await getGoogleAccessTokenTest(credsJson);
    const mesParam = typeof req.query.mes === "string" ? req.query.mes.trim() : "";
    const ahora = new Date();
    const tabName = mesParam ? `${mesParam} ventas plataforma` : `${MESES_TAB_TEST[ahora.getMonth()]} ventas plataforma`;

    const range = encodeURIComponent(`${tabName}!A:J`);
    const valuesRes = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${range}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!valuesRes.ok) {
      const body = await valuesRes.text();
      return res.status(502).json({ error: `Google Sheets respondio ${valuesRes.status} pidiendo "${tabName}": ${body.slice(0, 300)}` });
    }
    const valuesData: any = await valuesRes.json();
    const filas: any[][] = valuesData.values ?? [];

    const headerIdx = filas.findIndex((f) => f[0] === "FECHA" && f[6] === "AGENTE");
    if (headerIdx === -1) {
      return res.status(502).json({ error: `No encontre la fila de encabezado en la pestaña "${tabName}"` });
    }

    const porDirector = new Map<string, { filas: number; facturacionUSD: number; comisionRealColumnaJUSD: number }>();
    for (let i = headerIdx + 2; i < filas.length; i++) {
      const fila = filas[i];
      if (!fila || fila.every((c) => !c)) continue;
      const cliente = (fila[1] || "").toString().trim();
      const precioCrudo = (fila[4] || "").toString().trim();
      const agenteSheet = (fila[6] || "").toString().trim();
      if (!cliente || !precioCrudo || !agenteSheet) continue;

      const directorRaw = (fila[8] || "").toString().trim();
      if (!directorRaw) continue;

      const monto = parsePrecioTest(precioCrudo);
      const comisionJ = parsePrecioTest((fila[9] || "").toString().trim());

      if (!porDirector.has(directorRaw)) porDirector.set(directorRaw, { filas: 0, facturacionUSD: 0, comisionRealColumnaJUSD: 0 });
      const agg = porDirector.get(directorRaw)!;
      agg.filas++;
      agg.facturacionUSD += monto;
      agg.comisionRealColumnaJUSD += comisionJ;
    }

    const porDirectorArr = Array.from(porDirector.entries()).map(([directorRaw, a]) => ({
      directorRaw,
      filas: a.filas,
      facturacionUSD: Math.round(a.facturacionUSD * 100) / 100,
      comisionActual15pctUSD: Math.round(a.facturacionUSD * tasaComisionVentas * 100) / 100,
      comisionRealColumnaJUSD: Math.round(a.comisionRealColumnaJUSD * 100) / 100,
    }));

    const totales = porDirectorArr.reduce(
      (acc, d) => {
        acc.facturacionUSD += d.facturacionUSD;
        acc.comisionActual15pctUSD += d.comisionActual15pctUSD;
        acc.comisionRealColumnaJUSD += d.comisionRealColumnaJUSD;
        return acc;
      },
      { facturacionUSD: 0, comisionActual15pctUSD: 0, comisionRealColumnaJUSD: 0 }
    );

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({
      ok: true,
      pestana: tabName,
      tasaComisionVentasActual: tasaComisionVentas,
      porDirector: porDirectorArr,
      totales,
    });
  } catch (err: any) {
    return res.status(502).json({ error: err?.message || "Error leyendo el sheet" });
  }
}

async function requireSuperadmin(
  req: VercelRequest,
  res: VercelResponse,
  supabase: ReturnType<typeof getSupabase>
): Promise<boolean> {
  const { data: userData, error: userError } = await supabase.auth.getUser(getAccessToken(req));
  if (userError || !userData?.user) {
    res.status(401).json({ error: "Sesion invalida o vencida" });
    return false;
  }
  const { data: perfil, error: perfilError } = await supabase
    .from("perfiles")
    .select("rol")
    .eq("id", userData.user.id)
    .maybeSingle();
  if (perfilError || !perfil || perfil.rol !== "superadmin") {
    res.status(403).json({ error: "Solo el superadmin puede ver esto" });
    return false;
  }
  return true;
}

// Lista de oficinas para el selector del superadmin.
async function handleEmpresas(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  const supabase = getSupabase();
  if (!(await requireSuperadmin(req, res, supabase))) return;

  const { data, error } = await supabase
    .from("empresas")
    .select("id, nombre")
    .eq("activo", true)
    .order("nombre");
  if (error) {
    return res.status(500).json({ error: "Error leyendo empresas" });
  }

  res.setHeader("Cache-Control", "no-store");
  return res.status(200).json({ empresas: data ?? [] });
}

interface AgentAgg {
  leads: number;
  registros: number;
  ftds: number;
  ventasUSD: number;
  comisionUSD: number;
}

const PAGE_GLOBAL = 1000;

// Vista combinada de las oficinas para el superadmin: por cada empresa
// activa, repite (version simplificada, solo del mes en curso) el mismo
// calculo que ya hace /metrics por oficina, y junta todo en una sola lista
// de agentes con el nombre de su empresa al lado, mas un subtotal por
// oficina.
async function handleGlobal(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  const supabase = getSupabase();
  if (!(await requireSuperadmin(req, res, supabase))) return;

  const { data: empresasRows, error: empresasError } = await supabase
    .from("empresas")
    .select(
      "id, nombre, tasa_pauta_ejecutivo_cop, tasa_pauta_junior_cop, comision_por_ftd_usd, costo_por_lead_fijo_cop"
    )
    .eq("activo", true)
    .order("nombre");
  if (empresasError) {
    return res.status(500).json({ error: "Error leyendo empresas" });
  }

  const ahoraCo = new Date(Date.now() - 5 * 60 * 60 * 1000);
  const desdeMesCo = new Date(Date.UTC(ahoraCo.getUTCFullYear(), ahoraCo.getUTCMonth(), 1, 5, 0, 0)).toISOString();

  const oficinas: any[] = [];
  const agentesGlobal: any[] = [];

  for (const empresa of empresasRows ?? []) {
    const empresaId = empresa.id as number;
    const tasasPauta = {
      ejecutivoCOP: Number(empresa.tasa_pauta_ejecutivo_cop),
      juniorCOP: Number(empresa.tasa_pauta_junior_cop),
    };
    const comisionPorFtd = Number(empresa.comision_por_ftd_usd);
    const costoPorLeadFijoCOP =
      empresa.costo_por_lead_fijo_cop === null || empresa.costo_por_lead_fijo_cop === undefined
        ? null
        : Number(empresa.costo_por_lead_fijo_cop);

    const { data: agentesRows, error: agentesError } = await supabase
      .from("agentes")
      .select("nombre, tier")
      .eq("activo", true)
      .eq("empresa_id", empresaId);
    if (agentesError) {
      return res.status(500).json({ error: `Error leyendo agentes de ${empresa.nombre}` });
    }

    const byAgent = new Map<string, AgentAgg>();
    const tierByAgente = new Map<string, "ejecutivo" | "junior" | null>();
    for (const a of agentesRows ?? []) {
      byAgent.set(a.nombre, { leads: 0, registros: 0, ftds: 0, ventasUSD: 0, comisionUSD: 0 });
      tierByAgente.set(a.nombre, (a.tier as "ejecutivo" | "junior" | null) ?? null);
    }

    for (let offset = 0; ; offset += PAGE_GLOBAL) {
      const { data: page, error } = await supabase
        .from("eventos")
        .select("agente, tipo, monto, comision")
        .eq("empresa_id", empresaId)
        .gte("fecha", desdeMesCo)
        .range(offset, offset + PAGE_GLOBAL - 1);
      if (error) {
        return res.status(500).json({ error: `Error leyendo actividad de ${empresa.nombre}` });
      }
      for (const row of page ?? []) {
        if (!byAgent.has(row.agente)) {
          byAgent.set(row.agente, { leads: 0, registros: 0, ftds: 0, ventasUSD: 0, comisionUSD: 0 });
        }
        const agg = byAgent.get(row.agente)!;
        if (row.tipo === "lead") agg.leads++;
        else if (row.tipo === "registro") agg.registros++;
        else if (row.tipo === "ftd") agg.ftds++;
        else if (row.tipo === "venta") {
          agg.ventasUSD += Number(row.monto ?? 0);
          agg.comisionUSD += Number(row.comision ?? 0);
        }
      }
      if (!page || page.length < PAGE_GLOBAL) break;
    }

    const { diasActivos: diasActivosPauta } = await getDiasActivosPautaMes(supabase, empresaId);

    const agentesBase = Array.from(byAgent.entries()).map(([agente, a]) => {
      const tier = tierByAgente.get(agente) ?? null;
      const tasaDiaria = tasaDiariaCOP(tier, tasasPauta);
      const gastoPautaCOP = tasaDiaria !== null ? Math.round(tasaDiaria * diasActivosPauta) : null;
      return { agente, ...a, tier, gastoPautaCOP };
    });

    const totalLeadsMes = agentesBase.reduce((acc, a) => acc + a.leads, 0);
    const totalInvertidoCOP = agentesBase.reduce((acc, a) => acc + (a.gastoPautaCOP || 0), 0);
    const costoPorLeadCOP = costoPorLeadFijoCOP ?? (totalLeadsMes > 0 ? totalInvertidoCOP / totalLeadsMes : null);

    let totalFtds = 0;
    let totalRegistros = 0;
    let totalVentasUSD = 0;

    for (const a of agentesBase) {
      const gastoRealCOP = costoPorLeadCOP !== null ? Math.round(costoPorLeadCOP * a.leads) : null;
      const costoPorFtdRealCOP = gastoRealCOP !== null && a.ftds > 0 ? Math.round(gastoRealCOP / a.ftds) : null;
      totalFtds += a.ftds;
      totalRegistros += a.registros;
      totalVentasUSD += a.ventasUSD;
      agentesGlobal.push({
        agente: a.agente,
        empresaId,
        empresaNombre: empresa.nombre,
        tier: a.tier,
        leads: a.leads,
        registros: a.registros,
        ftds: a.ftds,
        ventasUSD: a.ventasUSD,
        comisionUSD: a.comisionUSD,
        gastoRealCOP,
        costoPorFtdRealCOP,
        gananciaEstimadaUSD: a.comisionUSD + a.ftds * comisionPorFtd,
      });
    }

    oficinas.push({
      empresaId,
      empresaNombre: empresa.nombre,
      totalLeadsMes,
      totalRegistros,
      totalFtds,
      totalVentasUSD,
      totalInvertidoCOP,
      costoPorLeadCOP: costoPorLeadCOP !== null ? Math.round(costoPorLeadCOP) : null,
      costoPromedioPorFtdCOP: totalFtds > 0 ? Math.round(totalInvertidoCOP / totalFtds) : null,
    });
  }

  res.setHeader("Cache-Control", "no-store");
  return res.status(200).json({
    oficinas,
    agentes: agentesGlobal,
    actualizado: new Date().toISOString(),
  });
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const accion = typeof req.query.accion === "string" ? req.query.accion : "";
  switch (accion) {
    case "agentes":
      return handleAgentes(req, res);
    case "ajuste-manual":
      return handleAjusteManual(req, res);
    case "crear-login-agente":
      return handleCrearLoginAgente(req, res);
    case "abonos":
      return handleAbonos(req, res);
    case "test-comision-director":
      return handleTestComisionDirector(req, res);
    case "empresas":
      return handleEmpresas(req, res);
    case "global":
      return handleGlobal(req, res);
    default:
      return res.status(404).json({ error: "Accion no reconocida" });
  }
}
