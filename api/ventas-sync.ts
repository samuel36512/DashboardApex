import type { VercelRequest, VercelResponse } from "@vercel/node";
import crypto from "crypto";
import { getSupabase } from "./_lib/supabase";

const SHEETS_BASE = "https://sheets.googleapis.com/v4/spreadsheets";

// Alias conocidos: nombre EXACTO (normalizado) tal como aparece en la
// columna AGENTE de la hoja de ventas -> nombre real en nuestra tabla
// agentes. La hoja es de TODA la empresa (decenas de personas que no son
// nuestros agentes de ventas), asi que solo mapeamos lo que el director
// confirmo explicitamente - cualquier otro nombre se ignora y se reporta
// como "no reconocido" en vez de adivinar.
const AGENTE_ALIASES: Record<string, string> = {
  "nicolas andres correa rojas": "Nicolás Correa",
  "maria paula guevara valencia valencia": "María Paula Guevara",
  "juan sebastian ceballos": "Juan Ceballos",
  "diego alejandro mora ruiz": "Diego Alejandro Mora",
  "henry andres correa rojas": "Henry Andrés Correa",
  "santiago santiago charry gutierrez": "Santiago Charry",
  "daniela charry perdomo": "Daniela Charry",
  "luna sandoval jovel": "Luna Sandoval",
  "sergio gallo": "Sergio Gallo",
  "angela maria galinded gutierrez": "Angela Galindez",
  "angela maria galindez gutierrez": "Angela Galindez",
  "jhon andres camacho aldana": "Jhon Camacho",
  "santiago sandoval": "Santiago Sandoval",
  "santiago sandoval andrade": "Santiago Sandoval",
  "fernando sandoval andrade": "Fernando Sandoval",
  "andry juliana camacho sanchez": "Andry Camacho",
  "gabriel monteverde": "Gabriel Alejandro Monteverde",
  "luis felipe charry perdomo": "Luis Felipe Charry",
  "luis gomez": "Luis Gómez",
};

const MESES_TAB = [
  "Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio",
  "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre",
];
const MESES_FECHA: Record<string, number> = {
  ene: 0, feb: 1, mar: 2, abr: 3, may: 4, jun: 5,
  jul: 6, ago: 7, sep: 8, oct: 9, nov: 10, dic: 11,
};

function normalizar(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function coincidePorPalabras(sheetNombreNorm: string, agenteNombre: string): boolean {
  const palabrasAgente = normalizar(agenteNombre).split(" ");
  const palabrasSheet = sheetNombreNorm.split(" ");
  return palabrasAgente.every((p) => palabrasSheet.includes(p));
}

function mapearAgente(sheetNombre: string, agentesActivos: string[]): string | null {
  const norm = normalizar(sheetNombre);
  if (AGENTE_ALIASES[norm]) return AGENTE_ALIASES[norm];
  for (const nombre of agentesActivos) {
    if (coincidePorPalabras(norm, nombre)) return nombre;
  }
  return null;
}

// La hoja solo trae el dia (ej. "1 jul 2026"), sin hora - se usa el
// mediodia UTC como instante representativo para que nunca caiga en el dia
// equivocado sin importar la zona horaria desde la que se filtre despues.
function parseFechaSheet(s: string): string | null {
  const m = s.trim().toLowerCase().match(/^(\d{1,2})\s+([a-z]{3})\s+(\d{4})$/);
  if (!m) return null;
  const mes = MESES_FECHA[m[2]];
  if (mes === undefined) return null;
  return new Date(Date.UTC(Number(m[3]), mes, Number(m[1]), 12, 0, 0)).toISOString();
}

function parsePrecio(s: string): number {
  return Number(String(s).replace(/[^0-9.-]/g, "")) || 0;
}

function idVenta(orden: string, cliente: string, fecha: string, producto: string, precio: string): string {
  if (orden) return `venta-${orden}`;
  const base = `${cliente}|${fecha}|${producto}|${precio}`;
  return `venta-${crypto.createHash("sha1").update(base).digest("hex").slice(0, 16)}`;
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function getAccessToken(credsJson: string): Promise<string> {
  const creds = JSON.parse(credsJson);
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(
    JSON.stringify({
      iss: creds.client_email,
      scope: "https://www.googleapis.com/auth/spreadsheets.readonly",
      aud: creds.token_uri,
      exp: now + 3600,
      iat: now,
    })
  );
  const unsigned = `${header}.${claims}`;
  const signature = crypto.sign("RSA-SHA256", Buffer.from(unsigned), creds.private_key);
  const jwt = `${unsigned}.${b64url(signature)}`;

  const r = await fetch(creds.token_uri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }).toString(),
  });
  if (!r.ok) throw new Error(`No se pudo autenticar con Google (${r.status})`);
  const data: any = await r.json();
  return data.access_token;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const secret = process.env.WEBHOOK_SECRET;
  if (!secret || req.query.key !== secret) {
    return res.status(401).json({ error: "No autorizado. Agregá ?key=TU_WEBHOOK_SECRET a la URL." });
  }

  const credsJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  const sheetId = process.env.VENTAS_SHEET_ID;
  if (!credsJson || !sheetId) {
    return res.status(500).json({ error: "Faltan GOOGLE_SERVICE_ACCOUNT_JSON o VENTAS_SHEET_ID en Vercel" });
  }

  const supabase = getSupabase();

  try {
    const token = await getAccessToken(credsJson);

    const { data: agentesRows, error: agentesError } = await supabase
      .from("agentes")
      .select("nombre")
      .eq("activo", true);
    if (agentesError) throw new Error(`Error leyendo agentes: ${agentesError.message}`);
    const agentesActivos = (agentesRows ?? []).map((a) => a.nombre);

    const ahora = new Date();
    const tabName = `${MESES_TAB[ahora.getMonth()]} ventas plataforma`;

    const range = encodeURIComponent(`${tabName}!A1:J1500`);
    const valuesRes = await fetch(`${SHEETS_BASE}/${sheetId}/values/${range}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!valuesRes.ok) {
      const body = await valuesRes.text();
      throw new Error(`Google Sheets respondio ${valuesRes.status} pidiendo "${tabName}": ${body.slice(0, 300)}`);
    }
    const valuesData: any = await valuesRes.json();
    const filas: any[][] = valuesData.values ?? [];

    const headerIdx = filas.findIndex((f) => f[0] === "FECHA" && f[6] === "AGENTE");
    if (headerIdx === -1) {
      return res.status(502).json({ error: `No encontre la fila de encabezado ("FECHA"/"AGENTE") en la pestaña "${tabName}"` });
    }

    const rowsVenta: { contacto_id: string; agente: string; tipo: "venta"; monto: number; comision: number; fecha: string }[] = [];
    const noReconocidos = new Set<string>();
    let ultimaFechaValida = "";
    let sinFecha = 0;

    for (let i = headerIdx + 2; i < filas.length; i++) {
      const fila = filas[i];
      if (!fila || fila.every((c) => !c)) continue; // fila vacia

      const fechaCruda = (fila[0] || "").toString().trim();
      const cliente = (fila[1] || "").toString().trim();
      const producto = (fila[3] || fila[2] || "").toString().trim();
      const precioCrudo = (fila[4] || "").toString().trim();
      const agenteSheet = (fila[6] || "").toString().trim();
      const comisionCruda = (fila[7] || "").toString().trim();

      if (!cliente || !precioCrudo || !agenteSheet) continue;

      // Google Sheets devuelve "" en filas con la fecha visualmente
      // combinada con la de arriba - se arrastra la ultima fecha valida
      // vista en el orden en que vienen las filas.
      let fechaIso: string | null;
      if (fechaCruda) {
        fechaIso = parseFechaSheet(fechaCruda);
        if (fechaIso) ultimaFechaValida = fechaIso;
      } else {
        fechaIso = ultimaFechaValida || null;
      }
      if (!fechaIso) {
        sinFecha++;
        continue;
      }

      const agente = mapearAgente(agenteSheet, agentesActivos);
      if (!agente) {
        noReconocidos.add(agenteSheet);
        continue;
      }

      rowsVenta.push({
        contacto_id: idVenta((fila[5] || "").toString().trim(), cliente, fechaCruda, producto, precioCrudo),
        agente,
        tipo: "venta",
        monto: parsePrecio(precioCrudo),
        comision: parsePrecio(comisionCruda),
        fecha: fechaIso,
      });
    }

    if (rowsVenta.length > 0) {
      const CHUNK = 500;
      for (let i = 0; i < rowsVenta.length; i += CHUNK) {
        const { error } = await supabase
          .from("eventos")
          .upsert(rowsVenta.slice(i, i + CHUNK), { onConflict: "contacto_id,tipo" });
        if (error) throw new Error(`Error guardando ventas: ${error.message}`);
      }
    }

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({
      ok: true,
      pestana: tabName,
      filasLeidas: filas.length - headerIdx - 2,
      ventasGuardadas: rowsVenta.length,
      sinFecha,
      agentesNoReconocidos: Array.from(noReconocidos),
    });
  } catch (err: any) {
    return res.status(502).json({ error: err?.message || "Error sincronizando ventas" });
  }
}
