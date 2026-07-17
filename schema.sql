create table if not exists eventos (
  id bigint generated always as identity primary key,
  contacto_id text not null,
  agente text not null,
  tipo text not null check (tipo in ('lead', 'registro', 'ftd', 'venta')),
  monto numeric,
  contacto_nombre text,
  contacto_telefono text,
  comision numeric,
  fecha timestamptz not null,
  creado_en timestamptz not null default now(),
  unique (contacto_id, tipo)
);

-- Si la tabla ya existia antes de agregar el panel de usuarios registrados/FTD:
alter table eventos add column if not exists contacto_nombre text;
alter table eventos add column if not exists contacto_telefono text;
-- Comision del agente por venta (columna "Comisión" del sheet de ventas), para Ventas del equipo:
alter table eventos add column if not exists comision numeric;

create index if not exists idx_eventos_agente on eventos (agente);
create index if not exists idx_eventos_tipo on eventos (tipo);

-- Sin políticas: solo la service_role key (usada por el backend) puede leer o escribir.
alter table eventos enable row level security;
