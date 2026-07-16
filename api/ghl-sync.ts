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

interface SearchCursor {
  searchAfter?: [number, string];
}

interface CursorState {
  agentIndex?: number;
  agentCursor?: SearchCursor;
}

type Supabase = ReturnType<typeof getSupabase>;

function timeLeft(started: number): number {
  return TIME_BUDGET_MS - (Date.now() - started);
}

// Un solo recorrido de contactos por agente (filtrado por assignedTo, que ya
// sabemos que coincide exactamente con GHL) da lead + registro + ftd juntos:
// - lead: siempre.
// - registro: si el contacto tiene una oportunidad en el Pipeline principal
//   (Registrado es la etapa de entrada, asi que estar ahi ya cuenta).
// - ftd: si esa oportunidad esta especificamente en "FTD Efectuado".
// Antes registro/ftd se sacaban del assignedTo de la Oportunidad, que puede
// desincronizarse del dueno real del contacto (si se reasigna el contacto
// pero la oportunidad vieja no se actualiza) - por eso los conteos no
// coincidian con lo que el director ve filtrando por dueno en GHL.
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

      const opps: any[] = Array.isArray(c.opportunities) ? c.opportunities : [];
      const opp = opps.find((o) => o.pipelineId === PIPELINE_ID);
      if (opp) {
        const fechaEtapa = c.dateUpdated || c.dateAdded || new Date().toISOString();
        rows.push({ contacto_id: c.id, agente: agenteNombre, tipo: "registro", fecha: fechaEtapa });
        if (opp.pipelineStageId === FTD_STAGE_ID) {
          rows.push({ contacto_id: c.id, agente: agenteNombre, tipo: "ftd", fecha: fechaEtapa });
        }
      }
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

  const { data: cursorRow } = await supabase.from("sync_state").select("value").eq("key", CURSOR_KEY).maybeSingle();
  const cursorState: CursorState = (cursorRow?.value as CursorState) || {};

  const headers = {
    Authorization: `Bearer ${token}`,
    Version: GHL_VERSION,
    Accept: "application/json",
    "Content-Type": "application/json",
  };

  let agentIndex = cursorState.agentIndex ?? 0;
  let agentCursor = cursorState.agentCursor;
  let contactosRevisados = 0;
  let eventosGuardados = 0;
  let agentesProcesados = 0;
  let completo = true;
  const nextCursor: CursorState = {};

  try {
    for (; agentIndex < agentesList.length; agentIndex++) {
      const agente = agentesList[agentIndex];
      const result = await syncAgente(agente.ghl_user_id, agente.nombre, headers, locationId, supabase, started, agentCursor);
      contactosRevisados += result.contactosRevisados;
      eventosGuardados += result.eventosGuardados;
      agentesProcesados++;

      if (!result.done) {
        completo = false;
        nextCursor.agentIndex = agentIndex;
        nextCursor.agentCursor = result.cursor;
        break;
      }
      agentCursor = undefined;
    }
  } catch (err: any) {
    await supabase.from("sync_state").upsert({ key: CURSOR_KEY, value: nextCursor });
    return res.status(502).json({
      error: err?.message || "Error sincronizando con GHL",
      agentesProcesados,
      totalAgentes: agentesList.length,
      contactosRevisados,
      eventosGuardados,
    });
  }

  await supabase.from("sync_state").upsert({ key: CURSOR_KEY, value: nextCursor });

  res.setHeader("Cache-Control", "no-store");
  return res.status(200).json({
    ok: true,
    agentesProcesados,
    totalAgentes: agentesList.length,
    contactosRevisados,
    eventosGuardados,
    completo,
  });
}
