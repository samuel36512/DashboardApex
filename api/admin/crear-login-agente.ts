import type { VercelRequest, VercelResponse } from "@vercel/node";
import crypto from "node:crypto";
import { getSupabase } from "../_lib/supabase";
import { getAccessToken, requireDirector } from "../_lib/auth";

function randomPassword(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  const bytes = crypto.randomBytes(14);
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += chars[bytes[i] % chars.length];
  return out;
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

  const body = (req.body ?? {}) as Record<string, unknown>;
  const agenteId = Number(body.agenteId);
  const email = typeof body.email === "string" ? body.email.trim() : "";
  if (!agenteId || !email) {
    return res.status(400).json({ error: "Faltan agenteId o email" });
  }

  const { data: agente, error: agenteError } = await supabase
    .from("agentes")
    .select("id, nombre")
    .eq("id", agenteId)
    .maybeSingle();
  if (agenteError || !agente) {
    return res.status(400).json({ error: "Agente no encontrado" });
  }

  const { data: existente } = await supabase
    .from("perfiles")
    .select("id")
    .eq("agente_id", agenteId)
    .maybeSingle();
  if (existente) {
    return res.status(409).json({ error: "Este agente ya tiene un acceso creado" });
  }

  const password = randomPassword();
  const { data: created, error: createError } = await supabase.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (createError || !created?.user) {
    return res.status(400).json({ error: createError?.message || "No se pudo crear el usuario" });
  }

  const { error: perfilError } = await supabase.from("perfiles").insert({
    id: created.user.id,
    rol: "agente",
    agente_id: agente.id,
    email,
  });
  if (perfilError) {
    return res.status(500).json({
      error: "El usuario se creo pero no se pudo vincular el perfil: " + perfilError.message,
    });
  }

  return res.status(201).json({ ok: true, email, password, agente: agente.nombre });
}
