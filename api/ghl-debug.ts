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

  const [contactsRes, usersRes] = await Promise.all([
    fetch(`${GHL_BASE}/contacts/?locationId=${locationId}&limit=5`, { headers }),
    fetch(`${GHL_BASE}/users/?locationId=${locationId}`, { headers }),
  ]);

  const contactsBody = await contactsRes.json().catch(() => ({ parseError: true }));
  const usersBody = await usersRes.json().catch(() => ({ parseError: true }));

  return res.status(200).json({
    contacts: { status: contactsRes.status, body: contactsBody },
    users: { status: usersRes.status, body: usersBody },
  });
}
