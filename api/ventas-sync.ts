import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getSupabase } from "./_lib/supabase";
import { resolveEmpresaFromSecret } from "./_lib/tenant";
import { MESES_TAB, leerVentasDelSheet } from "./_lib/ventasSheet";

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
      .select("alias_normalizado, agentes(nombre, activo)")
      .eq("empresa_id", empresaId);
    if (aliasRowsError) throw new Error(`Error leyendo alias de agentes: ${aliasRowsError.message}`);
    const aliasToAgente = new Map<string, string>();
    for (const row of aliasRows ?? []) {
      const agenteRel = (row as any).agentes;
      const agenteObj = Array.isArray(agenteRel) ? agenteRel[0] : agenteRel;
      // Un agente desactivado no debe volver a resolverse por ningun
      // camino, ni siquiera por un alias viejo que todavia apunte a el -
      // si no, desactivarlo (ej. porque ya no trabaja mas) no alcanza para
      // que deje de aparecer.
      if (agenteObj?.nombre && agenteObj?.activo) aliasToAgente.set(row.alias_normalizado, agenteObj.nombre);
    }

    // Nombres a ignorar SIEMPRE para esta empresa (ver tabla
    // agente_bloqueado) - gente que ya no trabaja mas pero cuyo nombre
    // sigue en el sheet: sin esto, el respaldo por director (mas abajo) los
    // volveria a traer solos en cada corrida, tratandolos como "agente
    // nuevo".
    const { data: bloqueadosRows, error: bloqueadosError } = await supabase
      .from("agente_bloqueado")
      .select("nombre_normalizado")
      .eq("empresa_id", empresaId);
    if (bloqueadosError) throw new Error(`Error leyendo agentes bloqueados: ${bloqueadosError.message}`);
    const nombresBloqueados = new Set((bloqueadosRows ?? []).map((r) => r.nombre_normalizado as string));

    // Segunda barrera contra duplicados, independiente del ID calculado: se
    // arma una firma de negocio (agente+monto+fecha+correo) por cada venta
    // YA guardada. Si el ID calculado para una fila cambia por cualquier
    // motivo (que ya paso varias veces con datos raros de la hoja), la
    // firma sigue siendo la misma y la fila se salta en vez de crear una
    // copia nueva - no depende de adivinar por que el ID cambio.
    const firmasExistentes = new Map<string, string>();
    const PAGE_FIRMAS = 1000;
    for (let offset = 0; ; offset += PAGE_FIRMAS) {
      const { data: page, error } = await supabase
        .from("eventos")
        .select("contacto_id, agente, monto, fecha, contacto_nombre")
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

    const mesParam = typeof req.query.mes === "string" ? req.query.mes.trim() : "";
    const ahora = new Date();
    const tabName = mesParam
      ? `${mesParam} ventas plataforma`
      : `${MESES_TAB[ahora.getMonth()]} ventas plataforma`;

    const directorFiltroEmails = new Set(empresa.ventasDirectorEmails);

    const lectura = await leerVentasDelSheet({
      sheetId,
      credsJson,
      tabName,
      agentesActivos,
      emailToAgente,
      aliasToAgente,
      directorFiltroEmails,
      nombresBloqueados,
    });

    let duplicadosEvitados = lectura.colisionesMismaCorrida;
    const rowsVenta: { contacto_id: string; agente: string; tipo: "venta"; monto: number; comision: number; producto: string; contacto_nombre: string; fecha: string; empresa_id: number }[] = [];
    for (const r of lectura.rows) {
      // La barrera por firma de negocio aplica SIEMPRE, tenga o no numero de
      // orden - la hoja es compartida por toda la empresa y crece todo el
      // tiempo, asi que el numero de orden de una fila puede correrse con el
      // tiempo (no es un ID fijo).
      const correo = r.contacto_nombre.split("\n").map((s) => s.trim()).filter(Boolean).pop() || "";
      const firma = `${r.agente}|${r.monto}|${r.fecha}|${correo.toLowerCase()}`;
      const idExistente = firmasExistentes.get(firma);
      if (idExistente && idExistente !== r.contacto_id) {
        // Ya hay una venta identica guardada con OTRO id (el calculo del ID
        // cambio) - no se crea una fila nueva, se deja la que ya esta.
        duplicadosEvitados++;
        continue;
      }
      firmasExistentes.set(firma, r.contacto_id);
      rowsVenta.push({ ...r, tipo: "venta", empresa_id: empresaId });
    }

    // Segunda barrera, justo antes de guardar: colapsa por contacto_id
    // (se queda con la ULTIMA fila de cada grupo) para que sea imposible
    // que dos filas con el mismo contacto_id lleguen juntas al upsert, sin
    // importar por que el filtro de mas arriba no las haya detectado. Se
    // reportan los casos colapsados para poder diagnosticarlos.
    const rowsVentaPorId = new Map<string, (typeof rowsVenta)[number]>();
    const colisionesDetectadas: { contactoId: string; cliente: string; agente: string }[] = [];
    for (const r of rowsVenta) {
      if (rowsVentaPorId.has(r.contacto_id)) {
        colisionesDetectadas.push({ contactoId: r.contacto_id, cliente: r.contacto_nombre, agente: r.agente });
      }
      rowsVentaPorId.set(r.contacto_id, r);
    }
    const rowsVentaFinal = Array.from(rowsVentaPorId.values());

    if (rowsVentaFinal.length > 0) {
      const CHUNK = 500;
      for (let i = 0; i < rowsVentaFinal.length; i += CHUNK) {
        const { error } = await supabase
          .from("eventos")
          .upsert(rowsVentaFinal.slice(i, i + CHUNK), { onConflict: "empresa_id,contacto_id,tipo" });
        if (error) throw new Error(`Error guardando ventas: ${error.message}`);
      }
    }

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({
      ok: true,
      pestana: lectura.tabName,
      filasLeidas: lectura.filasLeidas,
      ventasGuardadas: rowsVentaFinal.length,
      duplicadosEvitados,
      colisionesDetectadas,
      sinFecha: lectura.sinFecha,
      sinFechaDeMiEquipo: lectura.sinFechaConocidos,
      agentesNoReconocidos: lectura.noReconocidos,
      muestra: rowsVentaFinal.slice(0, 3).map((r) => ({
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
