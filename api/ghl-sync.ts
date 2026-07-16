import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getSupabase } from "./_lib/supabase";

const GHL_BASE = "https://services.leadconnectorhq.com";
const GHL_VERSION = "2021-07-28";
const TIME_BUDGET_MS = 20000;
const REQUEST_TIMEOUT_MS = 12000;
const CURSOR_KEY = "ghl_sync_cursor";
const PAGE_LIMIT = 100;

const PIPELINE_ID = "oRjd1pUxOgNbzkdLBjWC";
const FTD_STAGE_ID = "3796b590-4fa6-4ef9-9b27-4aca989f6fd3";

async function fetchWithTimeout(url: string, options: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

interface EventoRow {
  contacto_id: string;
  agente: string;
  tipo: "lead" | "registro" | "ftd";
  fecha: string;
}

interface StageCursor {
  startAfter?: number;
  startAfterId?: string;
}

interface SearchCursor {
  searchAfter?: [number, string];
}

interface CursorState {
  oportunidades?: StageCursor;
  leadsAgentIndex?: number;
  leadsAgentCursor?: SearchCursor;
}

type Supabase = ReturnType<typeof getSupabase>;

function timeLeft(started: number): number {
  return TIME_BUDGET_MS - (Date.now() - started);
}

// Trae TODOS los pares (contacto_id, agente) ya guardados como "lead" en
// nuestra base. Esto ya esta validado como exacto (coincide con GHL contacto
// por contacto), asi que sirve como fuente confiable de "a que agente
// pertenece este contacto" - ni el assignedTo de la oportunidad ni el listado
// de oportunidades embebido en el contacto resultaron confiables para esto.
async function cargarMapaContactoAgente(supabase: Supabase): Promise<Map<string, string>> {
  const mapa = new Map<string, string>();
  const PAGE = 1000;
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await supabase
      .from("eventos")
      .select("contacto_id, agente")
      .eq("tipo", "lead")
      .range(offset, offset + PAGE - 1);
    if (error) throw new Error(`Error leyendo leads para el mapa: ${error.message}`);
    for (const row of data ?? []) mapa.set(row.contacto_id, row.agente);
    if (!data || data.length < PAGE) break;
  }
  return mapa;
}

// Registro y FTD se sacan de TODAS las oportunidades del Pipeline principal
// (Registrado es la etapa de entrada, asi que estar en el pipeline ya cuenta
// como registro; FTD Efectuado especificamente cuenta como ftd). El agente se
// determina cruzando el contactId contra el mapa de leads, no contra el
// assignedTo de la oportunidad (que puede desincronizarse del dueno real).
async function syncOportunidades(
  headers: Record<string, string>,
  locationId: string,
  contactoAgente: Map<string, string>,
  supabase: Supabase,
  started: number,
  cursor: StageCursor | undefined
) {
  let startAfter = cursor?.startAfter;
  let startAfterId = cursor?.startAfterId;
  let revisadas = 0;
  let eventosGuardados = 0;

  while (timeLeft(started) > 5000) {
    const params = new URLSearchParams({
      location_id: locationId,
      pipeline_id: PIPELINE_ID,
      limit: String(PAGE_LIMIT),
    });
    if (startAfter !== undefined && startAfterId) {
      params.set("startAfter", String(startAfter));
      params.set("startAfterId", startAfterId);
    }

    const r = await fetchWithTimeout(`${GHL_BASE}/opportunities/search?${params.toString()}`, { headers });
    if (!r.ok) throw new Error(`GHL /opportunities/search respondio ${r.status}`);
    const data: any = await r.json();
    const opportunities: any[] = Array.isArray(data?.opportunities) ? data.opportunities : [];
    if (opportunities.length === 0) {
      return { done: true, cursor: undefined, revisadas, eventosGuardados };
    }

    const rows: EventoRow[] = [];
    for (const o of opportunities) {
      revisadas++;
      const agente = contactoAgente.get(o.contactId);
      if (!agente) continue;
      const fechaRegistro = o.createdAt || o.lastStageChangeAt || o.updatedAt || new Date().toISOString();
      rows.push({ contacto_id: o.contactId, agente, tipo: "registro", fecha: fechaRegistro });
      if (o.pipelineStageId === FTD_STAGE_ID) {
        const fechaFtd = o.lastStageChangeAt || o.updatedAt || o.createdAt || new Date().toISOString();
        rows.push({ contacto_id: o.contactId, agente, tipo: "ftd", fecha: fechaFtd });
      }
    }
    if (rows.length > 0) {
      const { error } = await supabase.from("eventos").upsert(rows, { onConflict: "contacto_id,tipo" });
      if (error) throw new Error(`Error guardando registro/ftd: ${error.message}`);
      eventosGuardados += rows.length;
    }

    const meta = data?.meta;
    if (!meta?.nextPage || opportunities.length < PAGE_LIMIT) {
      return { done: true, cursor: undefined, revisadas, eventosGuardados };
    }
    startAfter = meta.startAfter;
    startAfterId = meta.startAfterId;
  }

  return { done: false, cursor: { startAfter, startAfterId }, revisadas, eventosGuardados };
}

// Leads: por agente (assignedTo), validado como exacto contra GHL.
async function syncLeadsAgente(
  ghlUserId: string,
  agenteNombre: string,
  headers: Record<string, string>,
  locationId: string,
  supabase: Supabase,
  started: number,
  cursor: SearchCursor | undefined
) {
  let searchAfter = cursor?.searchAfter;
  let contactosRevisados = 0;
  let eventosGuardados = 0;

  while (timeLeft(started) > 5000) {
    const body: Record<string, unknown> = {
      locationId,
      pageLimit: PAGE_LIMIT,
      filters: [{ field: "assignedTo", operator: "eq", value: ghlUserId }],
      sort: [{ field: "dateAdded", direction: "desc" }],
    };
    if (searchAfter) body.searchAfter = searchAfter;

    const r = await fetchWithTimeout(`${GHL_BASE}/contacts/search`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`GHL /contacts/search (${agenteNombre}) respondio ${r.status}`);
    const data: any = await r.json();
    const contacts: any[] = Array.isArray(data?.contacts) ? data.contacts : [];
    if (contacts.length === 0) {
      return { done: true, cursor: undefined, contactosRevisados, eventosGuardados };
    }

    const rows: EventoRow[] = [];
    for (const c of contacts) {
      contactosRevisados++;
      const fecha = c.dateAdded || c.dateUpdated || new Date().toISOString();
      rows.push({ contacto_id: c.id, agente: agenteNombre, tipo: "lead", fecha });
    }
    if (rows.length > 0) {
      const { error } = await supabase.from("eventos").upsert(rows, { onConflict: "contacto_id,tipo" });
      if (error) throw new Error(`Error guardando leads (${agenteNombre}): ${error.message}`);
      eventosGuardados += rows.length;
    }

    searchAfter = contacts[contacts.length - 1].searchAfter;
    if (contacts.length < PAGE_LIMIT) {
      return { done: true, cursor: undefined, contactosRevisados, eventosGuardados };
    }
  }

  return { done: false, cursor: { searchAfter }, contactosRevisados, eventosGuardados };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const secret = process.env.WEBHOOK_SECRET;
  if (!secret || req.query.key !== secret) {
    return res.status(401).json({ error: "No autorizado. Agregá ?key=TU_WEBHOOK_SECRET a la URL." });
  }

  const token = process.env.GHL_API_TOKEN;
  const locationId = process.env.GHL_LOCATION_ID;
  if (!token || !locationId) {
    return res.status(500).json({ error: "Faltan GHL_API_TOKEN o GHL_LOCATION_ID en Vercel" });
  }

  const supabase = getSupabase();
  const started = Date.now();

  const { data: agentesRows, error: agentesError } = await supabase
    .from("agentes")
    .select("ghl_user_id, nombre")
    .eq("activo", true)
    .order("ghl_user_id");
  if (agentesError) {
    return res.status(500).json({ error: "No se pudo leer la tabla agentes", detail: agentesError.message });
  }
  const agentesList = agentesRows ?? [];
  if (agentesList.length === 0) {
    return res.status(200).json({ ok: true, note: "La tabla agentes esta vacia, nada para sincronizar" });
  }

  const { data: cursorRow } = await supabase.from("sync_state").select("value").eq("key", CURSOR_KEY).maybeSingle();
  const cursorState: CursorState = (cursorRow?.value as CursorState) || {};

  const headers = {
    Authorization: `Bearer ${token}`,
    Version: GHL_VERSION,
    Accept: "application/json",
    "Content-Type": "application/json",
  };

  const resumen: Record<string, unknown> = {};
  const nextCursor: CursorState = {};

  try {
    const contactoAgente = await cargarMapaContactoAgente(supabase);

    const oportunidadesResult = await syncOportunidades(
      headers,
      locationId,
      contactoAgente,
      supabase,
      started,
      cursorState.oportunidades
    );
    resumen.oportunidades = {
      revisadas: oportunidadesResult.revisadas,
      eventosGuardados: oportunidadesResult.eventosGuardados,
      completo: oportunidadesResult.done,
    };
    if (!oportunidadesResult.done) nextCursor.oportunidades = oportunidadesResult.cursor;

    let agentIndex = cursorState.leadsAgentIndex ?? 0;
    let agentCursor = cursorState.leadsAgentCursor;
    let leadsContactosRevisados = 0;
    let leadsEventosGuardados = 0;
    let leadsCompleto = true;
    let agentesProcesados = 0;

    for (; agentIndex < agentesList.length; agentIndex++) {
      const agente = agentesList[agentIndex];
      const result = await syncLeadsAgente(
        agente.ghl_user_id,
        agente.nombre,
        headers,
        locationId,
        supabase,
        started,
        agentCursor
      );
      leadsContactosRevisados += result.contactosRevisados;
      leadsEventosGuardados += result.eventosGuardados;
      agentesProcesados++;

      if (!result.done) {
        leadsCompleto = false;
        nextCursor.leadsAgentIndex = agentIndex;
        nextCursor.leadsAgentCursor = result.cursor;
        break;
      }
      agentCursor = undefined;
    }

    resumen.leads = {
      agentesProcesados,
      totalAgentes: agentesList.length,
      contactosRevisados: leadsContactosRevisados,
      eventosGuardados: leadsEventosGuardados,
      completo: leadsCompleto,
    };
  } catch (err: any) {
    await supabase.from("sync_state").upsert({ key: CURSOR_KEY, value: nextCursor });
    return res.status(502).json({ error: err?.message || "Error sincronizando con GHL", resumen });
  }

  await supabase.from("sync_state").upsert({ key: CURSOR_KEY, value: nextCursor });

  res.setHeader("Cache-Control", "no-store");
  return res.status(200).json({ ok: true, ...resumen });
}
