# DashboardApex

Backend + panel de conversión de ventas para un equipo comercial que recibe
leads en GoHighLevel (GHL). Todo vive en **un solo proyecto de Vercel**:

- `public/index.html` — el panel visual (dashboard). No necesita build ni
  configuración: se conecta solo a `/metrics` porque vive en el mismo sitio.
- `api/webhook/[tipo].ts` — recibe los 4 eventos desde GHL:
  `/webhook/lead`, `/webhook/registro`, `/webhook/ftd`, `/webhook/venta`.
- `api/metrics.ts` — `GET /metrics`, agrupa por agente y calcula las
  conversiones.
- Los datos se guardan en una tabla `eventos` en **Supabase** (Postgres).

## Por qué Vercel + Supabase

Elegimos esto porque ya tenés esas dos cuentas creadas: no hace falta abrir
ninguna cuenta nueva, y todo (panel + backend) se publica junto con un solo
"Deploy" en Vercel. Supabase además te da una tabla visual (como un Excel)
para ver los eventos a mano si alguna vez lo necesitás, sin usar la
terminal.

## Cómo está protegido

- Los 4 endpoints de webhook exigen un header `Authorization: Bearer <token>`
  que vos definís (nunca vive en el código, es una variable de entorno en
  Vercel).
- `GET /metrics` es público (sin restricción), tal como pediste.
- La base de datos tiene Row Level Security activado sin políticas: solo la
  clave secreta del backend (`service_role`, que nunca sale del servidor)
  puede leerla o escribirla.

---

## Guía de instalación (paso a paso)

### 1. Crear el proyecto en Supabase

1. Entrá a [supabase.com](https://supabase.com) con tu cuenta.
2. **New Project** → ponele un nombre (ej. `dashboardapex`) → generá y
   guardá la contraseña de la base de datos en un lugar seguro → **Create
   new project**. Tarda 1-2 minutos.
3. Andá a **Project Settings** (ícono de engranaje) → **API**. Ahí vas a
   ver dos datos que vamos a necesitar en el paso 3:
   - **Project URL**
   - **Project API keys → `service_role`** (marcada como secreta — no la
     compartas públicamente, solo va a vivir dentro de Vercel).

### 2. Crear la tabla `eventos`

1. En Supabase, andá a **SQL Editor** → **New query**.
2. Copiá y pegá todo el contenido del archivo [`schema.sql`](./schema.sql)
   de este repositorio.
3. Click en **Run**. Deberías ver "Success. No rows returned".

### 3. Publicar el proyecto en Vercel

1. Entrá a [vercel.com](https://vercel.com) con tu cuenta.
2. **Add New… → Project** → importá el repositorio
   `samuel36512/DashboardApex` (rama `claude/friendly-darwin-3rj7m4`, o la
   rama principal si ya la fusionaste).
3. Antes de darle a Deploy, abrí **Environment Variables** y cargá estas 4:

   | Nombre | Valor |
   |---|---|
   | `SUPABASE_URL` | el "Project URL" del paso 1 |
   | `SUPABASE_SERVICE_ROLE_KEY` | la clave `service_role` del paso 1 |
   | `WEBHOOK_SECRET` | un texto largo y random que inventes vos (por ejemplo, generalo en [1password.com/password-generator](https://1password.com/password-generator) o similar) — **guardalo**, lo vas a necesitar en GHL |
   | `META_VENTAS_USD` | `2400` |

4. Click en **Deploy**. Tarda menos de un minuto.
5. Cuando termine, Vercel te da una URL pública (ej.
   `https://dashboardapex.vercel.app`). Abrila: ya deberías ver el panel
   (vacío, porque todavía no llegó ningún evento).

### 4. Probar que el backend funciona

Reemplazá `TU-SITIO` y `TU_TOKEN` (el `WEBHOOK_SECRET` que inventaste) y
corré esto desde una terminal:

```bash
# Debe fallar con 401 (sin token)
curl -X POST https://TU-SITIO.vercel.app/webhook/lead \
  -H "Content-Type: application/json" \
  -d '{"contacto_id":"c1","agente":"Juan Perez","fecha":"2026-07-15T10:00:00Z"}'

# Con token, debe dar 201
curl -X POST https://TU-SITIO.vercel.app/webhook/lead \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer TU_TOKEN" \
  -d '{"contacto_id":"c1","agente":"Juan Perez","fecha":"2026-07-15T10:00:00Z"}'

curl -X POST https://TU-SITIO.vercel.app/webhook/registro \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer TU_TOKEN" \
  -d '{"contacto_id":"c1","agente":"Juan Perez","fecha":"2026-07-15T10:05:00Z"}'

curl -X POST https://TU-SITIO.vercel.app/webhook/ftd \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer TU_TOKEN" \
  -d '{"contacto_id":"c1","agente":"Juan Perez","fecha":"2026-07-15T10:10:00Z","monto":50}'

curl -X POST https://TU-SITIO.vercel.app/webhook/venta \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer TU_TOKEN" \
  -d '{"contacto_id":"c1","agente":"Juan Perez","fecha":"2026-07-15T10:20:00Z","monto":2400}'

curl https://TU-SITIO.vercel.app/metrics
```

Después de eso, si abrís `https://TU-SITIO.vercel.app` en el navegador (o
esperás el refresco automático, cada minuto) deberías ver a "Juan Perez"
con 1 lead, 1 registro, 1 FTD y $2,400 en ventas.

También podés ver la fila cruda en Supabase: **Table Editor → eventos**.

### 5. Configurar los Workflows en GoHighLevel

Necesitás 4 workflows (uno por evento). Antes de empezar, confirmá en
**Settings → Custom Fields** el *fieldkey* exacto de "Agente asignado" y de
los campos de monto de FTD y de venta (los vas a necesitar para los merge
tags).

Para cada evento (Lead, Registro, FTD, Venta):

1. **Automation → Workflows → Create Workflow**.
2. **Trigger**: `Contact Tag` (o el trigger que uses hoy para marcar ese
   evento) = la tag correspondiente (ej. `FTD`).
3. **Add Action → Webhook**.
   - **Method**: `POST`
   - **URL**: `https://TU-SITIO.vercel.app/webhook/ftd` (cambiar el path
     según el evento: `/webhook/lead`, `/webhook/registro`, `/webhook/ftd`,
     `/webhook/venta`)
   - **Headers**:
     - `Authorization: Bearer TU_TOKEN` (el mismo `WEBHOOK_SECRET` del
       paso 3)
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
       **Registro**.
     - Si `{{contact.date_updated}}` no resuelve bien en tu cuenta, podés
       omitir `"fecha"` directamente: el backend usa la hora de recepción
       del webhook como respaldo.
4. **Publish** el workflow.
5. Repetir para los otros 3 eventos, apuntando cada uno a su path.

### Troubleshooting

- **401 No autorizado**: el header `Authorization` no llegó o no coincide
  con `WEBHOOK_SECRET` — revisá que no tenga espacios extra ni comillas de
  más en el campo de GHL, y que la variable esté bien cargada en Vercel.
- **400 con mensaje de validación**: revisá qué merge tag no está
  resolviendo (a veces `contact.id` es lo único garantizado; los custom
  fields dependen del fieldkey exacto).
- **500 / "Error guardando el evento"**: normalmente significa que
  `SUPABASE_URL` o `SUPABASE_SERVICE_ROLE_KEY` están mal cargadas en
  Vercel, o que la tabla `eventos` no se creó (repetí el paso 2).
- GHL reintenta webhooks que fallan; gracias al upsert por
  `(contacto_id, tipo)` un reintento no duplica el conteo en `/metrics`.

## Desarrollo local (opcional)

```bash
npm install
cp .env.example .env.local   # completar con tus valores reales
npm run dev                  # levanta el sitio + las funciones en localhost
npm run typecheck            # verifica los tipos de TypeScript
```
