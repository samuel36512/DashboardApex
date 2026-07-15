import type { VercelRequest, VercelResponse } from "@vercel/node";

const GHL_BASE = "https://services.leadconnectorhq.com";
const GHL_VERSION = "2021-07-28";

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
    "Content-Type": "application/json",
  };

  // Intento 1: buscar contactos por tag directamente, sin depender del orden de creación.
  const searchBody = {
    locationId,
    pageLimit: 20,
    filters: [{ field: "tags", operator: "contains", value: "registrado" }],
    sort: [{ field: "dateUpdated", direction: "desc" }],
  };

  const searchRes = await fetch(`${GHL_BASE}/contacts/search`, {
    method: "POST",
    headers,
    body: JSON.stringify(searchBody),
  });
  const searchBodyResult = await searchRes.json().catch(() => ({ parseError: true }));

  return res.status(200).json({
    intento: "POST /contacts/search con filtro de tag",
    requestEnviado: searchBody,
    status: searchRes.status,
    respuesta: searchBodyResult,
  });
}
