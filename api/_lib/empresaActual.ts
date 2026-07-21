// Paso intermedio de la migracion a multi-empresa: hasta que cada endpoint
// resuelva la empresa del que llama (por sesion o por webhook_secret), se
// usa este valor fijo (la unica empresa que existe hoy, "APEX PRINCIPAL",
// id=1 en la tabla empresas). Se reemplaza por resolucion real mas
// adelante en la migracion - ver /root/.claude/plans/enumerated-giggling-gizmo.md.
export const EMPRESA_ID_ACTUAL = 1;
