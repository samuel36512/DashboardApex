export interface Env {
  DB: D1Database;
  WEBHOOK_SECRET: string;
  META_VENTAS_USD?: string;
}

type TipoEvento = "lead" | "registro" | "ftd" | "venta";

interface EventoPayload {
  contacto_id: string;
  agente: string;
  fecha: string;
  monto?: number;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const aBytes = enc.encode(a);
  const bBytes = enc.encode(b);
  if (aBytes.length !== bBytes.length) return false;
  let result = 0;
  for (let i = 0; i < aBytes.length; i++) result |= aBytes[i] ^ bBytes[i];
  return result === 0;
}

function isAuthorized(request: Request, env: Env): boolean {
  if (!env.WEBHOOK_SECRET) return false;
  const auth = request.headers.get("Authorization") ?? "";
  return timingSafeEqual(auth, `Bearer ${env.WEBHOOK_SECRET}`);
}

function parsePayload(
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
    // GHL no siempre resuelve el merge tag de fecha de forma confiable; usamos la hora del servidor como fallback.
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

async function handleWebhook(request: Request, env: Env, tipo: TipoEvento): Promise<Response> {
  if (!isAuthorized(request, env)) {
    return json({ error: "No autorizado" }, 401);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Body invalido, se esperaba JSON" }, 400);
  }

  const parsed = parsePayload(body);
  if (!parsed.ok) {
    return json({ error: parsed.error }, 400);
  }

  const { contacto_id, agente, fecha, monto } = parsed.data;
  if ((tipo === "ftd" || tipo === "venta") && monto === undefined) {
    return json({ error: `monto es requerido para el evento ${tipo}` }, 400);
  }

  // UNIQUE(contacto_id, tipo) + upsert: si GHL reenvia el mismo evento (retry) actualiza en vez de duplicar el conteo.
  await env.DB.prepare(
    `INSERT INTO eventos (contacto_id, agente, tipo, monto, fecha)
     VALUES (?1, ?2, ?3, ?4, ?5)
     ON CONFLICT(contacto_id, tipo) DO UPDATE SET
       agente = excluded.agente,
       monto = excluded.monto,
       fecha = excluded.fecha`
  )
    .bind(contacto_id, agente, tipo, monto ?? null, fecha)
    .run();

  return json({ ok: true, tipo, contacto_id }, 201);
}

interface MetricsRow {
  agente: string;
  leads: number;
  registros: number;
  ftds: number;
  ventasUSD: number;
}

async function handleMetrics(env: Env): Promise<Response> {
  const { results } = await env.DB.prepare(
    `SELECT
       agente,
       SUM(CASE WHEN tipo = 'lead' THEN 1 ELSE 0 END) AS leads,
       SUM(CASE WHEN tipo = 'registro' THEN 1 ELSE 0 END) AS registros,
       SUM(CASE WHEN tipo = 'ftd' THEN 1 ELSE 0 END) AS ftds,
       SUM(CASE WHEN tipo = 'venta' THEN monto ELSE 0 END) AS ventasUSD
     FROM eventos
     GROUP BY agente
     ORDER BY agente COLLATE NOCASE`
  ).all<MetricsRow>();

  const pct = (num: number, den: number) => (den > 0 ? Math.round((num / den) * 10000) / 100 : 0);

  const agentes = (results ?? []).map((row) => ({
    agente: row.agente,
    leads: row.leads,
    registros: row.registros,
    ftds: row.ftds,
    ventasUSD: row.ventasUSD,
    conversion: {
      leadToRegistro: pct(row.registros, row.leads),
      registroToFtd: pct(row.ftds, row.registros),
      leadToFtd: pct(row.ftds, row.leads),
    },
  }));

  return json({
    agentes,
    metaVentasUSD: Number(env.META_VENTAS_USD ?? 2400),
    actualizado: new Date().toISOString(),
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
        },
      });
    }

    if (request.method === "POST" && url.pathname === "/webhook/lead") {
      return handleWebhook(request, env, "lead");
    }
    if (request.method === "POST" && url.pathname === "/webhook/registro") {
      return handleWebhook(request, env, "registro");
    }
    if (request.method === "POST" && url.pathname === "/webhook/ftd") {
      return handleWebhook(request, env, "ftd");
    }
    if (request.method === "POST" && url.pathname === "/webhook/venta") {
      return handleWebhook(request, env, "venta");
    }
    if (request.method === "GET" && url.pathname === "/metrics") {
      return handleMetrics(env);
    }

    return json({ error: "Not found" }, 404);
  },
};
