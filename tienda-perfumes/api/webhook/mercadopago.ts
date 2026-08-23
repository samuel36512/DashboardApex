import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createHmac } from "crypto";
import { getSupabase } from "../_lib/supabase";
import { obtenerPago } from "../_lib/mercadopago";
import { enviarEmail } from "../_lib/email";
import { timingSafeEqual } from "../_lib/auth";

// Verifica la firma x-signature que manda Mercado Pago, siguiendo su
// esquema documentado (template "id:{data.id};request-id:{x-request-id};ts:{ts};"
// firmado con HMAC-SHA256 usando el secret del webhook). Si no configuraste
// MP_WEBHOOK_SECRET, se salta la verificación (igual funciona, pero
// cualquiera podría intentar pegarle a este endpoint con datos falsos).
function firmaValida(req: VercelRequest, dataId: string): boolean {
  const secret = process.env.MP_WEBHOOK_SECRET;
  if (!secret) return true;

  const signatureHeader = req.headers["x-signature"];
  const requestIdHeader = req.headers["x-request-id"];
  const signature = Array.isArray(signatureHeader) ? signatureHeader[0] : signatureHeader;
  const requestId = Array.isArray(requestIdHeader) ? requestIdHeader[0] : requestIdHeader;
  if (!signature || !requestId) return false;

  const partes = Object.fromEntries(
    signature.split(",").map((par) => {
      const [k, v] = par.split("=");
      return [k?.trim(), v?.trim()];
    })
  );
  const ts = partes.ts;
  const v1 = partes.v1;
  if (!ts || !v1) return false;

  const template = `id:${dataId.toLowerCase()};request-id:${requestId};ts:${ts};`;
  const esperado = createHmac("sha256", secret).update(template).digest("hex");
  return timingSafeEqual(esperado, v1);
}

function extraerDataId(req: VercelRequest): string | null {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const data = body.data as Record<string, unknown> | undefined;
  if (data?.id) return String(data.id);

  const queryDataId = req.query["data.id"];
  if (typeof queryDataId === "string") return queryDataId;

  const queryId = req.query.id;
  if (typeof queryId === "string") return queryId;

  return null;
}

function extraerTipo(req: VercelRequest): string {
  const body = (req.body ?? {}) as Record<string, unknown>;
  if (typeof body.type === "string") return body.type;
  const topic = req.query.topic;
  return typeof topic === "string" ? topic : "";
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const tipo = extraerTipo(req);
  if (tipo !== "payment") {
    // Mercado Pago manda otros tipos de eventos (merchant_order, etc.) que
    // no nos interesan acá: respondemos 200 para que no reintente.
    return res.status(200).json({ ok: true });
  }

  const dataId = extraerDataId(req);
  if (!dataId) {
    return res.status(400).json({ error: "Falta data.id en la notificación" });
  }

  if (!firmaValida(req, dataId)) {
    return res.status(401).json({ error: "Firma inválida" });
  }

  const supabase = getSupabase();

  let pago;
  try {
    pago = await obtenerPago(dataId);
  } catch {
    return res.status(502).json({ error: "No se pudo consultar el pago en Mercado Pago" });
  }

  const pedidoId = Number(pago.external_reference);
  if (!Number.isInteger(pedidoId)) {
    return res.status(200).json({ ok: true });
  }

  const nuevoEstado = pago.status === "approved" ? "pagado" : pago.status === "rejected" ? "fallido" : "pendiente";

  const { data: pedido, error: updateError } = await supabase
    .from("pedidos")
    .update({ estado: nuevoEstado, mp_payment_id: dataId, actualizado_en: new Date().toISOString() })
    .eq("id", pedidoId)
    // No pisar un pedido que ya estaba "pagado" (evita reenviar el email al
    // proveedor si Mercado Pago reintenta la misma notificación).
    .neq("estado", "pagado")
    .select("*")
    .maybeSingle();

  if (updateError) {
    return res.status(500).json({ error: "Error actualizando el pedido" });
  }

  if (pedido && nuevoEstado === "pagado") {
    await notificarPagoAprobado(pedido);
  }

  return res.status(200).json({ ok: true });
}

async function notificarPagoAprobado(pedido: Record<string, unknown>) {
  const items = pedido.items as { nombre: string; cantidad: number; precio_unitario: number }[];
  const direccion = pedido.direccion as Record<string, string>;
  const filas = items
    .map((i) => `<tr><td>${i.nombre}</td><td>${i.cantidad}</td><td>$${i.precio_unitario}</td></tr>`)
    .join("");

  const proveedorEmail = process.env.PROVEEDOR_EMAIL;
  if (proveedorEmail) {
    await enviarEmail({
      to: proveedorEmail,
      subject: `Nuevo pedido pagado #${pedido.id}`,
      html: `
        <h2>Pedido #${pedido.id} — para despachar</h2>
        <p><b>Cliente:</b> ${pedido.cliente_nombre} — ${pedido.cliente_email} — ${pedido.cliente_telefono ?? "sin teléfono"}</p>
        <p><b>Dirección:</b> ${direccion.calle}, ${direccion.ciudad}, ${direccion.provincia}, CP ${direccion.cp}, ${direccion.pais}</p>
        <table border="1" cellpadding="6" cellspacing="0">
          <tr><th>Producto</th><th>Cantidad</th><th>Precio</th></tr>
          ${filas}
        </table>
        <p><b>Total:</b> $${pedido.total}</p>
      `,
    });
  }

  await enviarEmail({
    to: pedido.cliente_email as string,
    subject: `Confirmamos tu pedido #${pedido.id}`,
    html: `
      <h2>¡Gracias por tu compra, ${pedido.cliente_nombre}!</h2>
      <p>Tu pago fue aprobado y ya estamos preparando tu pedido #${pedido.id}.</p>
      <table border="1" cellpadding="6" cellspacing="0">
        <tr><th>Producto</th><th>Cantidad</th><th>Precio</th></tr>
        ${filas}
      </table>
      <p><b>Total:</b> $${pedido.total}</p>
    `,
  });
}
