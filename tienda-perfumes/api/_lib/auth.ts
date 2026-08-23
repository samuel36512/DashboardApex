import type { VercelRequest } from "@vercel/node";

export function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const aBytes = enc.encode(a);
  const bBytes = enc.encode(b);
  if (aBytes.length !== bBytes.length) return false;
  let result = 0;
  for (let i = 0; i < aBytes.length; i++) result |= aBytes[i] ^ bBytes[i];
  return result === 0;
}

// Los endpoints /admin/* (gestionar catálogo, ver pedidos) piden un header
// Authorization: Bearer <ADMIN_TOKEN> que vos elegís, igual que
// WEBHOOK_SECRET en el dashboard hermano de este repo. No hay login de
// usuarios: es un solo token compartido para quien administra la tienda.
export function isAdminAuthorized(req: VercelRequest): boolean {
  const token = process.env.ADMIN_TOKEN;
  if (!token) return false;
  const authHeader = req.headers.authorization ?? "";
  const provided = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  return provided !== "" && timingSafeEqual(provided, token);
}
