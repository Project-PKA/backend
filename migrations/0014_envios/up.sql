-- 0014_envios: fila de envios das vendas pagas (a enviar, enviado, entregue). Sem envio automático
-- de mensagem (ADR 0006): a loja avisa o cliente por conta própria.
CREATE TYPE shipment_status AS ENUM ('TO_SHIP', 'SHIPPED', 'DELIVERED');

CREATE TABLE shipments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id uuid NOT NULL REFERENCES stores (id) ON DELETE CASCADE,
  settlement_id uuid NOT NULL,
  status shipment_status NOT NULL DEFAULT 'TO_SHIP',
  tracking_code text,
  shipped_at timestamptz,
  delivered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT shipments_id_store_key UNIQUE (id, store_id),
  -- Um acerto tem no máximo um envio, e o acerto precisa ser da mesma loja.
  CONSTRAINT shipments_settlement_key UNIQUE (settlement_id),
  CONSTRAINT shipments_settlement_fkey FOREIGN KEY (settlement_id, store_id)
    REFERENCES settlements (id, store_id),
  CONSTRAINT shipments_tracking_format
    CHECK (tracking_code IS NULL OR tracking_code ~ '^[A-Za-z0-9._/-]{4,60}$'),
  -- As datas acompanham o estado.
  CONSTRAINT shipments_dates_match_status CHECK (
    (status = 'TO_SHIP' AND shipped_at IS NULL AND delivered_at IS NULL)
    OR (status = 'SHIPPED' AND shipped_at IS NOT NULL AND delivered_at IS NULL)
    OR (status = 'DELIVERED' AND shipped_at IS NOT NULL AND delivered_at IS NOT NULL)
  )
);
CREATE INDEX shipments_store_status_idx ON shipments (store_id, status);

-- Mesma regra das demais tabelas de loja (ADR 0011). Envio é histórico: não se apaga.
GRANT SELECT, INSERT, UPDATE ON shipments TO app_runtime;
ALTER TABLE shipments ENABLE ROW LEVEL SECURITY;
ALTER TABLE shipments FORCE ROW LEVEL SECURITY;
CREATE POLICY store_isolation ON shipments TO app_runtime
  USING (store_id = app_current_store()) WITH CHECK (store_id = app_current_store());
