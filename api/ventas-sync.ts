import type { VercelRequest, VercelResponse } from "@vercel/node";
import crypto from "crypto";
import { getSupabase } from "./_lib/supabase";
import { resolveEmpresaFromSecret } from "./_lib/tenant";

const SHEETS_BASE = "https://sheets.googleapis.com/v4/spreadsheets";

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

function mapearAgente(
  sheetNombre: string,
  agentesActivos: string[],
  emailToAgente: Map<string, string>,
  aliasToAgente: Map<string, string>
): string | null {
  // Algunas filas traen el nombre y el correo pegados en la misma celda,
  // separados por un salto de linea (ej. "Gab Mont\nGabrielmonteverde75@gmail.com")
  // - se intenta cada linea por separado (ademas del valor completo), para
  // no perder la venta cuando el nombre viene mal escrito pero el correo si
  // coincide con uno conocido.
  const candidatos = sheetNombre
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  const completo = sheetNombre.trim();
  if (completo && !candidatos.includes(completo)) candidatos.push(completo);
  if (candidatos.length === 0) return null;

  // A veces la columna AGENTE trae el correo del agente en vez del nombre -
  // se compara primero (exacto, sin acentos ni mayusculas de por medio).
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

// La hoja trae el dia (ej. "1 jul 2026"), a veces con una hora pegada
// despues de una coma (ej. "17 jul 2026, 21:39") - se ignora la hora (no es
// confiable para todas las filas) y se usa el mediodia UTC como instante
// representativo para que nunca caiga en el dia equivocado sin importar la
// zona horaria desde la que se filtre despues.
function parseFechaSheet(s: string): string | null {
  const m = s
    .trim()
    .toLowerCase()
    .match(/^(\d{1,2})\s+([a-z]{3})\s+(\d{4})(?:\s*,.*)?$/);
  if (!m) return null;
  const mes = MESES_FECHA[m[2]];
  if (mes === undefined) return null;
  return new Date(Date.UTC(Number(m[3]), mes, Number(m[1]), 12, 0, 0)).toISOString();
}

// Algunas filas del sheet traen el codigo de orden (ORD-AAAAMMDD-XXXXX)
// metido por error en la columna de producto - se descarta para que caiga
// en "Sin especificar" en vez de mostrarse como si fuera un producto real.
function pareceCodigoOrden(s: string): boolean {
  return /^ord-\d{6,}/i.test(s.trim());
}

function parsePrecio(s: string): number {
  return Number(String(s).replace(/[^0-9.-]/g, "")) || 0;
}

// El producto NO participa de la identidad de la venta - si el texto de esa
// columna cambia entre sincronizaciones (typo corregido, o el codigo de
// orden que a veces queda mal puesto ahi y despues se limpia), la MISMA
// venta real no debe generar un ID ni una firma distintos. cliente+fecha+
// precio (+orden si existe) ya es suficientemente especifico.
function idVenta(orden: string, cliente: string, fecha: string, precio: string): string {
  if (orden) return `venta-${orden}`;
  const base = `${cliente}|${fecha}|${precio}`;
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

const LOCK_KEY = "ventas_sync_lock";
const LOCK_VIGENCIA_MS = 4 * 60 * 1000;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const supabase = getSupabase();
  const providedSecret = typeof req.query.key === "string" ? req.query.key : "";
  const empresa = await resolveEmpresaFromSecret(supabase, providedSecret);
  if (!empresa) {
    return res.status(401).json({ error: "No autorizado. Agregá ?key=TU_WEBHOOK_SECRET a la URL." });
  }
  const empresaId = empresa.id;

  const credsJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  const sheetId = empresa.ventasSheetId;
  if (!credsJson || !sheetId) {
    return res.status(500).json({ error: "Falta GOOGLE_SERVICE_ACCOUNT_JSON en Vercel o ventas_sheet_id para esta empresa" });
  }

  // Si el cron (u otro disparador) reintenta por timeout mientras la
  // sincronizacion anterior todavia esta corriendo, dos ejecuciones casi
  // simultaneas pueden pisarse y las dos terminan insertando todo -
  // duplicando el mes entero de una sola vez. Un "leer y despues escribir"
  // NO alcanza (las dos pueden leer "libre" en el mismo instante) - se usa
  // un INSERT puro, que en la base es atomico: si dos ejecuciones lo
  // intentan al mismo tiempo, la base solo deja pasar una y la otra recibe
  // un error de conflicto (23505), sin importar el timing.
  const { data: candadoRow } = await supabase
    .from("sync_state")
    .select("value")
    .eq("empresa_id", empresaId)
    .eq("key", LOCK_KEY)
    .maybeSingle();
  const candadoDesde = candadoRow?.value ? new Date(candadoRow.value as string).getTime() : 0;
  if (candadoDesde && Date.now() - candadoDesde >= LOCK_VIGENCIA_MS) {
    // Candado viejo (de una corrida anterior que no lo libero bien) - se
    // limpia antes de intentar tomarlo de nuevo.
    await supabase.from("sync_state").delete().eq("empresa_id", empresaId).eq("key", LOCK_KEY);
  }
  const { error: candadoError } = await supabase
    .from("sync_state")
    .insert({ key: LOCK_KEY, value: new Date().toISOString(), empresa_id: empresaId });
  if (candadoError) {
    if (candadoError.code === "23505") {
      return res.status(409).json({ error: "Ya hay una sincronizacion de ventas en curso, esperá un momento y volvé a intentar." });
    }
    return res.status(500).json({ error: "Error tomando el candado de sincronizacion: " + candadoError.message });
  }

  try {
    const token = await getAccessToken(credsJson);

    const { data: agentesRows, error: agentesError } = await supabase
      .from("agentes")
      .select("nombre, email_personal")
      .eq("activo", true)
      .eq("empresa_id", empresaId);
    if (agentesError) throw new Error(`Error leyendo agentes: ${agentesError.message}`);
    const agentesActivos = (agentesRows ?? []).map((a) => a.nombre);
    const emailToAgente = new Map<string, string>();
    for (const a of agentesRows ?? []) {
      if (a.email_personal) emailToAgente.set(String(a.email_personal).toLowerCase(), a.nombre);
    }

    // Alias conocidos: nombre EXACTO (normalizado) tal como aparece en la
    // columna AGENTE de la hoja de ventas -> nombre real en nuestra tabla
    // agentes. La hoja es de TODA la empresa (decenas de personas que no
    // son nuestros agentes de ventas), asi que solo se usa lo que el
    // director confirmo explicitamente via el panel/SQL - cualquier otro
    // nombre se ignora y se reporta como "no reconocido" en vez de
    // adivinar.
    const { data: aliasRows, error: aliasRowsError } = await supabase
      .from("agente_alias")
      .select("alias_normalizado, agentes(nombre)")
      .eq("empresa_id", empresaId);
    if (aliasRowsError) throw new Error(`Error leyendo alias de agentes: ${aliasRowsError.message}`);
    const aliasToAgente = new Map<string, string>();
    for (const row of aliasRows ?? []) {
      const agenteRel = (row as any).agentes;
      const nombre: string | undefined = Array.isArray(agenteRel) ? agenteRel[0]?.nombre : agenteRel?.nombre;
      if (nombre) aliasToAgente.set(row.alias_normalizado, nombre);
    }

    // Segunda barrera contra duplicados, independiente del ID calculado: se
    // arma una firma de negocio (agente+producto+monto+fecha+correo) por
    // cada venta YA guardada. Si el ID calculado para una fila cambia por
    // cualquier motivo (que ya paso varias veces con datos raros de la
    // hoja), la firma sigue siendo la misma y la fila se salta en vez de
    // crear una copia nueva - no depende de adivinar por que el ID cambio.
    const firmasExistentes = new Map<string, string>();
    const PAGE_FIRMAS = 1000;
    for (let offset = 0; ; offset += PAGE_FIRMAS) {
      const { data: page, error } = await supabase
        .from("eventos")
        .select("contacto_id, agente, producto, monto, fecha, contacto_nombre")
        .eq("tipo", "venta")
        .eq("empresa_id", empresaId)
        .range(offset, offset + PAGE_FIRMAS - 1);
      if (error) throw new Error(`Error leyendo ventas existentes: ${error.message}`);
      for (const row of page ?? []) {
        const correo =
          (row.contacto_nombre || "")
            .split("\n")
            .map((s: string) => s.trim())
            .filter(Boolean)
            .pop() || "";
        // row.monto viene de una columna "numeric" de Postgres - Supabase la
        // devuelve como texto (ej. "580.00"), no como number. row.fecha
        // tambien puede volver con un formato de texto distinto al que arma
        // fechaIso mas abajo (ej. "+00:00" en vez de ".000Z") aunque sea el
        // mismo instante. Si no se normalizan los dos exactamente igual que
        // del lado recien calculado, la firma nunca coincide con nada y esta
        // barrera queda sin efecto silenciosamente (que es lo que estaba
        // pasando).
        const firma = `${row.agente}|${Number(row.monto)}|${new Date(row.fecha).toISOString()}|${correo.toLowerCase()}`;
        firmasExistentes.set(firma, row.contacto_id);
      }
      if (!page || page.length < PAGE_FIRMAS) break;
    }
    let duplicadosEvitados = 0;

    const mesParam = typeof req.query.mes === "string" ? req.query.mes.trim() : "";
    const ahora = new Date();
    const tabName = mesParam
      ? `${mesParam} ventas plataforma`
      : `${MESES_TAB[ahora.getMonth()]} ventas plataforma`;

    // Rango abierto (sin limite de fila): la pestaña es de toda la empresa y
    // crece durante el mes - un limite fijo (ej. J1500) corta las ventas mas
    // recientes en cuanto la pestaña pasa esa cantidad de filas.
    const range = encodeURIComponent(`${tabName}!A:J`);
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

    const rowsVenta: { contacto_id: string; agente: string; tipo: "venta"; monto: number; comision: number; producto: string; contacto_nombre: string; fecha: string; empresa_id: number }[] = [];
    const noReconocidos = new Set<string>();
    const sinFechaConocidos: { agente: string; cliente: string; producto: string; fechaCruda: string }[] = [];
    let ultimaFechaValida = "";
    let sinFecha = 0;

    for (let i = headerIdx + 2; i < filas.length; i++) {
      const fila = filas[i];
      if (!fila || fila.every((c) => !c)) continue; // fila vacia

      const fechaCruda = (fila[0] || "").toString().trim();
      const cliente = (fila[1] || "").toString().trim();
      let producto = (fila[3] || fila[2] || "").toString().trim();
      if (pareceCodigoOrden(producto)) producto = "";
      const precioCrudo = (fila[4] || "").toString().trim();
      const agenteSheet = (fila[6] || "").toString().trim();
      const comisionCruda = (fila[7] || "").toString().trim();

      if (!cliente || !precioCrudo || !agenteSheet) continue;

      // Algunas filas traen "Nombre\ncorreo" en la celda del cliente y otras
      // veces solo el correo (la hoja cambia con el tiempo) - se usa siempre
      // la ULTIMA linea (el correo, que es lo estable) para el ID, para que
      // la misma venta no genere un ID distinto segun como venga esa celda.
      const clienteId = cliente.split("\n").map((s: string) => s.trim()).filter(Boolean).pop() || cliente;

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
        // Si la fila SI es de uno de nuestros agentes, vale la pena saberlo -
        // significa que se esta perdiendo una venta real por falta de fecha,
        // no solo filas de gente ajena al equipo.
        const agenteConocido = mapearAgente(agenteSheet, agentesActivos, emailToAgente, aliasToAgente);
        if (agenteConocido) {
          sinFechaConocidos.push({ agente: agenteConocido, cliente, producto, fechaCruda });
        }
        continue;
      }

      const agente = mapearAgente(agenteSheet, agentesActivos, emailToAgente, aliasToAgente);
      if (!agente) {
        noReconocidos.add(agenteSheet);
        continue;
      }

      const montoParsed = parsePrecio(precioCrudo);
      const productoFinal = producto || "Sin especificar";
      const orden = (fila[5] || "").toString().trim();
      // El ID se arma SOLO con valores ya normalizados (nunca texto crudo de
      // la hoja): fechaIso en vez de fechaCruda (algunas filas traen la hora
      // pegada a la fecha y esa hora no es estable entre sincronizaciones), y
      // el precio ya parseado a numero en vez del texto con formato de
      // moneda. Texto crudo inestable = un ID nuevo en cada sincronizacion =
      // la misma venta duplicada sin parar.
      const contactoId = idVenta(orden, clienteId, fechaIso, String(montoParsed));

      // La barrera por firma de negocio aplica SIEMPRE, tenga o no numero de
      // orden - la hoja es compartida por toda la empresa y crece todo el
      // tiempo, asi que el numero de orden de una fila puede correrse con el
      // tiempo (no es un ID fijo). El producto NO participa de la firma (ver
      // idVenta) - si participara, corregir un typo en esa columna o el
      // codigo de orden colandose ahi por error (ya paso) generaria un ID Y
      // una firma nuevos, duplicando una venta real. Riesgo aceptado: si el
      // mismo cliente compra al mismo precio el mismo dia dos veces de
      // verdad (aunque sean productos distintos), la segunda se salta - un
      // caso raro, preferible a seguir duplicando ventas reales.
      const firma = `${agente}|${montoParsed}|${fechaIso}|${clienteId.toLowerCase()}`;
      const idExistente = firmasExistentes.get(firma);
      if (idExistente && idExistente !== contactoId) {
        // Ya hay una venta identica guardada con OTRO id (el calculo del ID
        // cambio) - no se crea una fila nueva, se deja la que ya esta.
        duplicadosEvitados++;
        continue;
      }
      firmasExistentes.set(firma, contactoId);

      rowsVenta.push({
        contacto_id: contactoId,
        agente,
        tipo: "venta",
        monto: montoParsed,
        comision: parsePrecio(comisionCruda),
        producto: productoFinal,
        contacto_nombre: cliente,
        fecha: fechaIso,
        empresa_id: empresaId,
      });
    }

    if (rowsVenta.length > 0) {
      const CHUNK = 500;
      for (let i = 0; i < rowsVenta.length; i += CHUNK) {
        const { error } = await supabase
          .from("eventos")
          .upsert(rowsVenta.slice(i, i + CHUNK), { onConflict: "empresa_id,contacto_id,tipo" });
        if (error) throw new Error(`Error guardando ventas: ${error.message}`);
      }
    }

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({
      ok: true,
      pestana: tabName,
      filasLeidas: filas.length - headerIdx - 2,
      ventasGuardadas: rowsVenta.length,
      duplicadosEvitados,
      sinFecha,
      sinFechaDeMiEquipo: sinFechaConocidos,
      agentesNoReconocidos: Array.from(noReconocidos),
      muestra: rowsVenta.slice(0, 3).map((r) => ({
        cliente: r.contacto_nombre,
        agente: r.agente,
        producto: r.producto,
        fecha: r.fecha,
      })),
    });
  } catch (err: any) {
    return res.status(502).json({ error: err?.message || "Error sincronizando ventas" });
  } finally {
    await supabase.from("sync_state").delete().eq("empresa_id", empresaId).eq("key", LOCK_KEY);
  }
}
