import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getSupabase } from "../_lib/supabase";
import { parsePayload } from "../_lib/validation";
import { resolveEmpresaFromSecret } from "../_lib/tenant";

const TIPOS = new Set(["lead", "registro", "ftd", "venta"]);

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const tipo = String(req.query.tipo);
  if (!TIPOS.has(tipo)) {
    return res.status(404).json({ error: "Not found" });
  }

  const authHeader = req.headers.authorization ?? "";
  const providedSecret = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  const supabase = getSupabase();
  const empresa = await resolveEmpresaFromSecret(supabase, providedSecret);
  if (!empresa) {
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

  // upsert por (empresa_id, contacto_id, tipo): si GHL reenvia el mismo evento (retry) actualiza en vez de duplicar el conteo.
  const { error } = await supabase
    .from("eventos")
    .upsert(
      { contacto_id, agente, tipo, monto: monto ?? null, fecha, empresa_id: empresa.id },
      { onConflict: "empresa_id,contacto_id,tipo" }
    );

  if (error) {
    return res.status(500).json({ error: "Error guardando el evento" });
  }

  return res.status(201).json({ ok: true, tipo, contacto_id });
}
