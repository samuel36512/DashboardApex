import { MercadoPagoConfig, Preference, Payment } from "mercadopago";

function getClient(): MercadoPagoConfig {
  const accessToken = process.env.MP_ACCESS_TOKEN;
  if (!accessToken) {
    throw new Error("Falta la variable de entorno MP_ACCESS_TOKEN");
  }
  return new MercadoPagoConfig({ accessToken });
}

export interface PreferenceItem {
  id: string;
  title: string;
  quantity: number;
  unit_price: number;
}

// external_reference = pedido.id: así el webhook sabe a qué pedido nuestro
// corresponde el pago, sin depender del orden en que lleguen las notificaciones.
export async function crearPreferencia(opts: {
  pedidoId: number;
  items: PreferenceItem[];
  siteUrl: string;
}): Promise<{ id: string; init_point: string }> {
  const preference = new Preference(getClient());
  const resultado = await preference.create({
    body: {
      items: opts.items,
      external_reference: String(opts.pedidoId),
      back_urls: {
        success: `${opts.siteUrl}/gracias.html?pedido=${opts.pedidoId}`,
        pending: `${opts.siteUrl}/gracias.html?pedido=${opts.pedidoId}`,
        failure: `${opts.siteUrl}/gracias.html?pedido=${opts.pedidoId}`,
      },
      auto_return: "approved",
      notification_url: `${opts.siteUrl}/webhook/mercadopago`,
    },
  });

  if (!resultado.id || !resultado.init_point) {
    throw new Error("Mercado Pago no devolvió una preferencia válida");
  }
  return { id: resultado.id, init_point: resultado.init_point };
}

export async function obtenerPago(paymentId: string) {
  const payment = new Payment(getClient());
  return payment.get({ id: paymentId });
}
