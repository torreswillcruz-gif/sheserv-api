-- Módulo de pagamentos (modo demonstração sobre o MockGateway; modelado no
-- formato do Pagar.me). Roda depois de schema.sql, no mesmo estilo: pode ser
-- executado em todo start sem efeito repetido.
--
-- Regras que o esquema garante:
-- - dinheiro sempre em centavos, integer (o driver pg devolve bigint como
--   string; por isso integer, e somas com ::int nas queries);
-- - nenhum id genérico de gateway: colunas gateway + gateway_*_id, porque numa
--   troca de PSP os dois coexistem;
-- - cada cobrança guarda o snapshot da configuração usada (nunca recalcular).

-- Migrações que só podem rodar uma vez (mexem em dado que o admin edita depois)
CREATE TABLE IF NOT EXISTS schema_markers (
  name text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

-- ---------- Camadas da prestadora: Premium entra no Pro ----------
-- Pro passa a ter tudo o que existe hoje (inclusive a equipe do Premium),
-- propostas ilimitadas e as estatísticas avançadas de assinaturas.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM schema_markers WHERE name = 'payments_merge_premium_into_pro') THEN
    UPDATE plan_catalog SET
      features = features || '{"finance":true,"inventory":true,"clients":true,"statistics":true,"promotions":true,"team":true,"branding":true,"invoices":true,"custom_quotes":true,"advanced_stats":true}'::jsonb,
      monthly_approval_limit = NULL,
      description = 'Tudo do SheServe: assinantes ilimitadas, equipe e estatísticas avançadas.',
      updated_at = now()
    WHERE plan_code = 'pro';
    UPDATE plan_catalog SET active = false, updated_at = now() WHERE plan_code = 'premium';
    UPDATE provider_plans SET plan_name = 'pro', monthly_approval_limit = NULL, updated_at = now()
    WHERE plan_name = 'premium';
    INSERT INTO schema_markers (name) VALUES ('payments_merge_premium_into_pro');
  END IF;
END;
$$;
UPDATE plan_catalog SET features = features || jsonb_build_object('advanced_stats', plan_code = 'pro')
WHERE NOT features ? 'advanced_stats';

ALTER TABLE provider_plans ADD COLUMN IF NOT EXISTS tier_changed_at timestamptz;
ALTER TABLE provider_plans ADD COLUMN IF NOT EXISTS previous_plan_name text;
-- Próxima cobrança da mensalidade da camada (descontada dos repasses)
ALTER TABLE provider_plans ADD COLUMN IF NOT EXISTS tier_billed_until timestamptz;

-- ---------- Municípios do lançamento ----------
CREATE TABLE IF NOT EXISTS municipalities (
  ibge_code text PRIMARY KEY CHECK (ibge_code ~ '^\d{7}$'),
  name text NOT NULL,
  uf text NOT NULL CHECK (uf ~ '^[A-Z]{2}$'),
  launched boolean NOT NULL DEFAULT false
);
INSERT INTO municipalities (ibge_code, name, uf, launched) VALUES
  ('3128709', 'Guaxupé', 'MG', true),
  ('3101607', 'Alfenas', 'MG', true)
ON CONFLICT (ibge_code) DO NOTHING;

-- Item da LC 116 e alíquota de ISS pré-preenchidos por município (e, se
-- houver, por categoria). A prestadora só confirma. confirmed=false: valor
-- provisório, ainda não conferido com a prefeitura.
CREATE TABLE IF NOT EXISTS municipal_service_defaults (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ibge_code text NOT NULL REFERENCES municipalities(ibge_code),
  category_id text REFERENCES categories(id) ON DELETE CASCADE,
  item_servico text NOT NULL CHECK (item_servico ~ '^\d{1,2}\.\d{2}$'),
  aliquota_iss_bps int NOT NULL CHECK (aliquota_iss_bps BETWEEN 0 AND 500),
  confirmed boolean NOT NULL DEFAULT false
);
CREATE UNIQUE INDEX IF NOT EXISTS municipal_service_defaults_key
  ON municipal_service_defaults (ibge_code, COALESCE(category_id, ''));
-- Padrão do município: 6.01 (cabeleireiros, manicures e congêneres), 2% (mínimo legal)
INSERT INTO municipal_service_defaults (ibge_code, category_id, item_servico, aliquota_iss_bps)
SELECT ibge_code, NULL, '6.01', 200 FROM municipalities
ON CONFLICT DO NOTHING;
-- Limpeza: 7.10
INSERT INTO municipal_service_defaults (ibge_code, category_id, item_servico, aliquota_iss_bps)
SELECT m.ibge_code, c.id, '7.10', 200 FROM municipalities m CROSS JOIN categories c
WHERE c.id = 'cleaning'
ON CONFLICT DO NOTHING;

-- Cidade de atuação da prestadora: escolhe o override de configuração
ALTER TABLE provider_profiles ADD COLUMN IF NOT EXISTS city_code text REFERENCES municipalities(ibge_code);

-- ---------- Configuração (global + override por cidade) ----------
-- Linha 'global' com tudo preenchido; linha por cidade com NULL = herda.
CREATE TABLE IF NOT EXISTS payment_settings (
  scope_key text PRIMARY KEY CHECK (scope_key = 'global' OR scope_key ~ '^\d{7}$'),
  fee_fixed_cents int CHECK (fee_fixed_cents >= 0),
  fee_percent_bps int CHECK (fee_percent_bps BETWEEN 0 AND 5000),
  fee_payer text CHECK (fee_payer IN ('cliente', 'prestadora')),
  rounding_mode text CHECK (rounding_mode IN ('half_up', 'half_even', 'floor', 'ceil')),
  activation_fee_cents int CHECK (activation_fee_cents >= 0),
  activation_fee_installments int CHECK (activation_fee_installments BETWEEN 1 AND 52),
  free_max_active_subscribers int CHECK (free_max_active_subscribers >= 0),
  standard_price_cents int CHECK (standard_price_cents >= 0),
  pro_price_cents int CHECK (pro_price_cents >= 0),
  retry_max_attempts int CHECK (retry_max_attempts BETWEEN 0 AND 10),
  retry_interval_days int CHECK (retry_interval_days BETWEEN 1 AND 30),
  suspension_grace_days int CHECK (suspension_grace_days BETWEEN 0 AND 180),
  entitlement_refund_window_hours int CHECK (entitlement_refund_window_hours BETWEEN 0 AND 720),
  payout_interval text CHECK (payout_interval IN ('semanal', 'mensal')),
  payout_day int CHECK (payout_day BETWEEN 1 AND 28),
  settlement_days_card int CHECK (settlement_days_card BETWEEN 0 AND 60),
  settlement_days_pix int CHECK (settlement_days_pix BETWEEN 0 AND 60),
  gateway_cost_card_fixed_cents int CHECK (gateway_cost_card_fixed_cents >= 0),
  gateway_cost_card_bps int CHECK (gateway_cost_card_bps BETWEEN 0 AND 2000),
  gateway_cost_pix_fixed_cents int CHECK (gateway_cost_pix_fixed_cents >= 0),
  gateway_cost_pix_bps int CHECK (gateway_cost_pix_bps BETWEEN 0 AND 2000),
  mock_failure_rate_bps int CHECK (mock_failure_rate_bps BETWEEN 0 AND 10000),
  mock_latency_ms int CHECK (mock_latency_ms BETWEEN 0 AND 30000),
  version int NOT NULL DEFAULT 1,
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- semanal: dia da semana ISO 1 (segunda) a 5 (sexta)
  CHECK (payout_interval IS DISTINCT FROM 'semanal' OR payout_day BETWEEN 1 AND 5),
  -- mock só na configuração global
  CHECK (scope_key = 'global' OR (mock_failure_rate_bps IS NULL AND mock_latency_ms IS NULL)),
  CHECK (scope_key <> 'global' OR (
    fee_fixed_cents IS NOT NULL AND fee_percent_bps IS NOT NULL AND fee_payer IS NOT NULL
    AND rounding_mode IS NOT NULL AND activation_fee_cents IS NOT NULL
    AND activation_fee_installments IS NOT NULL AND free_max_active_subscribers IS NOT NULL
    AND standard_price_cents IS NOT NULL AND pro_price_cents IS NOT NULL
    AND retry_max_attempts IS NOT NULL AND retry_interval_days IS NOT NULL AND suspension_grace_days IS NOT NULL
    AND entitlement_refund_window_hours IS NOT NULL AND payout_interval IS NOT NULL
    AND payout_day IS NOT NULL AND settlement_days_card IS NOT NULL AND settlement_days_pix IS NOT NULL
    AND gateway_cost_card_fixed_cents IS NOT NULL AND gateway_cost_card_bps IS NOT NULL
    AND gateway_cost_pix_fixed_cents IS NOT NULL AND gateway_cost_pix_bps IS NOT NULL
    AND mock_failure_rate_bps IS NOT NULL AND mock_latency_ms IS NOT NULL))
);
-- Padrões: taxa R$ 0,99 + 4%, paga pela cliente; ativação 0; Free até 5
-- assinantes; repasse semanal às segundas. Preços das camadas e custos do
-- gateway são provisórios: ajuste no admin ao contrato real.
INSERT INTO payment_settings (
  scope_key, fee_fixed_cents, fee_percent_bps, fee_payer, rounding_mode,
  activation_fee_cents, activation_fee_installments, free_max_active_subscribers,
  standard_price_cents, pro_price_cents, retry_max_attempts, retry_interval_days, suspension_grace_days,
  entitlement_refund_window_hours, payout_interval, payout_day,
  settlement_days_card, settlement_days_pix,
  gateway_cost_card_fixed_cents, gateway_cost_card_bps, gateway_cost_pix_fixed_cents, gateway_cost_pix_bps,
  mock_failure_rate_bps, mock_latency_ms
) VALUES (
  'global', 99, 400, 'cliente', 'half_up',
  0, 1, 5,
  2990, 5990, 3, 2, 30,
  24, 'semanal', 1,
  30, 1,
  0, 399, 0, 119,
  0, 1500
) ON CONFLICT (scope_key) DO NOTHING;

CREATE TABLE IF NOT EXISTS payment_settings_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_key text NOT NULL,
  field text NOT NULL,
  old_value jsonb,
  new_value jsonb,
  action text NOT NULL CHECK (action IN ('update', 'reprice_existing')),
  reason text,
  changed_by uuid REFERENCES users(id) ON DELETE SET NULL,
  changed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_payment_settings_audit ON payment_settings_audit (changed_at DESC);

-- ---------- Recebedor da prestadora ----------
-- Ela não tem conta nem login no PSP: o recebedor é criado por API com os
-- dados bancários, e todo o painel dela é o app.
CREATE TABLE IF NOT EXISTS provider_payment_accounts (
  provider_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  gateway text NOT NULL,
  gateway_recipient_id text,
  status text NOT NULL DEFAULT 'pendente'
    CHECK (status IN ('pendente', 'em_analise', 'aprovada', 'recusada', 'desativada')),
  status_reason text,
  holder_name text NOT NULL,
  holder_document_type text NOT NULL CHECK (holder_document_type IN ('cpf', 'cnpj')),
  holder_document_encrypted text NOT NULL,
  bank_code text NOT NULL CHECK (bank_code ~ '^\d{3}$'),
  branch text NOT NULL CHECK (branch ~ '^\d{1,5}$'),
  branch_digit text CHECK (branch_digit ~ '^[0-9Xx]$'),
  account_type text NOT NULL CHECK (account_type IN ('corrente', 'poupanca')),
  account_encrypted text NOT NULL,
  account_last4 text NOT NULL,
  -- NULL = segue a configuração da cidade
  payout_interval text CHECK (payout_interval IN ('semanal', 'mensal')),
  payout_day int CHECK (payout_day BETWEEN 1 AND 28),
  -- primeira vez que ativou planos de assinatura (cobra a ativação)
  plans_activated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (gateway, gateway_recipient_id)
);

-- ---------- Descontos nos repasses (ativação e mensalidade da camada) ----------
-- Nunca cobrados antes: saem da parte da prestadora no split das próximas
-- cobranças. Mês sem receita: o saldo continua para o seguinte.
CREATE TABLE IF NOT EXISTS provider_deductions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- estorno: cobrança estornada depois de já repassada à prestadora
  kind text NOT NULL CHECK (kind IN ('ativacao', 'camada', 'estorno')),
  description text NOT NULL,
  amount_cents int NOT NULL CHECK (amount_cents > 0),
  -- máximo por janela de repasse (ativação em N repasses); NULL = sem teto
  per_payout_cap_cents int CHECK (per_payout_cap_cents > 0),
  settings_snapshot jsonb NOT NULL,
  reference text, -- ex.: 'camada:standard:2026-11'
  settled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider_id, reference)
);
CREATE INDEX IF NOT EXISTS idx_provider_deductions_open ON provider_deductions (provider_id, created_at)
  WHERE settled_at IS NULL;

-- ---------- Planos que a prestadora oferece às clientes ----------
CREATE TABLE IF NOT EXISTS subscription_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text,
  price_cents int NOT NULL CHECK (price_cents > 0), -- o que ela recebe por ciclo
  interval_unit text NOT NULL DEFAULT 'month' CHECK (interval_unit IN ('week', 'month')),
  interval_count int NOT NULL DEFAULT 1 CHECK (interval_count BETWEEN 1 AND 12),
  max_subscribers int CHECK (max_subscribers > 0), -- limite de clientes do plano
  status text NOT NULL DEFAULT 'ativo' CHECK (status IN ('ativo', 'pausado', 'arquivado')),
  reserved_slot text, -- horário reservado, se houver (ex.: "Sábados às 9h")
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_subscription_plans_provider ON subscription_plans (provider_id, status);

-- Serviços incluídos (só de atendimento no espaço da prestadora). O preço
-- avulso vem do cadastro do serviço (services.base_price), não daqui.
CREATE TABLE IF NOT EXISTS subscription_plan_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id uuid NOT NULL REFERENCES subscription_plans(id) ON DELETE CASCADE,
  service_id uuid NOT NULL REFERENCES services(id),
  sessions_per_cycle int NOT NULL CHECK (sessions_per_cycle BETWEEN 1 AND 60),
  UNIQUE (plan_id, service_id)
);

-- ---------- Assinaturas ----------
CREATE TABLE IF NOT EXISTS subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES users(id),
  provider_id uuid NOT NULL REFERENCES users(id),
  plan_id uuid NOT NULL REFERENCES subscription_plans(id),
  status text NOT NULL DEFAULT 'pendente'
    CHECK (status IN ('pendente', 'ativa', 'em_retentativa', 'suspensa', 'cancelada')),
  -- preço contratado: renovações usam estes valores, nunca a configuração atual
  provider_amount_cents int NOT NULL CHECK (provider_amount_cents >= 0),
  fee_cents int NOT NULL CHECK (fee_cents >= 0),
  total_cents int NOT NULL CHECK (total_cents > 0),
  fee_payer text NOT NULL CHECK (fee_payer IN ('cliente', 'prestadora')),
  settings_snapshot jsonb NOT NULL,
  settings_version int NOT NULL,
  -- "aplicar às existentes" (admin): novo preço a partir do próximo ciclo
  next_cycle_pricing jsonb,
  next_cycle_pricing_synced_at timestamptz,
  -- split vigente no gateway (muda quando há desconto de repasse no ciclo)
  current_split jsonb,
  billing_anchor_day smallint NOT NULL CHECK (billing_anchor_day BETWEEN 1 AND 31),
  interval_unit text NOT NULL CHECK (interval_unit IN ('week', 'month')),
  interval_count int NOT NULL,
  started_at timestamptz,
  current_cycle int NOT NULL DEFAULT 0,
  current_period_start timestamptz,
  current_period_end timestamptz,
  cancel_at_period_end boolean NOT NULL DEFAULT false,
  cancel_requested_at timestamptz,
  canceled_at timestamptz,
  cancel_reason text,
  retry_attempt int NOT NULL DEFAULT 0,
  next_retry_at timestamptz,
  suspended_at timestamptz,
  payment_method text NOT NULL DEFAULT 'cartao' CHECK (payment_method = 'cartao'),
  card_last4 text,
  card_brand text,
  -- token do cartão só até o gateway aceitar a assinatura (cifrado); depois, NULL
  pending_card_token_encrypted text,
  gateway text NOT NULL,
  gateway_subscription_id text,
  idempotency_key text NOT NULL UNIQUE,
  request_fingerprint text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (total_cents = provider_amount_cents + fee_cents),
  UNIQUE (gateway, gateway_subscription_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS subscriptions_one_open_per_plan
  ON subscriptions (customer_id, plan_id) WHERE status <> 'cancelada';
CREATE INDEX IF NOT EXISTS idx_subscriptions_provider ON subscriptions (provider_id, status);
CREATE INDEX IF NOT EXISTS idx_subscriptions_customer ON subscriptions (customer_id, status);

CREATE TABLE IF NOT EXISTS subscription_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id uuid NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  from_status text,
  to_status text NOT NULL,
  event text NOT NULL,
  reason text,
  actor_id uuid REFERENCES users(id) ON DELETE SET NULL,
  webhook_event_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_subscription_events ON subscription_events (subscription_id, created_at);

-- ---------- Direitos de agendamento ----------
-- Um por serviço do plano por ciclo. Congelado = derivado do status da
-- assinatura (em_retentativa); zerado = voided_at. Não acumulam: cada ciclo
-- tem a própria linha.
CREATE TABLE IF NOT EXISTS entitlements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id uuid NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL REFERENCES users(id),
  provider_id uuid NOT NULL REFERENCES users(id),
  service_id uuid NOT NULL REFERENCES services(id),
  cycle int NOT NULL,
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL,
  sessions_granted int NOT NULL CHECK (sessions_granted >= 0),
  sessions_used int NOT NULL DEFAULT 0 CHECK (sessions_used >= 0),
  voided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (subscription_id, service_id, cycle),
  CHECK (sessions_used <= sessions_granted)
);

CREATE TABLE IF NOT EXISTS entitlement_usages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entitlement_id uuid NOT NULL REFERENCES entitlements(id) ON DELETE CASCADE,
  order_id uuid NOT NULL UNIQUE REFERENCES orders(id),
  status text NOT NULL DEFAULT 'debitado' CHECK (status IN ('debitado', 'devolvido')),
  debited_at timestamptz NOT NULL DEFAULT now(),
  returned_at timestamptz
);

-- ---------- Cobranças ----------
CREATE TABLE IF NOT EXISTS charges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  origin text NOT NULL CHECK (origin IN ('assinatura', 'avulso')),
  subscription_id uuid REFERENCES subscriptions(id),
  subscription_cycle int,
  order_id uuid REFERENCES orders(id),
  customer_id uuid NOT NULL REFERENCES users(id),
  provider_id uuid NOT NULL REFERENCES users(id),
  -- titular da cobrança: no Pagar.me nasce na conta da plataforma; no Asaas
  -- nasceria na subconta da prestadora (recebedor)
  charge_owner text NOT NULL CHECK (charge_owner IN ('plataforma', 'recebedor')),
  total_cents int NOT NULL CHECK (total_cents > 0),
  fee_cents int NOT NULL CHECK (fee_cents >= 0),
  provider_amount_cents int NOT NULL CHECK (provider_amount_cents >= 0),
  deduction_cents int NOT NULL DEFAULT 0 CHECK (deduction_cents >= 0),
  fee_payer text NOT NULL CHECK (fee_payer IN ('cliente', 'prestadora')),
  status text NOT NULL DEFAULT 'pendente'
    CHECK (status IN ('pendente', 'processando', 'paga', 'falhou', 'estornada', 'estornada_parcial')),
  attempt int NOT NULL DEFAULT 1,
  payment_method text NOT NULL CHECK (payment_method IN ('pix', 'cartao')),
  idempotency_key text NOT NULL UNIQUE,
  request_fingerprint text NOT NULL,
  gateway text NOT NULL,
  gateway_charge_id text,
  pix_copy_paste text,
  -- token do cartão só até o gateway receber a cobrança (cifrado); depois, NULL
  pending_card_token_encrypted text,
  settings_snapshot jsonb NOT NULL,
  settings_version int NOT NULL,
  failure_code text,
  failure_message text,
  paid_at timestamptz,
  failed_at timestamptz,
  refunded_cents int NOT NULL DEFAULT 0 CHECK (refunded_cents >= 0),
  refunded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (total_cents = provider_amount_cents + fee_cents),
  CHECK (deduction_cents <= provider_amount_cents),
  CHECK (refunded_cents <= total_cents),
  CHECK ((origin = 'assinatura') = (subscription_id IS NOT NULL AND subscription_cycle IS NOT NULL)),
  CHECK (origin <> 'avulso' OR order_id IS NOT NULL),
  UNIQUE (gateway, gateway_charge_id)
);
-- a renovação de um ciclo não duplica, nem com dois processos
CREATE UNIQUE INDEX IF NOT EXISTS charges_one_per_cycle_attempt
  ON charges (subscription_id, subscription_cycle, attempt) WHERE subscription_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_charges_provider ON charges (provider_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_charges_customer ON charges (customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_charges_order ON charges (order_id) WHERE order_id IS NOT NULL;

-- Split em centavos absolutos (nunca percentual)
CREATE TABLE IF NOT EXISTS charge_splits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  charge_id uuid NOT NULL REFERENCES charges(id) ON DELETE CASCADE,
  party text NOT NULL CHECK (party IN ('prestadora', 'plataforma')),
  gateway_recipient_id text,
  amount_cents int NOT NULL CHECK (amount_cents >= 0),
  refunded_cents int NOT NULL DEFAULT 0 CHECK (refunded_cents >= 0),
  UNIQUE (charge_id, party),
  CHECK (refunded_cents <= amount_cents)
);

-- Quanto de cada desconto saiu de cada cobrança. 'reservado' até o webhook
-- confirmar; 'liberado' se a cobrança falhar ou for estornada.
CREATE TABLE IF NOT EXISTS charge_deductions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  charge_id uuid REFERENCES charges(id) ON DELETE CASCADE,
  subscription_id uuid REFERENCES subscriptions(id) ON DELETE CASCADE,
  subscription_cycle int,
  deduction_id uuid NOT NULL REFERENCES provider_deductions(id) ON DELETE CASCADE,
  amount_cents int NOT NULL CHECK (amount_cents > 0),
  payout_date date NOT NULL,
  status text NOT NULL DEFAULT 'reservado' CHECK (status IN ('reservado', 'confirmado', 'liberado')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (charge_id IS NOT NULL OR (subscription_id IS NOT NULL AND subscription_cycle IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_charge_deductions_deduction ON charge_deductions (deduction_id, status);

CREATE TABLE IF NOT EXISTS refunds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  charge_id uuid NOT NULL REFERENCES charges(id),
  amount_cents int NOT NULL CHECK (amount_cents > 0),
  provider_reversed_cents int NOT NULL CHECK (provider_reversed_cents >= 0),
  platform_reversed_cents int NOT NULL CHECK (platform_reversed_cents >= 0),
  idempotency_key text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'solicitado' CHECK (status IN ('solicitado', 'concluido', 'falhou')),
  gateway_refund_id text,
  reason text,
  requested_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (amount_cents = provider_reversed_cents + platform_reversed_cents)
);

-- Repasses previstos (payables, no termo do Pagar.me)
CREATE TABLE IF NOT EXISTS payables (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id uuid NOT NULL REFERENCES users(id),
  charge_id uuid NOT NULL REFERENCES charges(id) ON DELETE CASCADE,
  amount_cents int NOT NULL CHECK (amount_cents >= 0),
  reversed_cents int NOT NULL DEFAULT 0 CHECK (reversed_cents >= 0),
  expected_payout_date date NOT NULL,
  status text NOT NULL DEFAULT 'previsto' CHECK (status IN ('previsto', 'pago', 'revertido')),
  paid_at timestamptz,
  gateway_payable_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (charge_id),
  CHECK (reversed_cents <= amount_cents)
);
CREATE INDEX IF NOT EXISTS idx_payables_provider ON payables (provider_id, expected_payout_date);

-- Webhooks recebidos: normalizados para o enum próprio, payload bruto guardado
CREATE TABLE IF NOT EXISTS payment_webhook_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  gateway text NOT NULL,
  gateway_event_id text NOT NULL,
  event_type text NOT NULL CHECK (event_type IN (
    'PAYMENT_CONFIRMED', 'PAYMENT_FAILED', 'PAYMENT_REFUNDED', 'RECIPIENT_APPROVED', 'RECIPIENT_REJECTED')),
  raw_payload jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  processing_error text,
  UNIQUE (gateway, gateway_event_id)
);

-- ---------- Dados fiscais: coletar agora, emitir depois ----------
-- A tabela existente passa a aceitar CPF (informal) e ganha o status
-- calculado. O tax_regime antigo continua para as notas digitadas à mão.
ALTER TABLE provider_fiscal_profiles ALTER COLUMN cnpj DROP NOT NULL;
ALTER TABLE provider_fiscal_profiles ALTER COLUMN legal_name DROP NOT NULL;
ALTER TABLE provider_fiscal_profiles ALTER COLUMN tax_regime DROP NOT NULL;
ALTER TABLE provider_fiscal_profiles ADD COLUMN IF NOT EXISTS regime text
  CHECK (regime IN ('informal', 'mei', 'me', 'salao'));
ALTER TABLE provider_fiscal_profiles ADD COLUMN IF NOT EXISTS document_type text
  CHECK (document_type IN ('cpf', 'cnpj'));
ALTER TABLE provider_fiscal_profiles ADD COLUMN IF NOT EXISTS cpf_encrypted text;
ALTER TABLE provider_fiscal_profiles ADD COLUMN IF NOT EXISTS aliquota_iss_bps int
  CHECK (aliquota_iss_bps BETWEEN 0 AND 500);
ALTER TABLE provider_fiscal_profiles ADD COLUMN IF NOT EXISTS iss_retido boolean NOT NULL DEFAULT false;
ALTER TABLE provider_fiscal_profiles ADD COLUMN IF NOT EXISTS emite_nfse boolean NOT NULL DEFAULT false;
ALTER TABLE provider_fiscal_profiles ADD COLUMN IF NOT EXISTS status_config text NOT NULL DEFAULT 'pendente'
  CHECK (status_config IN ('pendente', 'ativa', 'erro', 'desativada'));
ALTER TABLE provider_fiscal_profiles ADD COLUMN IF NOT EXISTS missing_fields text[] NOT NULL DEFAULT '{}';
-- Perfis antigos (só CNPJ): regime equivalente
UPDATE provider_fiscal_profiles SET
  regime = CASE WHEN tax_regime = 'mei' THEN 'mei' ELSE 'me' END,
  document_type = 'cnpj'
WHERE regime IS NULL AND cnpj IS NOT NULL;

-- Cliente: CPF (cifrado + hash para unicidade) e endereço de cobrança
ALTER TABLE users ADD COLUMN IF NOT EXISTS cpf_encrypted text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS cpf_hash text;
CREATE UNIQUE INDEX IF NOT EXISTS users_cpf_hash_key ON users (cpf_hash) WHERE cpf_hash IS NOT NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS billing_address_id uuid REFERENCES addresses(id) ON DELETE SET NULL;

-- Dados da nota por cobrança, copiados no momento da cobrança (a
-- configuração fiscal pode mudar até a emissão). Nada é emitido agora; as
-- colunas emitter_* ficam para o emissor futuro, sem mudar o esquema.
CREATE TABLE IF NOT EXISTS invoice_data (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  charge_id uuid NOT NULL UNIQUE REFERENCES charges(id) ON DELETE CASCADE,
  provider_id uuid NOT NULL REFERENCES users(id),
  provider_name text NOT NULL,
  provider_document_type text,
  provider_document_encrypted text,
  provider_regime text,
  provider_municipal_registration text,
  provider_city_code text,
  item_servico text,
  aliquota_iss_bps int,
  iss_retido boolean,
  customer_name text NOT NULL,
  customer_document_encrypted text,
  customer_email text,
  customer_street text,
  customer_number text,
  customer_complement text,
  customer_neighborhood text,
  customer_city text,
  customer_uf text,
  customer_cep text,
  amount_cents int NOT NULL CHECK (amount_cents >= 0), -- valor da prestadora (a taxa é receita da SheServe)
  description text NOT NULL,
  competencia date NOT NULL,
  service_date date,
  fiscal_status_at_charge text,
  missing_fields text[] NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente', 'emitida', 'dispensada')),
  status_changed_at timestamptz,
  emitter text,
  emitter_document_id text,
  nfse_number text,
  verification_code text,
  pdf_url text,
  xml_url text,
  emitter_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_invoice_data_provider ON invoice_data (provider_id, competencia DESC);

-- ---------- Estado do MockGateway ----------
-- Persistido no banco: o Render free hiberna, e estado só em memória perderia
-- os webhooks agendados.
CREATE TABLE IF NOT EXISTS mock_gateway_objects (
  gateway_id text PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('recipient', 'charge', 'subscription', 'refund')),
  idempotency_key text UNIQUE,
  state jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS mock_scheduled_webhooks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fire_at timestamptz NOT NULL,
  payload jsonb NOT NULL,
  attempts int NOT NULL DEFAULT 0,
  sent_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mock_webhooks_due ON mock_scheduled_webhooks (fire_at) WHERE sent_at IS NULL;

-- ---------- NBS e cClassTrib (campos de IBS/CBS da NFS-e) ----------
-- Coletados agora, como os demais dados fiscais. Fonte: tabelas oficiais da
-- Calculadora de Tributos da Receita Federal (github.com/ReceitaFederal/
-- calculadora-rtc-regime-regular, migrações B0001 e V0061: correlação
-- item LC 116 → NBS → cClassTrib vigente a partir de 03/11/2026).
-- cClassTrib 000001 = "Situações tributadas integralmente pelo IBS e CBS".
CREATE TABLE IF NOT EXISTS nbs_options (
  item_servico text NOT NULL,
  nbs_code text NOT NULL CHECK (nbs_code ~ '^\d{9}$'),
  description text NOT NULL,
  c_class_trib text NOT NULL CHECK (c_class_trib ~ '^\d{6}$'),
  PRIMARY KEY (item_servico, nbs_code)
);
INSERT INTO nbs_options (item_servico, nbs_code, description, c_class_trib) VALUES
  ('6.01', '126021000', 'Serviços de cabeleireiros e barbeiros', '000001'),
  ('6.01', '126022000', 'Serviços de manicure, pedicure e tratamento cosmético', '000001'),
  ('6.02', '126022000', 'Serviços de manicure, pedicure e tratamento cosmético', '000001'),
  ('6.02', '126023000', 'Serviços de bem-estar físico', '000001'),
  ('6.02', '126029000', 'Serviços de tratamento de beleza e bem-estar físico não classificados em subposições anteriores', '000001'),
  ('7.10', '118031000', 'Serviços gerais de limpeza', '000001'),
  ('7.10', '118032200', 'Serviços de limpeza de janelas', '000001'),
  ('7.10', '118032900', 'Serviços especializados de limpeza não classificados em subposições anteriores', '000001')
ON CONFLICT (item_servico, nbs_code) DO NOTHING;

ALTER TABLE municipal_service_defaults ADD COLUMN IF NOT EXISTS nbs_code text CHECK (nbs_code ~ '^\d{9}$');
ALTER TABLE municipal_service_defaults ADD COLUMN IF NOT EXISTS c_class_trib text CHECK (c_class_trib ~ '^\d{6}$');
UPDATE municipal_service_defaults SET nbs_code = '126021000', c_class_trib = '000001'
WHERE item_servico = '6.01' AND nbs_code IS NULL;
UPDATE municipal_service_defaults SET nbs_code = '118031000', c_class_trib = '000001'
WHERE item_servico = '7.10' AND nbs_code IS NULL;

ALTER TABLE provider_fiscal_profiles ADD COLUMN IF NOT EXISTS nbs_code text CHECK (nbs_code ~ '^\d{9}$');
ALTER TABLE provider_fiscal_profiles ADD COLUMN IF NOT EXISTS c_class_trib text CHECK (c_class_trib ~ '^\d{6}$');
ALTER TABLE invoice_data ADD COLUMN IF NOT EXISTS nbs_code text;
ALTER TABLE invoice_data ADD COLUMN IF NOT EXISTS c_class_trib text;
