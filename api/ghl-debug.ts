import type { VercelRequest, VercelResponse } from "@vercel/node";

const GHL_BASE = "https://services.leadconnectorhq.com";
const GHL_VERSION = "2021-07-28";
const PIPELINE_ID = "oRjd1pUxOgNbzkdLBjWC";
const REGISTRADO_STAGE = "09b221aa-9791-4f05-8869-1b4ac8c86e06";

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

  const params = new URLSearchParams({
    location_id: locationId,
    pipeline_id: PIPELINE_ID,
    pipeline_stage_id: REGISTRADO_STAGE,
    limit: "5",
  });

  const r = await fetch(`${GHL_BASE}/opportunities/search?${params.toString()}`, { headers });
  const body = await r.json().catch(() => ({ parseError: true }));

  return res.status(200).json({
    intento: "GET /opportunities/search filtrado por pipeline+stage",
    urlUsada: `${GHL_BASE}/opportunities/search?${params.toString()}`,
    status: r.status,
    respuesta: body,
  });
}
