import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getSupabase } from "./_lib/supabase";

const GHL_BASE = "https://services.leadconnectorhq.com";
const GHL_VERSION = "2021-07-28";
const PIPELINE_ID = "oRjd1pUxOgNbzkdLBjWC";
const REGISTRADO_STAGE_ID = "09b221aa-9791-4f05-8869-1b4ac8c86e06";
const FTD_STAGE_ID = "3796b590-4fa6-4ef9-9b27-4aca989f6fd3";
const PAGE_LIMIT = 100;

// Compara, para un agente puntual, todas sus oportunidades de un tipo
// (registro/ftd) segun GHL contra lo que ya tenemos guardado en la base -
// asi identificamos exactamente cuales faltan (y sus fechas), sin tener que
// revisar cliente por cliente a mano.
//
// Importante: se arma IGUAL que el sync real (cargarEtapaPipeline en
// ghl-sync.ts) - se trae TODA la etapa (registrado o ftd) con status=all y
// se filtra el dueno del lado del cliente comparando o.assignedTo, en vez de
// mandarle assigned_to a la API de GHL como query param. El filtro
// assigned_to de GHL no se comporta como uno esperaria (devuelve resultados
// que no coinciden con el agente), asi que replicar el metodo real evita
// falsos "faltantes".
async function compararAgente(
  headers: Record<string, string>,
  locationId: string,
  agenteNombre: string,
  tipo: "registro" | "ftd"
) {
  const supabase = getSupabase();
  const { data: agenteRow, error: agenteError } = await supabase
    .from("agentes")
    .select("ghl_user_id, nombre")
    .ilike("nombre", `%${agenteNombre}%`)
    .maybeSingle();
  if (agenteError || !agenteRow) {
    return { error: `No encontre un agente que coincida con "${agenteNombre}"` };
  }

  const stageId = tipo === "ftd" ? FTD_STAGE_ID : REGISTRADO_STAGE_ID;
  const opportunities: any[] = [];
  let startAfter: number | undefined;
  let startAfterId: string | undefined;
  for (;;) {
    const params = new URLSearchParams({
      location_id: locationId,
      pipeline_id: PIPELINE_ID,
      pipeline_stage_id: stageId,
      status: "all",
      limit: String(PAGE_LIMIT),
    });
    if (startAfter !== undefined && startAfterId) {
      params.set("startAfter", String(startAfter));
      params.set("startAfterId", startAfterId);
    }
    const r = await fetch(`${GHL_BASE}/opportunities/search?${params.toString()}`, { headers });
    if (!r.ok) return { error: `GHL /opportunities/search respondio ${r.status}` };
    const data: any = await r.json();
    const pagina: any[] = Array.isArray(data?.opportunities) ? data.opportunities : [];
    if (pagina.length === 0) break;
    opportunities.push(...pagina.filter((o) => o.assignedTo === agenteRow.ghl_user_id));
    const meta = data?.meta;
    if (!meta?.nextPage || pagina.length < PAGE_LIMIT) break;
    startAfter = meta.startAfter;
    startAfterId = meta.startAfterId;
  }

  const { data: guardados } = await supabase
    .from("eventos")
    .select("contacto_id")
    .eq("agente", agenteRow.nombre)
    .eq("tipo", tipo);
  const idsGuardados = new Set((guardados ?? []).map((r) => r.contacto_id));

  const faltantesSinNombre = opportunities.filter((o) => o.contactId && !idsGuardados.has(o.contactId));

  const faltantes = [];
  const BATCH = 10;
  for (let i = 0; i < faltantesSinNombre.length; i += BATCH) {
    const lote = faltantesSinNombre.slice(i, i + BATCH);
    const conNombre = await Promise.all(
      lote.map(async (o) => {
        const r = await fetch(`${GHL_BASE}/contacts/${o.contactId}`, { headers });
        const body: any = r.ok ? await r.json().catch(() => ({})) : {};
        const contact = body?.contact;
        return {
          contactId: o.contactId,
          nombre: contact?.contactName || `${contact?.firstName ?? ""} ${contact?.lastName ?? ""}`.trim(),
          opportunityId: o.id,
          pipelineStageId: o.pipelineStageId,
          createdAt: o.createdAt,
          lastStageChangeAt: o.lastStageChangeAt,
          updatedAt: o.updatedAt,
        };
      })
    );
    faltantes.push(...conNombre);
  }
  faltantes.sort((a, b) => (b.lastStageChangeAt || "").localeCompare(a.lastStageChangeAt || ""));

  return {
    agente: agenteRow.nombre,
    tipo,
    totalEnGhl: opportunities.length,
    totalGuardado: idsGuardados.size,
    faltantesEnBaseDeDatos: faltantes,
  };
}

// Compara TODOS los agentes de una sola pasada (una sola traida de la
// etapa completa en GHL, no una por agente) contra lo guardado en la base.
// Separa los faltantes en "antes del corte" (esperado - ya representado
// solo como total agregado en el historico) de los de "despues del corte"
// (huecos reales, con detalle de a quien y cuando).
async function barridoGeneral(
  headers: Record<string, string>,
  locationId: string,
  tipo: "registro" | "ftd"
) {
  const supabase = getSupabase();

  const { data: agentesRows } = await supabase.from("agentes").select("ghl_user_id, nombre").eq("activo", true);
  const agentesById = new Map((agentesRows ?? []).map((a) => [a.ghl_user_id, a.nombre]));

  const { data: cutoffRow } = await supabase
    .from("sync_state")
    .select("value")
    .eq("key", "registro_ftd_cutoff")
    .maybeSingle();
  const cutoffMs = cutoffRow?.value ? new Date(cutoffRow.value as string).getTime() : Date.now();

  const stageId = tipo === "ftd" ? FTD_STAGE_ID : REGISTRADO_STAGE_ID;
  const opportunities: any[] = [];
  let startAfter: number | undefined;
  let startAfterId: string | undefined;
  for (;;) {
    const params = new URLSearchParams({
      location_id: locationId,
      pipeline_id: PIPELINE_ID,
      pipeline_stage_id: stageId,
      status: "all",
      limit: String(PAGE_LIMIT),
    });
    if (startAfter !== undefined && startAfterId) {
      params.set("startAfter", String(startAfter));
      params.set("startAfterId", startAfterId);
    }
    const r = await fetch(`${GHL_BASE}/opportunities/search?${params.toString()}`, { headers });
    if (!r.ok) return { error: `GHL /opportunities/search respondio ${r.status}` };
    const data: any = await r.json();
    const pagina: any[] = Array.isArray(data?.opportunities) ? data.opportunities : [];
    if (pagina.length === 0) break;
    opportunities.push(...pagina);
    const meta = data?.meta;
    if (!meta?.nextPage || pagina.length < PAGE_LIMIT) break;
    startAfter = meta.startAfter;
    startAfterId = meta.startAfterId;
  }

  const { data: guardadosRows } = await supabase.from("eventos").select("contacto_id, agente").eq("tipo", tipo);
  const guardadosSet = new Set((guardadosRows ?? []).map((r) => r.contacto_id));

  const fechaDe = (o: any) =>
    tipo === "ftd"
      ? o.lastStageChangeAt || o.updatedAt || o.createdAt
      : o.createdAt || o.updatedAt;

  const porAgente: Record<string, { totalEnGhl: number; faltantesAntesDelCorte: number; faltantesDespuesDelCorte: number }> = {};
  const faltantesRecientes: any[] = [];

  for (const o of opportunities) {
    const agente = agentesById.get(o.assignedTo);
    if (!agente) continue;
    if (!porAgente[agente]) porAgente[agente] = { totalEnGhl: 0, faltantesAntesDelCorte: 0, faltantesDespuesDelCorte: 0 };
    porAgente[agente].totalEnGhl++;
    if (!o.contactId || guardadosSet.has(o.contactId)) continue;

    const fecha = fechaDe(o);
    const esPost = fecha && new Date(fecha).getTime() > cutoffMs;
    if (esPost) {
      porAgente[agente].faltantesDespuesDelCorte++;
      faltantesRecientes.push({ agente, contactId: o.contactId, opportunityId: o.id, fecha });
    } else {
      porAgente[agente].faltantesAntesDelCorte++;
    }
  }

  faltantesRecientes.sort((a, b) => (b.fecha || "").localeCompare(a.fecha || ""));

  return {
    tipo,
    cutoff: cutoffRow?.value ?? null,
    totalOportunidadesEnEtapa: opportunities.length,
    totalGuardadoGlobal: guardadosSet.size,
    porAgente,
    faltantesRecientes,
  };
}

// Busca un cliente por nombre directo en GHL y muestra sus oportunidades en
// el pipeline principal (etapa, fechas, dueno asignado), para diagnosticar
// casos puntuales sin tener que adivinar por que un registro/ftd no aparece.
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

  const headers = {
    Authorization: `Bearer ${token}`,
    Version: GHL_VERSION,
    Accept: "application/json",
  };

  if (req.query.barrido === "1") {
    const tipo = req.query.tipo === "ftd" ? "ftd" : "registro";
    const resultado = await barridoGeneral(headers, locationId, tipo);
    return res.status(200).json(resultado);
  }

  // Muestra el ghl_user_id que tenemos guardado para un agente, para
  // compararlo contra el "assignedTo"/"opportunityAsignadaA" que devuelve
  // GHL en una oportunidad puntual - si no coinciden, esa oportunidad cae en
  // "sinDueno" y el sync la descarta en silencio.
  const agenteIdQuery = typeof req.query.agenteid === "string" ? req.query.agenteid.trim() : "";
  if (agenteIdQuery) {
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from("agentes")
      .select("nombre, ghl_user_id, activo")
      .ilike("nombre", `%${agenteIdQuery}%`);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ agentes: data ?? [] });
  }

  // Busca directo en la tabla eventos por contacto_id, para saber con
  // certeza si una fila puntual quedo guardada (y con que fecha/agente) sin
  // tener que inferirlo comparando contra GHL.
  const checkEventoId = typeof req.query.checkevento === "string" ? req.query.checkevento.trim() : "";
  if (checkEventoId) {
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from("eventos")
      .select("contacto_id, agente, tipo, fecha, contacto_nombre, contacto_telefono, creado_en")
      .eq("contacto_id", checkEventoId);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ eventos: data ?? [] });
  }

  // Resumen de las filas "baseline-*" (el historico sembrado a mano): cuantas
  // hay por tipo y que fecha les quedo asignada - si esa fecha cae fuera de
  // un rango que se este filtrando (ej. "Este mes"), ese historico
  // desaparece del conteo aunque siga estando en la base.
  if (req.query.baseline === "1") {
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from("eventos")
      .select("tipo, fecha, agente")
      .like("contacto_id", "baseline-%");
    if (error) return res.status(500).json({ error: error.message });
    const rows = data ?? [];
    const porTipo: Record<string, { cantidad: number; fechaMin: string; fechaMax: string }> = {};
    for (const r of rows) {
      const cur = porTipo[r.tipo] ?? { cantidad: 0, fechaMin: r.fecha, fechaMax: r.fecha };
      cur.cantidad++;
      if (r.fecha < cur.fechaMin) cur.fechaMin = r.fecha;
      if (r.fecha > cur.fechaMax) cur.fechaMax = r.fecha;
      porTipo[r.tipo] = cur;
    }
    return res.status(200).json({ totalFilasBaseline: rows.length, porTipo });
  }

  if (req.query.cutoff === "1") {
    const supabase = getSupabase();
    const { data: cutoffRow } = await supabase
      .from("sync_state")
      .select("value")
      .eq("key", "registro_ftd_cutoff")
      .maybeSingle();
    return res.status(200).json({ registro_ftd_cutoff: cutoffRow?.value ?? null });
  }

  // Lista los custom fields configurados en el location, para identificar
  // si existe alguno tipo "ID de broker"/"cuenta" y con que id/fieldKey se
  // guarda (necesario para despues poder leer su valor en cada contacto).
  if (req.query.customfields === "1") {
    const r = await fetch(`${GHL_BASE}/locations/${locationId}/customFields`, { headers });
    if (!r.ok) return res.status(502).json({ error: `GHL /locations/${locationId}/customFields respondio ${r.status}` });
    const data: any = await r.json();
    const campos = Array.isArray(data?.customFields) ? data.customFields : [];
    return res.status(200).json({
      campos: campos.map((c: any) => ({ id: c.id, name: c.name, fieldKey: c.fieldKey, dataType: c.dataType })),
    });
  }

  if (req.query.pipelines === "1") {
    const r = await fetch(`${GHL_BASE}/opportunities/pipelines?locationId=${locationId}`, { headers });
    if (!r.ok) return res.status(502).json({ error: `GHL /opportunities/pipelines respondio ${r.status}` });
    const data: any = await r.json();
    const pipelines = Array.isArray(data?.pipelines) ? data.pipelines : [];
    return res.status(200).json({
      pipelines: pipelines.map((p: any) => ({
        id: p.id,
        name: p.name,
        stages: (p.stages ?? []).map((s: any) => ({ id: s.id, name: s.name })),
      })),
    });
  }

  const agenteQuery = typeof req.query.agente === "string" ? req.query.agente.trim() : "";
  if (agenteQuery) {
    const tipo = req.query.tipo === "registro" ? "registro" : "ftd";
    const comparacion = await compararAgente(headers, locationId, agenteQuery, tipo);
    return res.status(200).json(comparacion);
  }

  const nombre = typeof req.query.nombre === "string" ? req.query.nombre.trim() : "";
  const contactId = typeof req.query.contactId === "string" ? req.query.contactId.trim() : "";
  const opportunityId = typeof req.query.opportunityId === "string" ? req.query.opportunityId.trim() : "";
  if (!nombre && !contactId && !opportunityId) {
    return res.status(400).json({
      error:
        "Agregá ?agente=NombreAgente (compara todo su registro/ftd), o ?nombre=NombreDelCliente, o ?contactId=ID, o ?opportunityId=ID",
    });
  }

  let contacts: any[] = [];

  if (opportunityId) {
    const oppRes = await fetch(`${GHL_BASE}/opportunities/${opportunityId}`, { headers });
    if (!oppRes.ok) {
      return res.status(502).json({ error: `GHL /opportunities/${opportunityId} respondio ${oppRes.status}` });
    }
    const oppBody: any = await oppRes.json();
    const opp = oppBody?.opportunity;
    if (!opp?.contactId) {
      return res.status(404).json({ error: "Esa oportunidad no tiene contactId asociado", raw: oppBody });
    }
    contacts = [{ id: opp.contactId }];
  } else if (contactId) {
    contacts = [{ id: contactId }];
  } else {
    const searchParams = new URLSearchParams({ locationId, query: nombre, limit: "10" });
    const contactsRes = await fetch(`${GHL_BASE}/contacts/?${searchParams.toString()}`, { headers });
    if (!contactsRes.ok) {
      return res.status(502).json({ error: `GHL /contacts respondio ${contactsRes.status}` });
    }
    const contactsData: any = await contactsRes.json();
    contacts = Array.isArray(contactsData?.contacts) ? contactsData.contacts : [];
  }

  const resultados = [];
  for (const c of contacts) {
    const contactRes = await fetch(`${GHL_BASE}/contacts/${c.id}`, { headers });
    const contactBody: any = contactRes.ok ? await contactRes.json() : null;
    const contactFull = contactBody?.contact ?? c;
    const oppParams = new URLSearchParams({
      location_id: locationId,
      pipeline_id: PIPELINE_ID,
      contact_id: c.id,
      status: "all",
      limit: "20",
    });
    const oppRes = await fetch(`${GHL_BASE}/opportunities/search?${oppParams.toString()}`, { headers });
    const oppData: any = oppRes.ok ? await oppRes.json() : null;
    const opportunities: any[] = Array.isArray(oppData?.opportunities) ? oppData.opportunities : [];
    const propias = opportunities.filter((o) => o.contactId === c.id);

    resultados.push({
      contactId: c.id,
      nombre: contactFull.contactName || `${contactFull.firstName ?? ""} ${contactFull.lastName ?? ""}`.trim(),
      telefono: contactFull.phone,
      contactoAsignadoA: contactFull.assignedTo,
      customFields: contactFull.customFields,
      totalOpportunitiesDevueltas: opportunities.length,
      opportunitiesDeEsteContacto: propias.map((o) => ({
        id: o.id,
        pipelineStageId: o.pipelineStageId,
        esEtapaFtd: o.pipelineStageId === FTD_STAGE_ID,
        opportunityAsignadaA: o.assignedTo,
        createdAt: o.createdAt,
        lastStageChangeAt: o.lastStageChangeAt,
        updatedAt: o.updatedAt,
      })),
    });
  }

  return res.status(200).json({
    query: nombre || contactId || opportunityId,
    encontrados: resultados.length,
    resultados,
  });
}
