import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getSupabase } from "./_lib/supabase";

const GHL_BASE = "https://services.leadconnectorhq.com";
const GHL_VERSION = "2021-07-28";
const JHON_ID = "b8GjMwrGyLZnWd7S9PXT";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const secret = process.env.WEBHOOK_SECRET;
  if (!secret || req.query.key !== secret) {
    return res.status(401).json({ error: "No autorizado. Agregá ?key=TU_WEBHOOK_SECRET a la URL." });
  }

  const token = process.env.GHL_API_TOKEN;
  if (!token) {
    return res.status(500).json({ error: "Falta GHL_API_TOKEN en Vercel" });
  }

  const supabase = getSupabase();
  const { data: rows, error } = await supabase
    .from("eventos")
    .select("contacto_id")
    .eq("agente", "Jhon Camacho")
    .eq("tipo", "registro");
  if (error) {
    return res.status(500).json({ error: error.message });
  }

  const headers = {
    Authorization: `Bearer ${token}`,
    Version: GHL_VERSION,
    Accept: "application/json",
  };

  const todos = rows ?? [];
  const resultados: any[] = [];
  const BATCH = 10;
  for (let i = 0; i < todos.length; i += BATCH) {
    const lote = todos.slice(i, i + BATCH);
    const resLote = await Promise.all(
      lote.map(async (row) => {
        const r = await fetch(`${GHL_BASE}/contacts/${row.contacto_id}`, { headers });
        const body: any = await r.json().catch(() => ({}));
        const contact = body?.contact;
        return {
          contacto_id: row.contacto_id,
          nombre: contact?.contactName,
          assignedTo: contact?.assignedTo,
          esDeJhon: contact?.assignedTo === JHON_ID,
        };
      })
    );
    resultados.push(...resLote);
  }

  const deJhon = resultados.filter((r) => r.esDeJhon).length;
  const deOtro = resultados.filter((r) => !r.esDeJhon);

  return res.status(200).json({
    totalContactosEnDB: todos.length,
    confirmadosDeJhon: deJhon,
    noSonDeJhon: deOtro.length,
    ejemplosQueNoSonDeJhon: deOtro.slice(0, 15),
  });
}
