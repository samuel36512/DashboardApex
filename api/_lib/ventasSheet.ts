import crypto from "node:crypto";

export const MESES_TAB = [
  "Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio",
  "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre",
];
const MESES_FECHA: Record<string, number> = {
  ene: 0, feb: 1, mar: 2, abr: 3, may: 4, jun: 5,
  jul: 6, ago: 7, sep: 8, oct: 9, nov: 10, dic: 11,
};

export function normalizar(s: string): string {
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

export function mapearAgente(
  sheetNombre: string,
  agentesActivos: string[],
  emailToAgente: Map<string, string>,
  aliasToAgente: Map<string, string>
): string | null {
  const candidatos = sheetNombre
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  const completo = sheetNombre.trim();
  if (completo && !candidatos.includes(completo)) candidatos.push(completo);
  if (candidatos.length === 0) return null;

  for (const candidato of candidatos) {
    const email = candidato.toLowerCase();
    const porEmail = emailToAgente.get(email);
    if (porEmail) return porEmail;
  }
  for (const candidato of candidatos) {
    const norm = normalizar(candidato);
    const porAlias = aliasToAgente.get(norm);
    if (porAlias) return porAlias;
  }
  for (const candidato of candidatos) {
    const norm = normalizar(candidato);
    for (const nombre of agentesActivos) {
      if (coincidePorPalabras(norm, nombre)) return nombre;
    }
  }
  return null;
}

// Roster/alias sigue siendo el metodo PRINCIPAL. Si el roster no reconoce el
// nombre y la empresa tiene ventasDirectorEmails configurado, se usa como
// respaldo: si la fila es de ese director (cualquiera de sus correos/
// variantes conocidas) y el nombre NO esta en agente_bloqueado, se toma el
// nombre de la columna AGENTE tal cual viene.
export function resolverAgente(
  agenteSheet: string,
  directorFilaRaw: string,
  agentesActivos: string[],
  emailToAgente: Map<string, string>,
  aliasToAgente: Map<string, string>,
  directorFiltroEmails: Set<string>,
  nombresBloqueados: Set<string>
): string | null {
  const porRoster = mapearAgente(agenteSheet, agentesActivos, emailToAgente, aliasToAgente);
  if (porRoster) return porRoster;
  if (directorFiltroEmails.size === 0) return null;
  const directorEmail =
    directorFilaRaw.split("\n").map((s) => s.trim()).filter(Boolean).pop()?.toLowerCase() || "";
  if (!directorFiltroEmails.has(directorEmail)) return null;
  const nombreCrudo = (agenteSheet.split("\n")[0] || agenteSheet).trim();
  if (nombresBloqueados.has(normalizar(nombreCrudo))) return null;
  return nombreCrudo;
}

export function parseFechaSheet(s: string): string | null {
  const m = s
    .trim()
    .toLowerCase()
    .match(/^(\d{1,2})\s+([a-z]{3})\s+(\d{4})(?:\s*,.*)?$/);
  if (!m) return null;
  const mes = MESES_FECHA[m[2]];
  if (mes === undefined) return null;
  return new Date(Date.UTC(Number(m[3]), mes, Number(m[1]), 12, 0, 0)).toISOString();
}

export function pareceCodigoOrden(s: string): boolean {
  return /^ord-\d{6,}/i.test(s.trim());
}

export function parsePrecio(s: string): number {
  return Number(String(s).replace(/[^0-9.-]/g, "")) || 0;
}

export function idVenta(orden: string, cliente: string, fecha: string, precio: string): string {
  if (orden) return `venta-${orden}`;
  const base = `${cliente}|${fecha}|${precio}`;
  return `venta-${crypto.createHash("sha1").update(base).digest("hex").slice(0, 16)}`;
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function getGoogleAccessToken(credsJson: string): Promise<string> {
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

export interface VentaSheetRow {
  contacto_id: string;
  agente: string;
  monto: number;
  comision: number;
  producto: string;
  contacto_nombre: string;
  fecha: string;
}

export interface LecturaVentasSheet {
  tabName: string;
  filasLeidas: number;
  rows: VentaSheetRow[];
  noReconocidos: string[];
  sinFecha: number;
  sinFechaConocidos: { agente: string; cliente: string; producto: string; fechaCruda: string }[];
  colisionesMismaCorrida: number;
}

// Lee y parsea una pestaña de ventas del sheet compartido, aplicando
// EXACTAMENTE la misma resolucion de agente que usa ventas-sync.ts (roster/
// alias + respaldo por director + bloqueados) - pensado para reusarse tanto
// en la sincronizacion real como en la conciliacion de solo lectura, para
// que las dos siempre esten de acuerdo.
export async function leerVentasDelSheet(opts: {
  sheetId: string;
  credsJson: string;
  tabName: string;
  agentesActivos: string[];
  emailToAgente: Map<string, string>;
  aliasToAgente: Map<string, string>;
  directorFiltroEmails: Set<string>;
  nombresBloqueados: Set<string>;
}): Promise<LecturaVentasSheet> {
  const token = await getGoogleAccessToken(opts.credsJson);
  const range = encodeURIComponent(`${opts.tabName}!A:J`);
  const valuesRes = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${opts.sheetId}/values/${range}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!valuesRes.ok) {
    const body = await valuesRes.text();
    throw new Error(`Google Sheets respondio ${valuesRes.status} pidiendo "${opts.tabName}": ${body.slice(0, 300)}`);
  }
  const valuesData: any = await valuesRes.json();
  const filas: any[][] = valuesData.values ?? [];

  const headerIdx = filas.findIndex((f) => f[0] === "FECHA" && f[6] === "AGENTE");
  if (headerIdx === -1) {
    throw new Error(`No encontre la fila de encabezado ("FECHA"/"AGENTE") en la pestaña "${opts.tabName}"`);
  }

  const rows: VentaSheetRow[] = [];
  const noReconocidos = new Set<string>();
  const idsVistos = new Set<string>();
  const sinFechaConocidos: { agente: string; cliente: string; producto: string; fechaCruda: string }[] = [];
  let ultimaFechaValida = "";
  let sinFecha = 0;
  let colisionesMismaCorrida = 0;

  for (let i = headerIdx + 2; i < filas.length; i++) {
    const fila = filas[i];
    if (!fila || fila.every((c) => !c)) continue;

    const fechaCruda = (fila[0] || "").toString().trim();
    const cliente = (fila[1] || "").toString().trim();
    let producto = (fila[3] || fila[2] || "").toString().trim();
    if (pareceCodigoOrden(producto)) producto = "";
    const precioCrudo = (fila[4] || "").toString().trim();
    const agenteSheet = (fila[6] || "").toString().trim();
    const comisionCruda = (fila[7] || "").toString().trim();

    if (!cliente || !precioCrudo || !agenteSheet) continue;

    const clienteId = cliente.split("\n").map((s: string) => s.trim()).filter(Boolean).pop() || cliente;
    const directorFilaRaw = (fila[8] || "").toString().trim();

    let fechaIso: string | null;
    if (fechaCruda) {
      fechaIso = parseFechaSheet(fechaCruda);
      if (fechaIso) ultimaFechaValida = fechaIso;
    } else {
      fechaIso = ultimaFechaValida || null;
    }
    if (!fechaIso) {
      sinFecha++;
      const agenteConocido = resolverAgente(
        agenteSheet, directorFilaRaw, opts.agentesActivos, opts.emailToAgente, opts.aliasToAgente,
        opts.directorFiltroEmails, opts.nombresBloqueados
      );
      if (agenteConocido) sinFechaConocidos.push({ agente: agenteConocido, cliente, producto, fechaCruda });
      continue;
    }

    const agente = resolverAgente(
      agenteSheet, directorFilaRaw, opts.agentesActivos, opts.emailToAgente, opts.aliasToAgente,
      opts.directorFiltroEmails, opts.nombresBloqueados
    );
    if (!agente) {
      if (opts.directorFiltroEmails.size === 0) noReconocidos.add(agenteSheet);
      continue;
    }

    const montoParsed = parsePrecio(precioCrudo);
    const orden = (fila[5] || "").toString().trim();
    const contactoId = idVenta(orden, clienteId, fechaIso, String(montoParsed));
    if (idsVistos.has(contactoId)) {
      colisionesMismaCorrida++;
      continue;
    }
    idsVistos.add(contactoId);

    rows.push({
      contacto_id: contactoId,
      agente,
      monto: montoParsed,
      comision: parsePrecio(comisionCruda),
      producto: producto || "Sin especificar",
      contacto_nombre: cliente,
      fecha: fechaIso,
    });
  }

  return {
    tabName: opts.tabName,
    filasLeidas: filas.length - headerIdx - 2,
    rows,
    noReconocidos: Array.from(noReconocidos),
    sinFecha,
    sinFechaConocidos,
    colisionesMismaCorrida,
  };
}
