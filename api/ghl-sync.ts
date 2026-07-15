import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getSupabase } from "./_lib/supabase";

const GHL_BASE = "https://services.leadconnectorhq.com";
const GHL_VERSION = "2021-07-28";
const REGISTRO_TAG = "registrado";
const FTD_TAG = "ftd-efectuado";
const TIME_BUDGET_MS = 45000;
const CURSOR_KEY = "ghl_contacts_cursor";

interface EventoRow {
  contacto_id: string;
  agente: string;
  tipo: "lead" | "registro" | "ftd";
  fecha: string;
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
  let startAfter: number | undefined = (cursorRow?.value as any)?.startAfter;
  let startAfterId: string | undefined = (cursorRow?.value as any)?.startAfterId;

  const headers = {
    Authorization: `Bearer ${token}`,
    Version: GHL_VERSION,
    Accept: "application/json",
  };

  let contactosRevisados = 0;
  let eventosGuardados = 0;
  let paginas = 0;
  let cicloCompleto = false;

  while (Date.now() - started < TIME_BUDGET_MS) {
    const params = new URLSearchParams({ locationId, limit: "100" });
    if (startAfter !== undefined && startAfterId) {
      params.set("startAfter", String(startAfter));
      params.set("startAfterId", startAfterId);
    }

    const r = await fetch(`${GHL_BASE}/contacts/?${params.toString()}`, { headers });
    if (!r.ok) {
      return res.status(502).json({ error: "GHL respondio con error", status: r.status, contactosRevisados, eventosGuardados });
    }
    const body: any = await r.json();
    const contacts: any[] = Array.isArray(body?.contacts) ? body.contacts : [];
    paginas++;

    if (contacts.length === 0) {
      cicloCompleto = true;
      break;
    }

    const rows: EventoRow[] = [];
    for (const c of contacts) {
      contactosRevisados++;
      const agente = agentesById.get(c.assignedTo);
      if (!agente) continue;
      const fecha = c.dateUpdated || c.dateAdded || new Date().toISOString();
      rows.push({ contacto_id: c.id, agente, tipo: "lead", fecha });
      const tags: string[] = Array.isArray(c.tags) ? c.tags : [];
      if (tags.includes(REGISTRO_TAG)) rows.push({ contacto_id: c.id, agente, tipo: "registro", fecha });
      if (tags.includes(FTD_TAG)) rows.push({ contacto_id: c.id, agente, tipo: "ftd", fecha });
    }

    if (rows.length > 0) {
      const { error } = await supabase.from("eventos").upsert(rows, { onConflict: "contacto_id,tipo" });
      if (error) {
        return res.status(500).json({ error: "Error guardando eventos", detail: error.message, contactosRevisados, eventosGuardados });
      }
      eventosGuardados += rows.length;
    }

    const meta = body?.meta;
    if (!meta?.nextPage) {
      cicloCompleto = true;
      break;
    }
    startAfter = meta.startAfter;
    startAfterId = meta.startAfterId;
  }

  await supabase.from("sync_state").upsert({
    key: CURSOR_KEY,
    value: cicloCompleto ? {} : { startAfter, startAfterId },
  });

  return res.status(200).json({
    ok: true,
    paginasProcesadas: paginas,
    contactosRevisados,
    eventosGuardados,
    cicloCompleto,
  });
}
