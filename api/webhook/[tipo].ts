import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getSupabase } from "../_lib/supabase";
import { parsePayload, timingSafeEqual } from "../_lib/validation";
import { EMPRESA_ID_ACTUAL } from "../_lib/empresaActual";

const TIPOS = new Set(["lead", "registro", "ftd", "venta"]);

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const tipo = String(req.query.tipo);
  if (!TIPOS.has(tipo)) {
    return res.status(404).json({ error: "Not found" });
  }

  const secret = process.env.WEBHOOK_SECRET;
  const auth = req.headers.authorization ?? "";
  if (!secret || !timingSafeEqual(auth, `Bearer ${secret}`)) {
    return res.status(401).json({ error: "No autorizado" });
  }

  const parsed = parsePayload(req.body);
  if (!parsed.ok) {
    return res.status(400).json({ error: parsed.error });
  }

  const { contacto_id, agente, fecha, monto } = parsed.data;
  if ((tipo === "ftd" || tipo === "venta") && monto === undefined) {
    return res.status(400).json({ error: `monto es requerido para el evento ${tipo}` });
  }

  const supabase = getSupabase();
  // upsert por (contacto_id, tipo): si GHL reenvia el mismo evento (retry) actualiza en vez de duplicar el conteo.
  const { error } = await supabase
    .from("eventos")
    .upsert(
      { contacto_id, agente, tipo, monto: monto ?? null, fecha, empresa_id: EMPRESA_ID_ACTUAL },
      { onConflict: "contacto_id,tipo" }
    );

  if (error) {
    return res.status(500).json({ error: "Error guardando el evento" });
  }

  return res.status(201).json({ ok: true, tipo, contacto_id });
}
