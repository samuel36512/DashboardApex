import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getSupabase } from "./_lib/supabase";
import { parseCheckoutPayload } from "./_lib/validation";
import { crearPreferencia, type PreferenceItem } from "./_lib/mercadopago";

function getSiteUrl(req: VercelRequest): string {
  if (process.env.SITE_URL) return process.env.SITE_URL.replace(/\/$/, "");
  const host = req.headers.host;
  return `https://${host}`;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const parsed = parseCheckoutPayload(req.body);
  if (!parsed.ok) {
    return res.status(400).json({ error: parsed.error });
  }
  const { cliente_nombre, cliente_email, cliente_telefono, direccion, items } = parsed.data;

  const supabase = getSupabase();

  // El precio y la disponibilidad siempre se recalculan server-side a partir
  // de la base: nunca se confía en un precio que venga del navegador.
  const productoIds = items.map((i) => i.producto_id);
  const { data: productos, error: productosError } = await supabase
    .from("productos")
    .select("id, nombre, precio")
    .in("id", productoIds)
    .eq("activo", true)
    .eq("disponible", true);

  if (productosError) {
    return res.status(500).json({ error: "Error consultando el catálogo" });
  }

  const productosPorId = new Map((productos ?? []).map((p) => [p.id, p]));
  const faltantes = productoIds.filter((id) => !productosPorId.has(id));
  if (faltantes.length > 0) {
    return res.status(400).json({ error: `Producto(s) no disponibles: ${faltantes.join(", ")}` });
  }

  const itemsPedido = items.map((item) => {
    const producto = productosPorId.get(item.producto_id)!;
    return {
      producto_id: producto.id,
      nombre: producto.nombre,
      precio_unitario: Number(producto.precio),
      cantidad: item.cantidad,
    };
  });
  const total = itemsPedido.reduce((sum, i) => sum + i.precio_unitario * i.cantidad, 0);

  const { data: pedido, error: pedidoError } = await supabase
    .from("pedidos")
    .insert({
      cliente_nombre,
      cliente_email,
      cliente_telefono: cliente_telefono ?? null,
      direccion,
      items: itemsPedido,
      total,
      estado: "pendiente",
    })
    .select("id")
    .single();

  if (pedidoError || !pedido) {
    return res.status(500).json({ error: "Error creando el pedido" });
  }

  const preferenceItems: PreferenceItem[] = itemsPedido.map((i) => ({
    id: String(i.producto_id),
    title: i.nombre,
    quantity: i.cantidad,
    unit_price: i.precio_unitario,
  }));

  try {
    const preferencia = await crearPreferencia({
      pedidoId: pedido.id,
      items: preferenceItems,
      siteUrl: getSiteUrl(req),
    });

    await supabase.from("pedidos").update({ mp_preference_id: preferencia.id }).eq("id", pedido.id);

    return res.status(201).json({ pedido_id: pedido.id, init_point: preferencia.init_point });
  } catch {
    await supabase.from("pedidos").update({ estado: "fallido" }).eq("id", pedido.id);
    return res.status(502).json({ error: "No se pudo iniciar el pago con Mercado Pago" });
  }
}
