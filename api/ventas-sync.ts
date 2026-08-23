import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getSupabase } from "./_lib/supabase";
import { resolveEmpresaFromSecret } from "./_lib/tenant";
import { sincronizarVentasEmpresa } from "./_lib/ventasSheet";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const supabase = getSupabase();
  const providedSecret = typeof req.query.key === "string" ? req.query.key : "";
  const empresa = await resolveEmpresaFromSecret(supabase, providedSecret);
  if (!empresa) {
    return res.status(401).json({ error: "No autorizado. Agregá ?key=TU_WEBHOOK_SECRET a la URL." });
  }

  const credsJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  const sheetId = empresa.ventasSheetId;
  if (!credsJson || !sheetId) {
    return res.status(500).json({ error: "Falta GOOGLE_SERVICE_ACCOUNT_JSON en Vercel o ventas_sheet_id para esta empresa" });
  }

  const mesParam = typeof req.query.mes === "string" ? req.query.mes.trim() : "";

  try {
    const resultado = await sincronizarVentasEmpresa(
      supabase, empresa.id, sheetId, empresa.ventasDirectorEmails, credsJson, mesParam || undefined
    );
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json(resultado);
  } catch (err: any) {
    const mensaje = err?.message || "Error sincronizando ventas";
    const status = mensaje.startsWith("Ya hay una sincronizacion") ? 409 : 502;
    return res.status(status).json({ error: mensaje });
  }
}
