-- Catálogo. "disponible" lo apagás vos cuando el proveedor se queda sin
-- stock de un perfume puntual, sin borrar el producto ni su historial en
-- pedidos ya hechos.
create table if not exists productos (
  id bigint generated always as identity primary key,
  nombre text not null,
  marca text,
  descripcion text,
  precio numeric not null check (precio >= 0),
  imagen_url text,
  activo boolean not null default true,
  disponible boolean not null default true,
  creado_en timestamptz not null default now()
);
alter table productos enable row level security;

-- Un pedido por compra. "items" guarda una foto de qué se compró (nombre,
-- precio y cantidad en ese momento) para que un cambio de precio futuro en
-- "productos" no altere el historial de ventas ya facturadas.
create table if not exists pedidos (
  id bigint generated always as identity primary key,
  cliente_nombre text not null,
  cliente_email text not null,
  cliente_telefono text,
  direccion jsonb not null,
  items jsonb not null,
  total numeric not null check (total >= 0),
  estado text not null default 'pendiente'
    check (estado in ('pendiente', 'pagado', 'fallido', 'cancelado', 'enviado_proveedor')),
  mp_preference_id text,
  mp_payment_id text,
  creado_en timestamptz not null default now(),
  actualizado_en timestamptz not null default now()
);
create index if not exists idx_pedidos_estado on pedidos (estado);
create index if not exists idx_pedidos_mp_preference on pedidos (mp_preference_id);
alter table pedidos enable row level security;

-- Sin políticas: solo la service_role key (usada por el backend) puede leer
-- o escribir estas tablas, igual que en el resto del proyecto.
