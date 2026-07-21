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

-- ============================================================
-- Multi-empresa (varios directores compartiendo un mismo panel).
-- Fase 1: solo esquema aditivo, nada de esto rompe lo que ya existe -
-- las columnas empresa_id quedan nullable hasta que se confirme que
-- todos los datos actuales ya tienen su empresa asignada.
-- ============================================================

-- agentes/perfiles no estaban en este archivo (se crearon a mano en su
-- momento) - se agregan aca con "if not exists" para dejar documentado su
-- esquema real sin tocar lo que ya existe en la base en vivo.
create table if not exists agentes (
  id bigint generated always as identity primary key,
  nombre text not null,
  activo boolean not null default true,
  ghl_user_id text,
  creado_en timestamptz not null default now()
);
create table if not exists perfiles (
  id uuid primary key references auth.users(id),
  rol text not null check (rol in ('director', 'agente')),
  agente_id bigint references agentes(id),
  email text
);
create table if not exists sync_state (
  key text primary key,
  value jsonb
);

-- Una fila por director: credenciales de GHL, hoja de ventas, y las tarifas
-- de negocio que hoy son variables de entorno globales (una sola para toda
-- la empresa) o valores fijos en el codigo.
create table if not exists empresas (
  id bigint generated always as identity primary key,
  nombre text not null,
  activo boolean not null default true,
  creado_en timestamptz not null default now(),

  -- Autentica Y identifica de que director es cada llamada externa
  -- (ghl-sync, ghl-debug, ventas-sync, el webhook de GHL).
  webhook_secret text,

  -- GHL: cada director tiene su propia sub-cuenta.
  ghl_api_token text,
  ghl_location_id text,
  ghl_pipeline_id text,
  ghl_registrado_stage_id text,
  ghl_ftd_stage_id text,

  -- Google Sheets: la cuenta de servicio queda compartida (variable de
  -- entorno global), solo el ID de la hoja es por director.
  ventas_sheet_id text,

  -- Tarifas de negocio, reemplazando 1 a 1 los process.env.* actuales.
  tasa_pauta_ejecutivo_cop numeric not null default 100000,
  tasa_pauta_junior_cop numeric not null default 50000,
  comision_director_base_usd numeric not null default 3,
  comision_director_alta_usd numeric not null default 4,
  umbral_ftd_tasa_alta numeric not null default 1000,
  tasa_comision_director_ventas numeric not null default 0.15,
  comision_por_ftd_usd numeric not null default 8,
  meta_ventas_usd numeric not null default 2400,
  zona_horaria_offset_horas numeric not null default -5
);
create unique index if not exists uq_empresas_webhook_secret on empresas (webhook_secret);
alter table empresas enable row level security;

-- empresa_id en cada tabla existente - nullable por ahora (se llena en el
-- paso de migracion, recien despues se pasa a NOT NULL).
alter table agentes add column if not exists empresa_id bigint references empresas(id);
alter table agentes add column if not exists tier text check (tier in ('ejecutivo', 'junior'));
alter table agentes add column if not exists email_personal text;
create index if not exists idx_agentes_empresa on agentes (empresa_id);

alter table perfiles add column if not exists empresa_id bigint references empresas(id);
create index if not exists idx_perfiles_empresa on perfiles (empresa_id);

alter table eventos add column if not exists empresa_id bigint references empresas(id);
create index if not exists idx_eventos_empresa on eventos (empresa_id);

alter table pauta_estado add column if not exists empresa_id bigint references empresas(id);

alter table sync_state add column if not exists empresa_id bigint references empresas(id);

-- Reemplaza el mapa AGENTE_ALIASES escrito a mano en ventas-sync.ts - cada
-- director junta los suyos a medida que aparecen variantes raras en su hoja.
create table if not exists agente_alias (
  id bigint generated always as identity primary key,
  empresa_id bigint not null references empresas(id),
  alias_normalizado text not null,
  agente_id bigint not null references agentes(id),
  creado_en timestamptz not null default now(),
  unique (empresa_id, alias_normalizado)
);
create index if not exists idx_agente_alias_empresa on agente_alias (empresa_id);
alter table agente_alias enable row level security;
