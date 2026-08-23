import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getSupabase } from "../_lib/supabase";
import { isAdminAuthorized } from "../_lib/auth";

// CRUD del catálogo, protegido con Authorization: Bearer <ADMIN_TOKEN>.
// GET: lista todo (incluye inactivos). POST: crea. PUT: actualiza por id.
// DELETE: baja lógica (activo=false), nunca borra la fila (para no romper
// pedidos históricos que referencian ese producto_id en su "items" jsonb).
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!isAdminAuthorized(req)) {
    return res.status(401).json({ error: "No autorizado" });
  }

  const supabase = getSupabase();

  if (req.method === "GET") {
    const { data, error } = await supabase.from("productos").select("*").order("id", { ascending: false });
    if (error) return res.status(500).json({ error: "Error obteniendo productos" });
    return res.status(200).json({ productos: data });
  }

  if (req.method === "POST") {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const nombre = typeof b.nombre === "string" ? b.nombre.trim() : "";
    const precio = Number(b.precio);
    if (!nombre) return res.status(400).json({ error: "nombre es requerido" });
    if (!Number.isFinite(precio) || precio < 0) return res.status(400).json({ error: "precio inválido" });

    const { data, error } = await supabase
      .from("productos")
      .insert({
        nombre,
        marca: typeof b.marca === "string" ? b.marca : null,
        descripcion: typeof b.descripcion === "string" ? b.descripcion : null,
        precio,
        imagen_url: typeof b.imagen_url === "string" ? b.imagen_url : null,
        activo: b.activo !== false,
        disponible: b.disponible !== false,
      })
      .select("*")
      .single();

    if (error) return res.status(500).json({ error: "Error creando el producto" });
    return res.status(201).json({ producto: data });
  }

  if (req.method === "PUT") {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const id = Number(b.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: "id es requerido" });

    const cambios: Record<string, unknown> = {};
    if (typeof b.nombre === "string") cambios.nombre = b.nombre.trim();
    if (typeof b.marca === "string") cambios.marca = b.marca;
    if (typeof b.descripcion === "string") cambios.descripcion = b.descripcion;
    if (b.precio !== undefined) {
      const precio = Number(b.precio);
      if (!Number.isFinite(precio) || precio < 0) return res.status(400).json({ error: "precio inválido" });
      cambios.precio = precio;
    }
    if (typeof b.imagen_url === "string") cambios.imagen_url = b.imagen_url;
    if (typeof b.activo === "boolean") cambios.activo = b.activo;
    if (typeof b.disponible === "boolean") cambios.disponible = b.disponible;

    const { data, error } = await supabase.from("productos").update(cambios).eq("id", id).select("*").maybeSingle();
    if (error) return res.status(500).json({ error: "Error actualizando el producto" });
    if (!data) return res.status(404).json({ error: "Producto no encontrado" });
    return res.status(200).json({ producto: data });
  }

  if (req.method === "DELETE") {
    const id = Number(req.query.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: "id es requerido" });

    const { error } = await supabase.from("productos").update({ activo: false }).eq("id", id);
    if (error) return res.status(500).json({ error: "Error dando de baja el producto" });
    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ error: "Method not allowed" });
}
