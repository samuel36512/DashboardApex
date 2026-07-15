CREATE TABLE IF NOT EXISTS eventos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contacto_id TEXT NOT NULL,
  agente TEXT NOT NULL,
  tipo TEXT NOT NULL CHECK (tipo IN ('lead', 'registro', 'ftd', 'venta')),
  monto REAL,
  fecha TEXT NOT NULL,
  creado_en TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (contacto_id, tipo)
);

CREATE INDEX IF NOT EXISTS idx_eventos_agente ON eventos (agente);
CREATE INDEX IF NOT EXISTS idx_eventos_tipo ON eventos (tipo);
