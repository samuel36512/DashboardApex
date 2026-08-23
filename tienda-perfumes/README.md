# Tienda de Perfumes

Tienda online que vende en automático: el cliente entra, arma su carrito,
paga con **Mercado Pago** y el sistema solo — sin que nadie toque nada —
guarda el pedido, confirma el pago y le avisa por email a tu proveedor
(dropshipping) para que despache. Vos solo cargás el catálogo.

- `public/index.html` — la tienda (catálogo + carrito + checkout). No
  necesita build.
- `public/gracias.html` — pantalla post-pago a la que Mercado Pago redirige
  al cliente.
- `api/productos.ts` — `GET /productos`, catálogo público.
- `api/checkout.ts` — `POST /checkout`, crea el pedido y la preferencia de
  pago en Mercado Pago.
- `api/webhook/mercadopago.ts` — recibe la confirmación de pago de Mercado
  Pago, marca el pedido como pagado y dispara los emails.
- `api/admin/productos.ts` y `api/admin/pedidos.ts` — API protegida para
  cargar productos y ver pedidos (no tiene pantalla propia todavía: se usa
  con curl/Postman, ver más abajo).
- Los datos viven en **Supabase** (Postgres), igual que el dashboard
  hermano de este repo.

## Cómo queda separado del dashboard de ventas

Este código vive en la misma carpeta del repo `DashboardApex` para que lo
puedas revisar todo junto, pero se **deployea como un proyecto de Vercel
aparte** (otro dominio, otras variables de entorno, otra base de Supabase):
al importar el repo en Vercel para este segundo proyecto, en **Root
Directory** elegís `tienda-perfumes`. Así el dashboard de ventas y la
tienda no se pisan entre sí.

---

## Guía de instalación (paso a paso)

### 1. Crear el proyecto en Supabase

Puede ser el mismo proyecto de Supabase del dashboard u otro nuevo — se
recomienda **uno nuevo** para no mezclar datos de ventas con datos de la
tienda.

1. [supabase.com](https://supabase.com) → **New Project** → nombre (ej.
   `tienda-perfumes`) → guardá la contraseña → **Create new project**.
2. **Project Settings → API**: copiá el **Project URL** y la clave
   **`service_role`** (secreta).

### 2. Crear las tablas

1. En Supabase: **SQL Editor → New query**.
2. Pegá el contenido de [`schema.sql`](./schema.sql) y dale a **Run**.

### 3. Cuenta de Mercado Pago

1. Entrá a [mercadopago.com](https://www.mercadopago.com) con la cuenta de
   tu negocio (la que va a recibir el dinero).
2. Andá a **Tus integraciones** → **Crear aplicación** (o usá una que ya
   tengas) → **Credenciales de producción** → copiá el **Access Token**.
3. En la misma aplicación, **Webhooks** → activá notificaciones para
   `Pagos` → copiá la **Firma secreta** (la vas a usar como
   `MP_WEBHOOK_SECRET`; no es obligatoria pero evita que alguien le pegue
   al webhook con datos falsos).

### 4. (Opcional) Email transaccional con Resend

Sin esto la tienda funciona igual (los pedidos se guardan y cobran), solo
que no se manda el mail automático al proveedor ni la confirmación al
cliente.

1. [resend.com](https://resend.com) → creá cuenta (tiene plan gratis) →
   **API Keys → Create API Key**.
2. Verificá un dominio propio en **Domains** para poder mandar desde
   `pedidos@tudominio.com` (si no tenés dominio propio todavía, podés
   arrancar sin esto y sumarlo después).

### 5. Publicar el proyecto en Vercel

1. [vercel.com](https://vercel.com) → **Add New… → Project** → importá el
   repo `samuel36512/DashboardApex`.
2. En **Root Directory**, elegí `tienda-perfumes` (muy importante: si lo
   dejás en blanco, Vercel intenta deployar el dashboard, no la tienda).
3. Antes de darle a Deploy, cargá en **Environment Variables**:

   | Nombre | Valor |
   |---|---|
   | `SUPABASE_URL` | del paso 1 |
   | `SUPABASE_SERVICE_ROLE_KEY` | del paso 1 |
   | `ADMIN_TOKEN` | un texto largo y random que inventes vos |
   | `MP_ACCESS_TOKEN` | del paso 3 |
   | `MP_WEBHOOK_SECRET` | del paso 3 (opcional pero recomendado) |
   | `RESEND_API_KEY` | del paso 4 (opcional) |
   | `EMAIL_FROM` | ej. `Tienda de Perfumes <pedidos@tudominio.com>` (opcional) |
   | `PROVEEDOR_EMAIL` | el email de tu proveedor de dropshipping (opcional) |

4. **Deploy**. Cuando termine, Vercel te da una URL (ej.
   `https://tienda-perfumes.vercel.app`).
5. Volvé a **Settings → Environment Variables** y agregá `SITE_URL` con esa
   misma URL (sin barra final) → **Redeploy** (Vercel no aplica variables
   nuevas hasta el próximo deploy).

### 6. Configurar el webhook en Mercado Pago

1. En **Tus integraciones → tu aplicación → Webhooks**, poné como URL:
   `https://TU-SITIO.vercel.app/webhook/mercadopago`
2. Simulá una notificación de prueba desde ahí mismo para confirmar que
   responde `200`.

### 7. Cargar tu primer producto

Reemplazá `TU-SITIO` y `TU_ADMIN_TOKEN`:

```bash
curl -X POST https://TU-SITIO.vercel.app/admin/productos \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer TU_ADMIN_TOKEN" \
  -d '{
    "nombre": "Bleu Intense 100ml",
    "marca": "Maison Privée",
    "descripcion": "Amaderado, cítrico, larga duración",
    "precio": 45000,
    "imagen_url": "https://tu-imagen.jpg"
  }'
```

Abrí `https://TU-SITIO.vercel.app` y ya debería aparecer en el catálogo.
Para ver todos los productos (activos e inactivos):

```bash
curl https://TU-SITIO.vercel.app/admin/productos \
  -H "Authorization: Bearer TU_ADMIN_TOKEN"
```

Para editar (parcial, solo mandás los campos que cambian) o dar de baja:

```bash
curl -X PUT https://TU-SITIO.vercel.app/admin/productos \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer TU_ADMIN_TOKEN" \
  -d '{"id": 1, "precio": 48000, "disponible": false}'

curl -X DELETE "https://TU-SITIO.vercel.app/admin/productos?id=1" \
  -H "Authorization: Bearer TU_ADMIN_TOKEN"
```

### 8. Ver pedidos

```bash
curl https://TU-SITIO.vercel.app/admin/pedidos \
  -H "Authorization: Bearer TU_ADMIN_TOKEN"

# Solo los pagados, pendientes de despachar:
curl "https://TU-SITIO.vercel.app/admin/pedidos?estado=pagado" \
  -H "Authorization: Bearer TU_ADMIN_TOKEN"
```

También podés ver la tabla cruda en Supabase: **Table Editor → pedidos**.

### 9. Probar una compra real

Comprate a vos mismo un producto de bajo valor para validar el flujo
completo: agregar al carrito → completar dirección → pagar en Mercado
Pago → volver a `gracias.html` → recibir el email de confirmación → que
llegue el email al proveedor → ver el pedido en `estado: "pagado"` en
`/admin/pedidos`.

### Troubleshooting

- **El checkout no redirige a Mercado Pago**: revisá que `MP_ACCESS_TOKEN`
  sea el de **producción** (no el de prueba/test, que solo funciona con
  tarjetas ficticias) y que esté bien cargado en Vercel.
- **El pedido queda en "pendiente" para siempre después de pagar**:
  confirmá que el webhook esté apuntando a
  `/webhook/mercadopago` (no a `/api/webhook/mercadopago`) y que
  `SITE_URL` sea exactamente tu dominio de Vercel.
- **401 en el webhook**: `MP_WEBHOOK_SECRET` no coincide con la firma
  secreta real de tu aplicación en Mercado Pago — copiala de nuevo desde
  ahí.
- **No llegan los emails**: revisá que `RESEND_API_KEY`, `EMAIL_FROM` y
  (para el aviso al proveedor) `PROVEEDOR_EMAIL` estén cargadas; si tu
  dominio en Resend no está verificado, los envíos fallan silenciosamente
  (a propósito: un email caído nunca debe bloquear un pago ya cobrado).

## Desarrollo local (opcional)

```bash
npm install
cp .env.example .env.local   # completar con tus valores reales
npm run dev                  # levanta el sitio + las funciones en localhost
npm run typecheck            # verifica los tipos de TypeScript
```

## Qué falta para crecer

Esto es un MVP funcional pero minimalista. Cosas típicas que vas a querer
sumar más adelante, en orden de prioridad real:

1. **Un panel visual de administración** (hoy cargar productos es por
   curl/API) — un `admin.html` protegido con el mismo `ADMIN_TOKEN`.
2. **Fotos por variante** (talle, ml, si vendés el mismo perfume en más de
   un tamaño) — hoy cada tamaño necesitaría ser un producto distinto.
3. **Costo de envío** — hoy el total no incluye flete; se puede sumar como
   un ítem más en la preferencia de Mercado Pago.
4. **Cupones/descuentos**.
