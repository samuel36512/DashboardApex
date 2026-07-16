import type { VercelRequest, VercelResponse } from "@vercel/node";

const GHL_BASE = "https://services.leadconnectorhq.com";
const GHL_VERSION = "2021-07-28";
const PIPELINE_ID = "oRjd1pUxOgNbzkdLBjWC";
const FTD_STAGE_ID = "3796b590-4fa6-4ef9-9b27-4aca989f6fd3";

// Busca un cliente por nombre directo en GHL y muestra sus oportunidades en
// el pipeline principal (etapa, fechas, dueno asignado), para diagnosticar
// casos puntuales sin tener que adivinar por que un registro/ftd no aparece.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const secret = process.env.WEBHOOK_SECRET;
  if (!secret || req.query.key !== secret) {
    return res.status(401).json({ error: "No autorizado. Agregá ?key=TU_WEBHOOK_SECRET a la URL." });
  }

  const nombre = typeof req.query.nombre === "string" ? req.query.nombre.trim() : "";
  if (!nombre) {
    return res.status(400).json({ error: "Agregá ?nombre=NombreDelCliente a la URL" });
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

  const searchParams = new URLSearchParams({ locationId, query: nombre, limit: "10" });
  const contactsRes = await fetch(`${GHL_BASE}/contacts/?${searchParams.toString()}`, { headers });
  if (!contactsRes.ok) {
    return res.status(502).json({ error: `GHL /contacts respondio ${contactsRes.status}` });
  }
  const contactsData: any = await contactsRes.json();
  const contacts: any[] = Array.isArray(contactsData?.contacts) ? contactsData.contacts : [];

  const resultados = [];
  for (const c of contacts) {
    const oppParams = new URLSearchParams({
      location_id: locationId,
      pipeline_id: PIPELINE_ID,
      contact_id: c.id,
      limit: "20",
    });
    const oppRes = await fetch(`${GHL_BASE}/opportunities/search?${oppParams.toString()}`, { headers });
    const oppData: any = oppRes.ok ? await oppRes.json() : null;
    const opportunities: any[] = Array.isArray(oppData?.opportunities) ? oppData.opportunities : [];
    const propias = opportunities.filter((o) => o.contactId === c.id);

    resultados.push({
      contactId: c.id,
      nombre: c.contactName || `${c.firstName ?? ""} ${c.lastName ?? ""}`.trim(),
      contactoAsignadoA: c.assignedTo,
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

  return res.status(200).json({ query: nombre, encontrados: resultados.length, resultados });
}
