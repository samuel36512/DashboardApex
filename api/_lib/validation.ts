export interface EventoPayload {
  contacto_id: string;
  agente: string;
  fecha: string;
  monto?: number;
}

export function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const aBytes = enc.encode(a);
  const bBytes = enc.encode(b);
  if (aBytes.length !== bBytes.length) return false;
  let result = 0;
  for (let i = 0; i < aBytes.length; i++) result |= aBytes[i] ^ bBytes[i];
  return result === 0;
}

export function parsePayload(
  body: unknown
): { ok: true; data: EventoPayload } | { ok: false; error: string } {
  if (typeof body !== "object" || body === null) {
    return { ok: false, error: "El body debe ser un objeto JSON" };
  }
  const b = body as Record<string, unknown>;

  if (typeof b.contacto_id !== "string" || b.contacto_id.trim() === "") {
    return { ok: false, error: "contacto_id es requerido y debe ser texto" };
  }
  if (typeof b.agente !== "string" || b.agente.trim() === "") {
    return { ok: false, error: "agente es requerido y debe ser texto" };
  }

  let fecha: string;
  if (b.fecha !== undefined && b.fecha !== null && b.fecha !== "") {
    if (typeof b.fecha !== "string" || Number.isNaN(Date.parse(b.fecha))) {
      return { ok: false, error: "fecha debe ser una fecha valida (ISO 8601) si se envia" };
    }
    fecha = b.fecha;
  } else {
    // GHL no siempre resuelve el merge tag de fecha; usamos la hora del servidor como fallback.
    fecha = new Date().toISOString();
  }

  let monto: number | undefined;
  if (b.monto !== undefined && b.monto !== null && b.monto !== "") {
    if (typeof b.monto !== "number" && typeof b.monto !== "string") {
      return { ok: false, error: "monto debe ser numero" };
    }
    const n = typeof b.monto === "number" ? b.monto : Number(b.monto);
    if (!Number.isFinite(n) || n < 0) {
      return { ok: false, error: "monto debe ser un numero positivo" };
    }
    monto = n;
  }

  return {
    ok: true,
    data: { contacto_id: b.contacto_id.trim(), agente: b.agente.trim(), fecha, monto },
  };
}
