import type { VercelRequest, VercelResponse } from "@vercel/node";
import crypto from "node:crypto";
import { getSupabase } from "../_lib/supabase";
import { getAccessToken, requireDirector } from "../_lib/auth";

const TIPOS_VALIDOS = ["lead", "registro", "ftd"] as const;
const MODOS_VALIDOS = ["sumar", "restar"] as const;
const CANTIDAD_MAXIMA = 200;

// Fecha en Colombia (UTC-5): si el director elige un dia puntual se usa la
// medianoche de ese dia en Colombia (mismo criterio que el historico
// sembrado a mano), y si no elige nada se usa el instante actual.
function fechaColombia(fechaStr: string): string | null {
  const m = fechaStr.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const [, anio, mes, dia] = m;
  return new Date(Date.UTC(Number(anio), Number(mes) - 1, Number(dia), 5, 0, 0)).toISOString();
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const supabase = getSupabase();
  const auth = await requireDirector(supabase, getAccessToken(req));
  if (!auth.ok) {
    return res.status(auth.status).json({ error: auth.error });
  }
  const { empresaId } = auth.ctx;

  const body = (req.body ?? {}) as Record<string, unknown>;
  const agenteId = Number(body.agenteId);
  const tipo = typeof body.tipo === "string" ? body.tipo : "";
  const modo = typeof body.modo === "string" && body.modo ? body.modo : "sumar";
  const cantidad = Math.trunc(Number(body.cantidad));
  const fechaInput = typeof body.fecha === "string" ? body.fecha.trim() : "";

  if (!agenteId) {
    return res.status(400).json({ error: "Falta el agente" });
  }
  if (!TIPOS_VALIDOS.includes(tipo as (typeof TIPOS_VALIDOS)[number])) {
    return res.status(400).json({ error: "Tipo invalido - debe ser lead, registro o ftd" });
  }
  if (!MODOS_VALIDOS.includes(modo as (typeof MODOS_VALIDOS)[number])) {
    return res.status(400).json({ error: "Modo invalido - debe ser sumar o restar" });
  }
  if (!Number.isFinite(cantidad) || cantidad < 1 || cantidad > CANTIDAD_MAXIMA) {
    return res.status(400).json({ error: `La cantidad debe ser un numero entre 1 y ${CANTIDAD_MAXIMA}` });
  }

  let fecha: string;
  if (fechaInput) {
    const fechaResuelta = fechaColombia(fechaInput);
    if (!fechaResuelta) {
      return res.status(400).json({ error: "Fecha invalida - usa el formato AAAA-MM-DD" });
    }
    fecha = fechaResuelta;
  } else {
    fecha = new Date().toISOString();
  }

  const { data: agente, error: agenteError } = await supabase
    .from("agentes")
    .select("id, nombre")
    .eq("id", agenteId)
    .eq("activo", true)
    .eq("empresa_id", empresaId)
    .maybeSingle();
  if (agenteError || !agente) {
    return res.status(400).json({ error: "Agente no encontrado" });
  }

  if (modo === "restar") {
    // Solo se puede restar de lo que se sumo con este mismo boton (prefijo
    // "ajuste-") - nunca de actividad real sincronizada desde GHL, para no
    // arriesgar borrar historial real por error. Se quitan las mas
    // recientes primero (lo mas probable que sea el ajuste equivocado).
    const { data: candidatos, error: candidatosError } = await supabase
      .from("eventos")
      .select("id")
      .eq("agente", agente.nombre)
      .eq("tipo", tipo)
      .eq("empresa_id", empresaId)
      .like("contacto_id", "ajuste-%")
      .order("creado_en", { ascending: false })
      .limit(cantidad);
    if (candidatosError) {
      return res.status(500).json({ error: "Error buscando ajustes para restar: " + candidatosError.message });
    }
    const ids = (candidatos ?? []).map((c) => c.id);
    if (ids.length === 0) {
      return res.status(400).json({
        error: `No hay ajustes manuales de ${tipo} para ${agente.nombre} que se puedan restar`,
      });
    }
    const { error: deleteError } = await supabase.from("eventos").delete().in("id", ids);
    if (deleteError) {
      return res.status(500).json({ error: "Error restando el ajuste: " + deleteError.message });
    }
    return res.status(200).json({
      ok: true,
      agente: agente.nombre,
      tipo,
      modo,
      cantidadPedida: cantidad,
      cantidadRestada: ids.length,
      incompleto: ids.length < cantidad,
    });
  }

  // contacto_id con prefijo "ajuste-" para poder distinguir estos registros
  // de los que llegan realmente sincronizados desde GHL, en caso de que
  // despues haga falta auditar o revertir un ajuste puntual.
  const filas = Array.from({ length: cantidad }, () => ({
    contacto_id: `ajuste-${crypto.randomUUID()}`,
    agente: agente.nombre,
    tipo,
    fecha,
    empresa_id: empresaId,
  }));

  const { error: insertError } = await supabase.from("eventos").upsert(filas, { onConflict: "empresa_id,contacto_id,tipo" });
  if (insertError) {
    return res.status(500).json({ error: "Error guardando el ajuste: " + insertError.message });
  }

  return res.status(201).json({ ok: true, agente: agente.nombre, tipo, modo, cantidad, fecha });
}
