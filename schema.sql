create table if not exists eventos (
  id bigint generated always as identity primary key,
  contacto_id text not null,
  agente text not null,
  tipo text not null check (tipo in ('lead', 'registro', 'ftd', 'venta')),
  monto numeric,
  contacto_nombre text,
  contacto_telefono text,
  comision numeric,
  producto text,
  fecha timestamptz not null,
  creado_en timestamptz not null default now(),
  unique (contacto_id, tipo)
);

-- Si la tabla ya existia antes de agregar el panel de usuarios registrados/FTD:
alter table eventos add column if not exists contacto_nombre text;
alter table eventos add column if not exists contacto_telefono text;
-- Comision del agente por venta (columna "Comisión" del sheet de ventas), para Ventas del equipo:
alter table eventos add column if not exists comision numeric;
-- Nombre del producto vendido (columna "PRODUCTO" del sheet), para el desglose por producto en Pago de directores:
alter table eventos add column if not exists producto text;

create index if not exists idx_eventos_agente on eventos (agente);
create index if not exists idx_eventos_tipo on eventos (tipo);

-- Sin políticas: solo la service_role key (usada por el backend) puede leer o escribir.
alter table eventos enable row level security;

-- Estado del boton "Pauta desactivada": una sola fila (id=1) que registra si
-- la pauta esta activa ahora mismo y cuantos dias del mes en curso estuvo
-- realmente APAGADA, para que "Costo por FTD" reste esos dias en vez de
-- asumir que el anuncio corrio todos los dias del mes.
create table if not exists pauta_estado (
  id int primary key,
  activa boolean not null default true,
  desde timestamptz not null default now(),
  dias_inactivos_mes numeric not null default 0,
  periodo text not null
);
alter table pauta_estado enable row level security;
