import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getSupabase } from "./_lib/supabase";

interface AgentAgg {
  leads: number;
  registros: number;
  ftds: number;
  ventasUSD: number;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const supabase = getSupabase();
  const { data, error } = await supabase.from("eventos").select("agente, tipo, monto");
  if (error) {
    return res.status(500).json({ error: "Error leyendo los datos" });
  }

  const byAgent = new Map<string, AgentAgg>();
  for (const row of data ?? []) {
    if (!byAgent.has(row.agente)) {
      byAgent.set(row.agente, { leads: 0, registros: 0, ftds: 0, ventasUSD: 0 });
    }
    const agg = byAgent.get(row.agente)!;
    if (row.tipo === "lead") agg.leads++;
    else if (row.tipo === "registro") agg.registros++;
    else if (row.tipo === "ftd") agg.ftds++;
    else if (row.tipo === "venta") agg.ventasUSD += Number(row.monto ?? 0);
  }

  const pct = (num: number, den: number) => (den > 0 ? Math.round((num / den) * 10000) / 100 : 0);

  const agentes = Array.from(byAgent.entries())
    .map(([agente, a]) => ({
      agente,
      leads: a.leads,
      registros: a.registros,
      ftds: a.ftds,
      ventasUSD: a.ventasUSD,
      conversion: {
        leadToRegistro: pct(a.registros, a.leads),
        registroToFtd: pct(a.ftds, a.registros),
        leadToFtd: pct(a.ftds, a.leads),
      },
    }))
    .sort((a, b) => a.agente.localeCompare(b.agente));

  res.setHeader("Cache-Control", "no-store");
  return res.status(200).json({
    agentes,
    metaVentasUSD: Number(process.env.META_VENTAS_USD ?? 2400),
    actualizado: new Date().toISOString(),
  });
}
