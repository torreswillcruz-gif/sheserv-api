-- Confiança e cadastro (roda depois de payments_schema.sql; seguro repetir):
-- termo de elegibilidade da prestadora (versionado, editável no admin),
-- nome social, os dois selos (dados básicos conferidos pelo admin e prova de
-- vida feita pela instituição de pagamento) e cartões salvos da cliente.

-- ---------- Nome social ----------
ALTER TABLE users ADD COLUMN IF NOT EXISTS social_name text;

-- ---------- Termos ----------
-- Cada edição no admin cria uma versão nova; o cadastro aceita a mais recente.
CREATE TABLE IF NOT EXISTS legal_terms (
  term_key text NOT NULL,
  version int NOT NULL CHECK (version > 0),
  title text NOT NULL,
  body text NOT NULL,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (term_key, version)
);

CREATE TABLE IF NOT EXISTS term_acceptances (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  term_key text NOT NULL,
  version int NOT NULL,
  accepted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, term_key, version),
  FOREIGN KEY (term_key, version) REFERENCES legal_terms (term_key, version)
);

INSERT INTO legal_terms (term_key, version, title, body) VALUES (
  'prestadora_elegibilidade', 1, 'Quem pode se cadastrar como prestadora',
  $term$A SheServe é uma plataforma criada para ampliar a autonomia econômica de mulheres e oferecer às clientes um ambiente de maior segurança. Por essa razão, o cadastro como prestadora de serviços é destinado a mulheres.

Mulheres trans são mulheres e podem se cadastrar como prestadoras em igualdade de condições.

A condição de mulher é verificada por autodeclaração no momento do cadastro. A SheServe não exige exame, laudo, documento com marcador de gênero, fotografia para avaliação de aparência ou qualquer informação sobre o corpo, a saúde ou o histórico pessoal da prestadora.

A SheServe realiza verificação de identidade — confirmação de CPF, telefone e, quando a prestadora ativa o recebimento de pagamentos, validação cadastral e bancária feita pela instituição de pagamento parceira. Essa verificação confirma quem a pessoa é, não o seu gênero.

A prestadora pode informar nome social, que será exibido no perfil.

Declaração falsa quanto à condição de mulher caracteriza violação destes termos e pode levar à suspensão ou ao encerramento do cadastro, por comprometer a finalidade de segurança da plataforma.

A prestadora cuja conta for suspensa ou encerrada por este motivo será informada da decisão e poderá contestá-la, com análise feita por pessoa da equipe e resposta em até X dias úteis.$term$
) ON CONFLICT (term_key, version) DO NOTHING;

-- ---------- Selo 1: dados básicos verificados ----------
-- provider_profiles.verified continua sendo o selo (e o que libera o app);
-- aqui fica o que o admin conferiu (na Serpro, por enquanto à mão).
ALTER TABLE provider_profiles ADD COLUMN IF NOT EXISTS basic_data_check jsonb;
ALTER TABLE provider_profiles ADD COLUMN IF NOT EXISTS basic_data_verified_at timestamptz;

-- ---------- Selo 2: identidade verificada (prova de vida no gateway) ----------
ALTER TABLE provider_payment_accounts ADD COLUMN IF NOT EXISTS kyc_status text NOT NULL DEFAULT 'nao_iniciada';
DO $$ BEGIN
  ALTER TABLE provider_payment_accounts ADD CONSTRAINT provider_payment_accounts_kyc_status_check
    CHECK (kyc_status IN ('nao_iniciada', 'pendente', 'aprovada', 'recusada'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
ALTER TABLE provider_payment_accounts ADD COLUMN IF NOT EXISTS kyc_reason text;
ALTER TABLE provider_payment_accounts ADD COLUMN IF NOT EXISTS kyc_verified_at timestamptz;
ALTER TABLE provider_payment_accounts ADD COLUMN IF NOT EXISTS kyc_link_url text;
ALTER TABLE provider_payment_accounts ADD COLUMN IF NOT EXISTS kyc_link_expires_at timestamptz;

-- ---------- Cartões salvos da cliente ----------
-- Só o id do cartão no gateway e dados de exibição; nunca número nem CVV.
CREATE TABLE IF NOT EXISTS customer_cards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  gateway text NOT NULL,
  gateway_customer_id text,
  gateway_card_id text NOT NULL,
  brand text,
  last4 text NOT NULL CHECK (last4 ~ '^\d{4}$'),
  exp_month int CHECK (exp_month BETWEEN 1 AND 12),
  exp_year int,
  holder_name text,
  is_default boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  UNIQUE (gateway, gateway_card_id)
);
CREATE INDEX IF NOT EXISTS idx_customer_cards_customer ON customer_cards (customer_id) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_customer_cards_default
  ON customer_cards (customer_id) WHERE is_default AND deleted_at IS NULL;

ALTER TABLE charges ADD COLUMN IF NOT EXISTS saved_card_id uuid REFERENCES customer_cards(id);
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS saved_card_id uuid REFERENCES customer_cards(id);

-- Eventos de webhook da prova de vida (KYC) do recebedor
ALTER TABLE payment_webhook_events DROP CONSTRAINT IF EXISTS payment_webhook_events_event_type_check;
ALTER TABLE payment_webhook_events ADD CONSTRAINT payment_webhook_events_event_type_check CHECK (event_type IN (
  'PAYMENT_CONFIRMED', 'PAYMENT_FAILED', 'PAYMENT_REFUNDED', 'RECIPIENT_APPROVED', 'RECIPIENT_REJECTED',
  'RECIPIENT_KYC_APPROVED', 'RECIPIENT_KYC_REJECTED'));

-- MockGateway guarda os cartões salvos como objetos "card"
ALTER TABLE mock_gateway_objects DROP CONSTRAINT IF EXISTS mock_gateway_objects_kind_check;
ALTER TABLE mock_gateway_objects ADD CONSTRAINT mock_gateway_objects_kind_check
  CHECK (kind IN ('recipient', 'charge', 'subscription', 'refund', 'card'));

-- ---------- Agenda da assinatura ----------
-- Recorrência da cliente: [{ serviceId, weekday (1=seg..7=dom), time "HH:MM" }]
CREATE TABLE IF NOT EXISTS subscription_schedules (
  subscription_id uuid PRIMARY KEY REFERENCES subscriptions(id) ON DELETE CASCADE,
  rules jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS schedule_generated_cycle int;
-- Pedido criado pela agenda (já confirmado; pode ser remarcado pela recorrência)
ALTER TABLE orders ADD COLUMN IF NOT EXISTS subscription_schedule boolean NOT NULL DEFAULT false;
-- Sessão do mês que caiu em horário ocupado: ela escolhe uma das opções
CREATE TABLE IF NOT EXISTS subscription_schedule_pending (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id uuid NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  cycle int NOT NULL,
  service_id uuid NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  wanted_at timestamptz NOT NULL,
  alternatives jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_schedule_pending_open
  ON subscription_schedule_pending (subscription_id) WHERE resolved_at IS NULL;
