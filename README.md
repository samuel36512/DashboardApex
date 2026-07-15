# DashboardApex Backend

Cloudflare Worker + D1 que recibe webhooks de GoHighLevel (GHL) y expone
`GET /metrics` para el dashboard de conversión de ventas.

## Por qué Cloudflare Workers + D1 (y no Vercel + Supabase)

- Todo vive en una sola plataforma: un `wrangler.toml`, un comando de deploy,
  sin coordinar dos servicios ni dos sets de credenciales.
- D1 se consulta directo desde el Worker (binding nativo), sin llamadas HTTP
  extra ni API keys de por medio como con la REST API de Supabase.
- Free tier sobra para este caso: 100k requests/día en Workers, 5M
  lecturas/día y 100k escrituras/día en D1. El volumen de webhooks de un
  equipo de ventas está muy por debajo de eso.
- `wrangler secret put` da manejo de secretos de env vars sin tocar código,
  que es justo lo que pediste para el token del webhook.

Supabase es mejor opción si más adelante necesitás auth de usuarios, un
panel para editar datos a mano, o Postgres con relaciones complejas. Para
este caso (unos pocos eventos por contacto, agregaciones simples) D1 alcanza
y es más simple de operar.

## Decisiones que tomé sin preguntarte (revisalas)

- **`GET /metrics` es público**, sin restricción de origen ni API key
  (headers `Access-Control-Allow-Origin: *`), como pediste.
- **`fecha` es opcional en el payload**: si GHL no la manda o el merge tag
  no resuelve, el Worker usa la hora del servidor al recibir el webhook.
  Si preferís exigirla siempre, es un cambio de una línea en
  `src/index.ts` (`parsePayload`).
- **`monto` acepta número o string numérico** (`150` o `"150"`), porque
  algunos builders de webhooks (incluido GHL) insertan merge tags dentro de
  comillas y el JSON termina con el valor como string.
- **Upsert por `(contacto_id, tipo)`**: si el mismo evento se reenvía para
  el mismo contacto (reintento de red, doble click en el workflow), se
  actualiza el registro en vez de duplicarlo. Esto evita que un reintento
  infle los conteos de `/metrics`.

## Estructura

```
wrangler.toml       # config del Worker + binding de D1
schema.sql           # tabla "eventos"
src/index.ts          # rutas, validación, queries
.dev.vars.example    # plantilla de secretos para desarrollo local
```

## 1. Requisitos

- Cuenta gratuita de Cloudflare.
- Node.js 18+.
- `npm install` en este directorio (instala `wrangler`).

```bash
npm install
npx wrangler login
```

## 2. Crear la base de datos D1

```bash
npx wrangler d1 create dashboardapex
```

Esto imprime un `database_id`. Copialo y pegalo en `wrangler.toml`,
reemplazando `REPLACE_WITH_YOUR_D1_DATABASE_ID`.

Crear la tabla `eventos`:

```bash
npm run db:init:remote
```

(`db:init`, sin `:remote`, aplica el schema a la base local para desarrollo
con `wrangler dev`.)

## 3. Configurar el secreto del webhook

Generá un token largo y random (por ejemplo `openssl rand -hex 32`) y
guardalo como secreto — **nunca en el código ni en `wrangler.toml`**:

```bash
npx wrangler secret put WEBHOOK_SECRET
# pega el token cuando te lo pida
```

Vas a necesitar este mismo valor después en GHL, en el header
`Authorization: Bearer <token>`.

Para desarrollo local, copiá `.dev.vars.example` a `.dev.vars` y completá
`WEBHOOK_SECRET` ahí (ese archivo está en `.gitignore`, no se commitea).

## 4. Deploy

```bash
npm run deploy
```

Wrangler va a imprimir la URL pública, algo como:
`https://dashboardapex-backend.<tu-subdominio>.workers.dev`

Guardala, la vas a usar en los 5 pasos siguientes (4 webhooks + metrics).

## 5. Probar los endpoints

```bash
# Debe fallar con 401 (sin token)
curl -X POST https://TU-WORKER.workers.dev/webhook/lead \
  -H "Content-Type: application/json" \
  -d '{"contacto_id":"c1","agente":"Juan Perez","fecha":"2026-07-15T10:00:00Z"}'

# Con token, debe dar 201
curl -X POST https://TU-WORKER.workers.dev/webhook/lead \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer TU_TOKEN" \
  -d '{"contacto_id":"c1","agente":"Juan Perez","fecha":"2026-07-15T10:00:00Z"}'

curl -X POST https://TU-WORKER.workers.dev/webhook/registro \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer TU_TOKEN" \
  -d '{"contacto_id":"c1","agente":"Juan Perez","fecha":"2026-07-15T10:05:00Z"}'

curl -X POST https://TU-WORKER.workers.dev/webhook/ftd \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer TU_TOKEN" \
  -d '{"contacto_id":"c1","agente":"Juan Perez","fecha":"2026-07-15T10:10:00Z","monto":50}'

curl -X POST https://TU-WORKER.workers.dev/webhook/venta \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer TU_TOKEN" \
  -d '{"contacto_id":"c1","agente":"Juan Perez","fecha":"2026-07-15T10:20:00Z","monto":2400}'

# Ver las métricas
curl https://TU-WORKER.workers.dev/metrics
```

`GET /metrics` debería devolver algo así:

```json
{
  "agentes": [
    {
      "agente": "Juan Perez",
      "leads": 1,
      "registros": 1,
      "ftds": 1,
      "ventasUSD": 2400,
      "conversion": { "leadToRegistro": 100, "registroToFtd": 100, "leadToFtd": 100 }
    }
  ],
  "metaVentasUSD": 2400,
  "actualizado": "2026-07-15T10:20:01.000Z"
}
```

Para ver los datos crudos en cualquier momento:

```bash
npx wrangler d1 execute dashboardapex --remote --command "SELECT * FROM eventos ORDER BY id DESC LIMIT 20"
```

## 6. Configurar los Workflows en GoHighLevel

Necesitás 4 workflows (uno por evento), o 4 pasos de webhook dentro de los
workflows que ya uses para taggear contactos. Antes de empezar, confirmá en
**Settings > Custom Fields** el *fieldkey* exacto de "Agente asignado" y de
los campos de monto de FTD y de venta (los vas a necesitar para los merge
tags).

Para cada evento (Lead, Registro, FTD, Venta):

1. **Automation > Workflows > Create Workflow**.
2. **Trigger**: `Contact Tag` (o el trigger que uses hoy para marcar ese
   evento) = la tag correspondiente (ej. `FTD`).
3. **Add Action > Webhook**.
   - **Method**: `POST`
   - **URL**: `https://TU-WORKER.workers.dev/webhook/ftd` (cambiar el path
     según el evento: `/webhook/lead`, `/webhook/registro`, `/webhook/ftd`,
     `/webhook/venta`)
   - **Headers**:
     - `Authorization: Bearer TU_TOKEN` (el mismo del paso 3)
     - `Content-Type: application/json`
   - **Body** (raw JSON), usando merge tags de GHL:
     ```json
     {
       "contacto_id": "{{contact.id}}",
       "agente": "{{contact.agente_asignado}}",
       "fecha": "{{contact.date_updated}}",
       "monto": "{{contact.monto_ftd}}"
     }
     ```
     - Reemplazá `agente_asignado` y `monto_ftd` por el fieldkey real de tus
       custom fields.
     - Omití `"monto"` por completo en los workflows de **Lead** y
       **Registro** (no es necesario, y si el merge tag no resuelve el
       Worker lo rechaza si no es un número válido).
     - Si `{{contact.date_updated}}` no resuelve bien en tu cuenta, podés
       omitir `"fecha"` directamente: el Worker usa la hora de recepción
       del webhook como fallback.
4. **Publish** el workflow.
5. Repetir para los otros 3 eventos, apuntando cada uno a su path.

### Troubleshooting

- **401 No autorizado**: el header `Authorization` no llegó o no coincide
  con el secreto — revisá que no tenga espacios extra ni comillas de más
  en el campo de GHL.
- **400 con mensaje de validación**: revisá qué merge tag no está
  resolviendo (a veces `contact.id` es lo único garantizado; los custom
  fields dependen del fieldkey exacto).
- GHL reintenta webhooks que fallan; gracias al upsert por
  `(contacto_id, tipo)` un reintento no duplica el conteo en `/metrics`.

## 7. Conectar el frontend

En tu dashboard, reemplazá los datos de ejemplo por:

```js
fetch("https://TU-WORKER.workers.dev/metrics")
  .then((res) => res.json())
  .then((data) => {
    // data.agentes -> array con leads, registros, ftds, ventasUSD, conversion
    // data.metaVentasUSD -> 2400
  });
```
