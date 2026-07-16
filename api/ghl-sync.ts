import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getSupabase } from "./_lib/supabase";

const GHL_BASE = "https://services.leadconnectorhq.com";
const GHL_VERSION = "2021-07-28";
const TIME_BUDGET_MS = 45000;
const CURSOR_KEY = "ghl_sync_cursor";
const PAGE_LIMIT = 100;

const PIPELINE_ID = "oRjd1pUxOgNbzkdLBjWC";
const FTD_STAGE_ID = "3796b590-4fa6-4ef9-9b27-4aca989f6fd3";

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

interface CursorState {
  leads?: StageCursor;
  registro?: StageCursor;
  ftd?: StageCursor;
}

type Supabase = ReturnType<typeof getSupabase>;

function timeLeft(started: number): number {
  return TIME_BUDGET_MS - (Date.now() - started);
}

// Registro = cualquier oportunidad en el Pipeline principal, sin importar la
// etapa actual (Registrado es la etapa de entrada: si avanzo a FTD Efectuado,
// tambien paso por Registrado). FTD = oportunidades que llegaron especificamente
// a la etapa "FTD Efectuado". Se usa el pipeline/etapa en vez de etiquetas porque
// asi es como el director mide estos numeros en GHL.
async function syncByStage(
  tipo: "registro" | "ftd",
  stageId: string | null,
  headers: Record<string, string>,
  locationId: string,
  agentesById: Map<string, string>,
  supabase: Supabase,
  started: number,
  cursor: StageCursor | undefined
) {
  let startAfter = cursor?.startAfter;
  let startAfterId = cursor?.startAfterId;
  let contactosRevisados = 0;
  let eventosGuardados = 0;

  while (timeLeft(started) > 5000) {
    const params = new URLSearchParams({
      location_id: locationId,
      pipeline_id: PIPELINE_ID,
      limit: String(PAGE_LIMIT),
    });
    if (stageId) params.set("pipeline_stage_id", stageId);
    if (startAfter !== undefined && startAfterId) {
      params.set("startAfter", String(startAfter));
      params.set("startAfterId", startAfterId);
    }

    const r = await fetch(`${GHL_BASE}/opportunities/search?${params.toString()}`, { headers });
    if (!r.ok) {
      throw new Error(`GHL /opportunities/search (${tipo}) respondio ${r.status}`);
    }
    const data: any = await r.json();
    const opportunities: any[] = Array.isArray(data?.opportunities) ? data.opportunities : [];
    if (opportunities.length === 0) {
      return { done: true, cursor: undefined, contactosRevisados, eventosGuardados };
    }

    const rows: EventoRow[] = [];
    for (const o of opportunities) {
      contactosRevisados++;
      const agente = agentesById.get(o.assignedTo);
      if (!agente || !o.contactId) continue;
      const fecha = o.lastStageChangeAt || o.updatedAt || o.createdAt || new Date().toISOString();
      rows.push({ contacto_id: o.contactId, agente, tipo, fecha });
    }
    if (rows.length > 0) {
      const { error } = await supabase.from("eventos").upsert(rows, { onConflict: "contacto_id,tipo" });
      if (error) throw new Error(`Error guardando ${tipo}: ${error.message}`);
      eventosGuardados += rows.length;
    }

    const meta = data?.meta;
    if (!meta?.nextPage || opportunities.length < PAGE_LIMIT) {
      return { done: true, cursor: undefined, contactosRevisados, eventosGuardados };
    }
    startAfter = meta.startAfter;
    startAfterId = meta.startAfterId;
  }

  return { done: false, cursor: { startAfter, startAfterId }, contactosRevisados, eventosGuardados };
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
    .eq("activo", true);
  if (agentesError) {
    return res.status(500).json({ error: "No se pudo leer la tabla agentes", detail: agentesError.message });
  }
  const agentesById = new Map<string, string>((agentesRows ?? []).map((a) => [a.ghl_user_id, a.nombre]));
  if (agentesById.size === 0) {
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
    const registroResult = await syncByStage(
      "registro",
      null,
      headers,
      locationId,
      agentesById,
      supabase,
      started,
      cursorState.registro
    );
    resumen.registro = {
      revisadas: registroResult.contactosRevisados,
      eventosGuardados: registroResult.eventosGuardados,
      completo: registroResult.done,
    };
    if (!registroResult.done) nextCursor.registro = registroResult.cursor;

    const ftdResult = await syncByStage(
      "ftd",
      FTD_STAGE_ID,
      headers,
      locationId,
      agentesById,
      supabase,
      started,
      cursorState.ftd
    );
    resumen.ftd = {
      revisadas: ftdResult.contactosRevisados,
      eventosGuardados: ftdResult.eventosGuardados,
      completo: ftdResult.done,
    };
    if (!ftdResult.done) nextCursor.ftd = ftdResult.cursor;

    let startAfter = cursorState.leads?.startAfter;
    let startAfterId = cursorState.leads?.startAfterId;
    let leadsContactosRevisados = 0;
    let leadsEventosGuardados = 0;
    let leadsCompleto = false;
    let paginas = 0;

    while (timeLeft(started) > 5000) {
      const params = new URLSearchParams({ locationId, limit: String(PAGE_LIMIT) });
      if (startAfter !== undefined && startAfterId) {
        params.set("startAfter", String(startAfter));
        params.set("startAfterId", startAfterId);
      }
      const r = await fetch(`${GHL_BASE}/contacts/?${params.toString()}`, { headers });
      if (!r.ok) throw new Error(`GHL /contacts respondio ${r.status}`);
      const body: any = await r.json();
      const contacts: any[] = Array.isArray(body?.contacts) ? body.contacts : [];
      paginas++;
      if (contacts.length === 0) {
        leadsCompleto = true;
        break;
      }

      const rows: EventoRow[] = [];
      for (const c of contacts) {
        leadsContactosRevisados++;
        const agente = agentesById.get(c.assignedTo);
        if (!agente) continue;
        // dateAdded (fecha real de creacion), no dateUpdated: asi coincide con como
        // el director mide "leads" en GHL (filtro de fecha de creacion de usuario).
        const fecha = c.dateAdded || c.dateUpdated || new Date().toISOString();
        rows.push({ contacto_id: c.id, agente, tipo: "lead", fecha });
      }
      if (rows.length > 0) {
        const { error } = await supabase.from("eventos").upsert(rows, { onConflict: "contacto_id,tipo" });
        if (error) throw new Error(`Error guardando leads: ${error.message}`);
        leadsEventosGuardados += rows.length;
      }

      const meta = body?.meta;
      if (!meta?.nextPage || contacts.length < PAGE_LIMIT) {
        leadsCompleto = true;
        break;
      }
      startAfter = meta.startAfter;
      startAfterId = meta.startAfterId;
    }

    resumen.leads = {
      paginas,
      contactosRevisados: leadsContactosRevisados,
      eventosGuardados: leadsEventosGuardados,
      completo: leadsCompleto,
    };
    if (!leadsCompleto) nextCursor.leads = { startAfter, startAfterId };
  } catch (err: any) {
    await supabase.from("sync_state").upsert({ key: CURSOR_KEY, value: nextCursor });
    return res.status(502).json({ error: err?.message || "Error sincronizando con GHL", resumen });
  }

  await supabase.from("sync_state").upsert({ key: CURSOR_KEY, value: nextCursor });

  return res.status(200).json({ ok: true, ...resumen });
}
