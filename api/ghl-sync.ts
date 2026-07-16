import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getSupabase } from "./_lib/supabase";

const GHL_BASE = "https://services.leadconnectorhq.com";
const GHL_VERSION = "2021-07-28";
const TIME_BUDGET_MS = 32000;
const REQUEST_TIMEOUT_MS = 12000;
const CURSOR_KEY = "ghl_sync_cursor";
const CUTOFF_KEY = "registro_ftd_cutoff";
const PAGE_LIMIT = 100;
const MAX_RETRIES_429 = 4;

const PIPELINE_ID = "oRjd1pUxOgNbzkdLBjWC";
const FTD_STAGE_ID = "3796b590-4fa6-4ef9-9b27-4aca989f6fd3";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithTimeout(url: string, options: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    for (let intento = 0; intento <= MAX_RETRIES_429; intento++) {
      const res = await fetch(url, { ...options, signal: controller.signal });
      if (res.status !== 429 || intento === MAX_RETRIES_429) return res;
      const retryAfter = Number(res.headers.get("retry-after"));
      const espera = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** intento;
      await sleep(espera);
    }
    throw new Error("unreachable");
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

interface SearchCursor {
  searchAfter?: [number, string];
}

interface CursorState {
  leadsAgentIndex?: number;
  leadsAgentCursor?: SearchCursor;
}

type Supabase = ReturnType<typeof getSupabase>;

function timeLeft(started: number): number {
  return TIME_BUDGET_MS - (Date.now() - started);
}

// Trae TODAS las oportunidades del Pipeline principal (sin filtrar por
// agente - esto ya esta probado como completo y exacto, coincide con los
// totales del tablero de GHL) y arma directamente las filas de registro/ftd
// nuevas, usando el dueno de la OPORTUNIDAD (no del contacto).
//
// Por que el dueno de la oportunidad y no el del contacto: al convertir un
// FTD el contacto casi siempre se reasigna enseguida a otra persona
// (soporte/verificacion), y el "assignedTo" del contacto ya no refleja quien
// hizo la venta. El "assignedTo" de la oportunidad no se toca con eso, asi
// que sigue siendo quien realmente la trabajo.
//
// cutoffMs: los numeros historicos (de antes de este corte) ya quedaron
// sembrados a mano en la base con los valores reales que confirmo el
// director, porque la atribucion por "dueno actual" en GHL no coincide
// con esos totales viejos (mucho tiempo para que se reasignen). De aca en
// adelante solo sumamos lo que pasa DESPUES del corte.
async function cargarOportunidadesPipeline(
  headers: Record<string, string>,
  locationId: string,
  cutoffMs: number,
  agentesById: Map<string, string>
) {
  const rows: EventoRow[] = [];
  let startAfter: number | undefined;
  let startAfterId: string | undefined;
  let revisadas = 0;
  let sinDueno = 0;

  for (;;) {
    const params = new URLSearchParams({
      location_id: locationId,
      pipeline_id: PIPELINE_ID,
      status: "all",
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
    if (opportunities.length === 0) break;

    for (const o of opportunities) {
      revisadas++;
      if (!o.contactId) continue;
      const agente = agentesById.get(o.assignedTo);
      if (!agente) {
        sinDueno++;
        continue;
      }

      const fechaRegistro = o.createdAt || o.lastStageChangeAt || o.updatedAt || new Date().toISOString();
      if (new Date(fechaRegistro).getTime() > cutoffMs) {
        rows.push({ contacto_id: o.contactId, agente, tipo: "registro", fecha: fechaRegistro });
      }

      if (o.pipelineStageId === FTD_STAGE_ID) {
        const fechaFtd = o.lastStageChangeAt || o.updatedAt || o.createdAt || new Date().toISOString();
        if (new Date(fechaFtd).getTime() > cutoffMs) {
          rows.push({ contacto_id: o.contactId, agente, tipo: "ftd", fecha: fechaFtd });
        }
      }
    }

    const meta = data?.meta;
    if (!meta?.nextPage || opportunities.length < PAGE_LIMIT) break;
    startAfter = meta.startAfter;
    startAfterId = meta.startAfterId;
  }

  return { rows, revisadas, sinDueno };
}

// Leads por agente: se pide por assignedTo del CONTACTO, que ya probamos
// que coincide exacto con GHL contacto por contacto (los leads no sufren el
// mismo problema de reasignacion rapida que el registro/ftd).
async function syncAgente(
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
      if (error) throw new Error(`Error guardando datos (${agenteNombre}): ${error.message}`);
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
  const agentesById = new Map(agentesList.map((a) => [a.ghl_user_id, a.nombre]));

  const { data: cursorRow } = await supabase.from("sync_state").select("value").eq("key", CURSOR_KEY).maybeSingle();
  const cursorState: CursorState = (cursorRow?.value as CursorState) || {};

  const { data: cutoffRow } = await supabase.from("sync_state").select("value").eq("key", CUTOFF_KEY).maybeSingle();
  const cutoffMs = cutoffRow?.value ? new Date(cutoffRow.value as string).getTime() : Date.now();

  const headers = {
    Authorization: `Bearer ${token}`,
    Version: GHL_VERSION,
    Accept: "application/json",
    "Content-Type": "application/json",
  };

  const resumen: Record<string, unknown> = {};
  const nextCursor: CursorState = {};

  try {
    const { rows: pipelineRows, revisadas, sinDueno } = await cargarOportunidadesPipeline(
      headers,
      locationId,
      cutoffMs,
      agentesById
    );
    if (pipelineRows.length > 0) {
      const CHUNK = 500;
      for (let i = 0; i < pipelineRows.length; i += CHUNK) {
        const { error } = await supabase
          .from("eventos")
          .upsert(pipelineRows.slice(i, i + CHUNK), { onConflict: "contacto_id,tipo" });
        if (error) throw new Error(`Error guardando registro/ftd: ${error.message}`);
      }
    }
    resumen.pipeline = {
      oportunidadesRevisadas: revisadas,
      sinDuenoActivo: sinDueno,
      registroNuevos: pipelineRows.filter((r) => r.tipo === "registro").length,
      ftdNuevos: pipelineRows.filter((r) => r.tipo === "ftd").length,
    };

    let agentIndex = cursorState.leadsAgentIndex ?? 0;
    let agentCursor = cursorState.leadsAgentCursor;
    let contactosRevisados = 0;
    let eventosGuardados = 0;
    let agentesProcesados = 0;
    let completo = true;

    for (; agentIndex < agentesList.length; agentIndex++) {
      const agente = agentesList[agentIndex];
      const result = await syncAgente(
        agente.ghl_user_id,
        agente.nombre,
        headers,
        locationId,
        supabase,
        started,
        agentCursor
      );
      contactosRevisados += result.contactosRevisados;
      eventosGuardados += result.eventosGuardados;
      agentesProcesados++;

      if (!result.done) {
        completo = false;
        nextCursor.leadsAgentIndex = agentIndex;
        nextCursor.leadsAgentCursor = result.cursor;
        break;
      }
      agentCursor = undefined;
    }

    resumen.agentes = { agentesProcesados, totalAgentes: agentesList.length, contactosRevisados, eventosGuardados, completo };
  } catch (err: any) {
    await supabase.from("sync_state").upsert({ key: CURSOR_KEY, value: nextCursor });
    return res.status(502).json({ error: err?.message || "Error sincronizando con GHL", resumen });
  }

  await supabase.from("sync_state").upsert({ key: CURSOR_KEY, value: nextCursor });

  res.setHeader("Cache-Control", "no-store");
  return res.status(200).json({ ok: true, ...resumen });
}
