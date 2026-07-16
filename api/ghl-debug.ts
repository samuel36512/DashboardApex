import type { VercelRequest, VercelResponse } from "@vercel/node";

const GHL_BASE = "https://services.leadconnectorhq.com";
const GHL_VERSION = "2021-07-28";
const PIPELINE_ID = "oRjd1pUxOgNbzkdLBjWC";
const FTD_STAGE_ID = "3796b590-4fa6-4ef9-9b27-4aca989f6fd3";
const HENRY_ID = "VeVKUZI50c8Fjvv2sHWI";

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

  const todasParams = new URLSearchParams({
    location_id: locationId,
    pipeline_id: PIPELINE_ID,
    assigned_to: HENRY_ID,
    limit: "1",
  });
  const ftdParams = new URLSearchParams({
    location_id: locationId,
    pipeline_id: PIPELINE_ID,
    pipeline_stage_id: FTD_STAGE_ID,
    assigned_to: HENRY_ID,
    limit: "1",
  });

  const [todasRes, ftdRes] = await Promise.all([
    fetch(`${GHL_BASE}/opportunities/search?${todasParams.toString()}`, { headers }),
    fetch(`${GHL_BASE}/opportunities/search?${ftdParams.toString()}`, { headers }),
  ]);
  const todasBody: any = await todasRes.json().catch(() => ({ parseError: true }));
  const ftdBody: any = await ftdRes.json().catch(() => ({ parseError: true }));

  return res.status(200).json({
    todasLasEtapas: { status: todasRes.status, total: todasBody?.meta?.total, url: todasParams.toString() },
    soloFtdEfectuado: { status: ftdRes.status, total: ftdBody?.meta?.total, url: ftdParams.toString() },
  });
}
