CREATE TABLE IF NOT EXISTS admin_audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id uuid REFERENCES users(id) ON DELETE SET NULL,
  action text NOT NULL,
  resource_type text NOT NULL,
  resource_id text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_admin_audit_events_created
  ON admin_audit_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_audit_events_resource
  ON admin_audit_events(resource_type, resource_id, created_at DESC);

-- Revisão manual das verificações (também no schema da marketplace-api; repetido
-- aqui para a admin funcionar mesmo se for implantada antes da API principal)
ALTER TABLE verifications ADD COLUMN IF NOT EXISTS review_note text;
ALTER TABLE verifications ADD COLUMN IF NOT EXISTS reviewed_at timestamptz;
ALTER TABLE verifications ADD COLUMN IF NOT EXISTS reviewed_by uuid REFERENCES users(id) ON DELETE SET NULL;

-- Serviço oculto pelo admin (a marketplace-api cria as mesmas colunas; repetido
-- aqui para o painel funcionar seja qual for o serviço publicado primeiro)
ALTER TABLE services ADD COLUMN IF NOT EXISTS hidden_by_admin boolean NOT NULL DEFAULT false;
ALTER TABLE services ADD COLUMN IF NOT EXISTS hidden_reason text;

-- Exceções por prestadora definidas no painel admin: {"finance": true} libera
-- um recurso que o plano não tem; {"team": false} bloqueia um que o plano tem.
-- Chave ausente = segue o plano. Os recursos valem plan_catalog.features || overrides.
CREATE TABLE IF NOT EXISTS provider_feature_overrides (
  provider_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  overrides jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);
