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
  };

  const targetTags = ["ftd-efectuado", "registrado"];

  const [contactsRes, fieldsRes] = await Promise.all([
    fetch(`${GHL_BASE}/contacts/?locationId=${locationId}&limit=100`, { headers }),
    fetch(`${GHL_BASE}/locations/${locationId}/customFields`, { headers }),
  ]);

  const contactsBody: any = await contactsRes.json().catch(() => ({ parseError: true }));
  const fieldsBody = await fieldsRes.json().catch(() => ({ parseError: true }));

  const allContacts: any[] = Array.isArray(contactsBody?.contacts) ? contactsBody.contacts : [];
  const matchingContacts = allContacts
    .filter((c) => Array.isArray(c.tags) && c.tags.some((t: string) => targetTags.includes(t)))
    .map((c) => ({
      id: c.id,
      tags: c.tags,
      assignedTo: c.assignedTo,
      customFields: c.customFields,
    }));

  return res.status(200).json({
    totalContactsFetched: allContacts.length,
    matchingContacts,
    customFieldDefinitions: { status: fieldsRes.status, body: fieldsBody },
  });
}
