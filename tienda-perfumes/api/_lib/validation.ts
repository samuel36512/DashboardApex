export interface Direccion {
  calle: string;
  ciudad: string;
  provincia: string;
  cp: string;
  pais: string;
}

export interface CheckoutPayload {
  cliente_nombre: string;
  cliente_email: string;
  cliente_telefono?: string;
  direccion: Direccion;
  items: { producto_id: number; cantidad: number }[];
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function requireString(value: unknown, campo: string): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof value !== "string" || value.trim() === "") {
    return { ok: false, error: `${campo} es requerido` };
  }
  return { ok: true, value: value.trim() };
}

export function parseCheckoutPayload(
  body: unknown
): { ok: true; data: CheckoutPayload } | { ok: false; error: string } {
  if (typeof body !== "object" || body === null) {
    return { ok: false, error: "El body debe ser un objeto JSON" };
  }
  const b = body as Record<string, unknown>;
  const cliente = (b.cliente ?? {}) as Record<string, unknown>;

  const nombre = requireString(cliente.nombre, "cliente.nombre");
  if (!nombre.ok) return nombre;

  const email = requireString(cliente.email, "cliente.email");
  if (!email.ok) return email;
  if (!EMAIL_RE.test(email.value)) return { ok: false, error: "cliente.email no es un email válido" };

  const direccionRaw = (cliente.direccion ?? {}) as Record<string, unknown>;
  const direccionCampos: (keyof Direccion)[] = ["calle", "ciudad", "provincia", "cp", "pais"];
  const direccion = {} as Direccion;
  for (const campo of direccionCampos) {
    const resultado = requireString(direccionRaw[campo], `cliente.direccion.${campo}`);
    if (!resultado.ok) return resultado;
    direccion[campo] = resultado.value;
  }

  if (!Array.isArray(b.items) || b.items.length === 0) {
    return { ok: false, error: "items debe ser un array con al menos un producto" };
  }
  const items: { producto_id: number; cantidad: number }[] = [];
  for (const raw of b.items) {
    const item = raw as Record<string, unknown>;
    const producto_id = Number(item.producto_id);
    const cantidad = Number(item.cantidad);
    if (!Number.isInteger(producto_id) || producto_id <= 0) {
      return { ok: false, error: "items[].producto_id debe ser un número entero válido" };
    }
    if (!Number.isInteger(cantidad) || cantidad <= 0 || cantidad > 50) {
      return { ok: false, error: "items[].cantidad debe ser un entero entre 1 y 50" };
    }
    items.push({ producto_id, cantidad });
  }

  const telefonoRaw = cliente.telefono;
  const telefono = typeof telefonoRaw === "string" && telefonoRaw.trim() !== "" ? telefonoRaw.trim() : undefined;

  return {
    ok: true,
    data: {
      cliente_nombre: nombre.value,
      cliente_email: email.value,
      cliente_telefono: telefono,
      direccion,
      items,
    },
  };
}
