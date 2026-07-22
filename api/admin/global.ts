import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getSupabase } from "../_lib/supabase";
import { tasaDiariaCOP } from "../_lib/agentTier";
import { getDiasActivosPautaMes } from "../_lib/pautaEstado";
import { getAccessToken } from "../_lib/auth";

interface AgentAgg {
  leads: number;
  registros: number;
  ftds: number;
  ventasUSD: number;
  comisionUSD: number;
}

const PAGE = 1000;

// Vista combinada de las 3 oficinas para el superadmin: por cada empresa
// activa, repite (en version simplificada, solo del mes en curso) el mismo
// calculo que ya hace /metrics por oficina, y junta todo en una sola lista
// de agentes con el nombre de su empresa al lado, mas un subtotal por
// oficina - asi el ranking/"mejores agentes" se arma sobre datos ya
// probados, no una formula nueva.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const supabase = getSupabase();
  const { data: userData, error: userError } = await supabase.auth.getUser(getAccessToken(req));
  if (userError || !userData?.user) {
    return res.status(401).json({ error: "Sesion invalida o vencida" });
  }
  const { data: perfil, error: perfilError } = await supabase
    .from("perfiles")
    .select("rol")
    .eq("id", userData.user.id)
    .maybeSingle();
  if (perfilError || !perfil || perfil.rol !== "superadmin") {
    return res.status(403).json({ error: "Solo el superadmin puede ver esto" });
  }

  const { data: empresasRows, error: empresasError } = await supabase
    .from("empresas")
    .select(
      "id, nombre, tasa_pauta_ejecutivo_cop, tasa_pauta_junior_cop, comision_por_ftd_usd, costo_por_lead_fijo_cop"
    )
    .eq("activo", true)
    .order("nombre");
  if (empresasError) {
    return res.status(500).json({ error: "Error leyendo empresas" });
  }

  const ahoraCo = new Date(Date.now() - 5 * 60 * 60 * 1000);
  const desdeMesCo = new Date(Date.UTC(ahoraCo.getUTCFullYear(), ahoraCo.getUTCMonth(), 1, 5, 0, 0)).toISOString();

  const oficinas: any[] = [];
  const agentesGlobal: any[] = [];

  for (const empresa of empresasRows ?? []) {
    const empresaId = empresa.id as number;
    const tasasPauta = {
      ejecutivoCOP: Number(empresa.tasa_pauta_ejecutivo_cop),
      juniorCOP: Number(empresa.tasa_pauta_junior_cop),
    };
    const comisionPorFtd = Number(empresa.comision_por_ftd_usd);
    const costoPorLeadFijoCOP =
      empresa.costo_por_lead_fijo_cop === null || empresa.costo_por_lead_fijo_cop === undefined
        ? null
        : Number(empresa.costo_por_lead_fijo_cop);

    const { data: agentesRows, error: agentesError } = await supabase
      .from("agentes")
      .select("nombre, tier")
      .eq("activo", true)
      .eq("empresa_id", empresaId);
    if (agentesError) {
      return res.status(500).json({ error: `Error leyendo agentes de ${empresa.nombre}` });
    }

    const byAgent = new Map<string, AgentAgg>();
    const tierByAgente = new Map<string, "ejecutivo" | "junior" | null>();
    for (const a of agentesRows ?? []) {
      byAgent.set(a.nombre, { leads: 0, registros: 0, ftds: 0, ventasUSD: 0, comisionUSD: 0 });
      tierByAgente.set(a.nombre, (a.tier as "ejecutivo" | "junior" | null) ?? null);
    }

    for (let offset = 0; ; offset += PAGE) {
      const { data: page, error } = await supabase
        .from("eventos")
        .select("agente, tipo, monto, comision")
        .eq("empresa_id", empresaId)
        .gte("fecha", desdeMesCo)
        .range(offset, offset + PAGE - 1);
      if (error) {
        return res.status(500).json({ error: `Error leyendo actividad de ${empresa.nombre}` });
      }
      for (const row of page ?? []) {
        if (!byAgent.has(row.agente)) {
          byAgent.set(row.agente, { leads: 0, registros: 0, ftds: 0, ventasUSD: 0, comisionUSD: 0 });
        }
        const agg = byAgent.get(row.agente)!;
        if (row.tipo === "lead") agg.leads++;
        else if (row.tipo === "registro") agg.registros++;
        else if (row.tipo === "ftd") agg.ftds++;
        else if (row.tipo === "venta") {
          agg.ventasUSD += Number(row.monto ?? 0);
          agg.comisionUSD += Number(row.comision ?? 0);
        }
      }
      if (!page || page.length < PAGE) break;
    }

    const { diasActivos: diasActivosPauta } = await getDiasActivosPautaMes(supabase, empresaId);

    const agentesBase = Array.from(byAgent.entries()).map(([agente, a]) => {
      const tier = tierByAgente.get(agente) ?? null;
      const tasaDiaria = tasaDiariaCOP(tier, tasasPauta);
      const gastoPautaCOP = tasaDiaria !== null ? Math.round(tasaDiaria * diasActivosPauta) : null;
      return { agente, ...a, tier, gastoPautaCOP };
    });

    const totalLeadsMes = agentesBase.reduce((acc, a) => acc + a.leads, 0);
    const totalInvertidoCOP = agentesBase.reduce((acc, a) => acc + (a.gastoPautaCOP || 0), 0);
    const costoPorLeadCOP = costoPorLeadFijoCOP ?? (totalLeadsMes > 0 ? totalInvertidoCOP / totalLeadsMes : null);

    let totalFtds = 0;
    let totalRegistros = 0;
    let totalVentasUSD = 0;

    for (const a of agentesBase) {
      const gastoRealCOP = costoPorLeadCOP !== null ? Math.round(costoPorLeadCOP * a.leads) : null;
      const costoPorFtdRealCOP = gastoRealCOP !== null && a.ftds > 0 ? Math.round(gastoRealCOP / a.ftds) : null;
      totalFtds += a.ftds;
      totalRegistros += a.registros;
      totalVentasUSD += a.ventasUSD;
      agentesGlobal.push({
        agente: a.agente,
        empresaId,
        empresaNombre: empresa.nombre,
        tier: a.tier,
        leads: a.leads,
        registros: a.registros,
        ftds: a.ftds,
        ventasUSD: a.ventasUSD,
        comisionUSD: a.comisionUSD,
        gastoRealCOP,
        costoPorFtdRealCOP,
        gananciaEstimadaUSD: a.comisionUSD + a.ftds * comisionPorFtd,
      });
    }

    oficinas.push({
      empresaId,
      empresaNombre: empresa.nombre,
      totalLeadsMes,
      totalRegistros,
      totalFtds,
      totalVentasUSD,
      totalInvertidoCOP,
      costoPorLeadCOP: costoPorLeadCOP !== null ? Math.round(costoPorLeadCOP) : null,
      costoPromedioPorFtdCOP: totalFtds > 0 ? Math.round(totalInvertidoCOP / totalFtds) : null,
    });
  }

  res.setHeader("Cache-Control", "no-store");
  return res.status(200).json({
    oficinas,
    agentes: agentesGlobal,
    actualizado: new Date().toISOString(),
  });
}
