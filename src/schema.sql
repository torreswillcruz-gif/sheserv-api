CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  email text NOT NULL UNIQUE,
  phone text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  roles text[] NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  revoked boolean NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS provider_profiles (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  bio text,
  activation_status text NOT NULL DEFAULT 'pending',
  verified boolean NOT NULL DEFAULT false,
  available boolean NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS categories (
  id text PRIMARY KEY,
  parent_id text REFERENCES categories(id),
  name text NOT NULL
);

CREATE TABLE IF NOT EXISTS services (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id uuid NOT NULL REFERENCES users(id),
  category_id text NOT NULL REFERENCES categories(id),
  title text NOT NULL,
  base_price numeric(10,2) NOT NULL,
  duration_minutes int NOT NULL
);

CREATE TABLE IF NOT EXISTS addresses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label text,
  street text NOT NULL,
  city text NOT NULL,
  latitude double precision,
  longitude double precision
);

CREATE TABLE IF NOT EXISTS orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES users(id),
  provider_id uuid NOT NULL REFERENCES users(id),
  service_id uuid NOT NULL REFERENCES services(id),
  address_id uuid NOT NULL REFERENCES addresses(id),
  scheduled_at timestamptz NOT NULL,
  duration_minutes int NOT NULL,
  status text NOT NULL DEFAULT 'requested',
  total_amount numeric(10,2) NOT NULL,
  commission numeric(10,2) NOT NULL,
  checkin_code text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL UNIQUE REFERENCES orders(id),
  status text NOT NULL,
  method text NOT NULL,
  method_token text,
  held_until timestamptz
);

CREATE TABLE IF NOT EXISTS payouts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL UNIQUE REFERENCES orders(id),
  provider_id uuid NOT NULL REFERENCES users(id),
  amount numeric(10,2) NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS order_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders(id),
  actor_id uuid REFERENCES users(id),
  type text NOT NULL,
  data jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS check_ins (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders(id),
  user_id uuid NOT NULL REFERENCES users(id),
  type text NOT NULL,
  latitude double precision,
  longitude double precision,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS trusted_contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  relationship text,
  phone_encrypted text NOT NULL,
  enabled boolean NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS sos_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders(id),
  user_id uuid NOT NULL REFERENCES users(id),
  latitude double precision,
  longitude double precision,
  message text,
  status text NOT NULL DEFAULT 'open',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders(id),
  author_id uuid NOT NULL REFERENCES users(id),
  text text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders(id),
  reporter_id uuid NOT NULL REFERENCES users(id),
  reported_user_id uuid NOT NULL REFERENCES users(id),
  reason text NOT NULL,
  description text,
  status text NOT NULL DEFAULT 'open',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders(id),
  author_id uuid NOT NULL REFERENCES users(id),
  target_id uuid NOT NULL REFERENCES users(id),
  direction text NOT NULL,
  rating int NOT NULL CHECK (rating BETWEEN 1 AND 5),
  tags text[] NOT NULL DEFAULT '{}',
  comment text,
  tip_amount numeric(10,2),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (order_id, author_id, direction)
);

CREATE TABLE IF NOT EXISTS verifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type text NOT NULL,
  provider text,
  result text NOT NULL DEFAULT 'pending',
  score numeric,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders(customer_id);
CREATE INDEX IF NOT EXISTS idx_orders_provider ON orders(provider_id, scheduled_at);

-- endereços: campos extras e exclusão lógica (seguro rodar em banco já existente)
ALTER TABLE addresses ADD COLUMN IF NOT EXISTS number text;
ALTER TABLE addresses ADD COLUMN IF NOT EXISTS complement text;
ALTER TABLE addresses ADD COLUMN IF NOT EXISTS neighborhood text;
ALTER TABLE addresses ADD COLUMN IF NOT EXISTS state text;
ALTER TABLE addresses ADD COLUMN IF NOT EXISTS postal_code text;
ALTER TABLE addresses ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
CREATE INDEX IF NOT EXISTS idx_addresses_user ON addresses(user_id);

-- serviços: exclusão lógica (pedidos antigos continuam referenciando o serviço)
ALTER TABLE services ADD COLUMN IF NOT EXISTS active boolean NOT NULL DEFAULT true;
CREATE INDEX IF NOT EXISTS idx_services_provider ON services(provider_id);

-- localização base da prestadora (usada só para calcular distância; nunca exposta no catálogo)
ALTER TABLE provider_profiles ADD COLUMN IF NOT EXISTS latitude double precision;
ALTER TABLE provider_profiles ADD COLUMN IF NOT EXISTS longitude double precision;

-- onde o atendimento acontece: "at_customer" (prestadora vai até o cliente) ou "at_provider" (cliente vai até ela)
ALTER TABLE services ADD COLUMN IF NOT EXISTS service_location text NOT NULL DEFAULT 'at_customer'
  CHECK (service_location IN ('at_customer', 'at_provider'));

-- cópia do tipo de atendimento no pedido (se o serviço mudar depois, o pedido antigo não muda)
ALTER TABLE orders ADD COLUMN IF NOT EXISTS service_location text NOT NULL DEFAULT 'at_customer'
  CHECK (service_location IN ('at_customer', 'at_provider'));

-- em atendimento na prestadora o cliente não precisa informar endereço
ALTER TABLE orders ALTER COLUMN address_id DROP NOT NULL;

-- local de atendimento da prestadora (um por prestadora)
CREATE TABLE IF NOT EXISTS provider_venues (
  provider_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  street text NOT NULL,
  number text,
  complement text,
  neighborhood text NOT NULL,
  city text NOT NULL,
  state text,
  postal_code text,
  latitude double precision NOT NULL,
  longitude double precision NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ID amigável do pedido: 8 caracteres alfanuméricos, único, gerado pelo banco.
-- O alfabeto não tem letras/números que se confundem (sem 0, 1, I, L, O).
ALTER TABLE orders ADD COLUMN IF NOT EXISTS friendly_id text;

CREATE OR REPLACE FUNCTION generate_order_friendly_id() RETURNS text AS $$
DECLARE
  alphabet CONSTANT text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  candidate text;
  random_bytes bytea;
  char_position int;
BEGIN
  LOOP
    candidate := '';
    random_bytes := gen_random_bytes(8);
    FOR char_position IN 0..7 LOOP
      candidate := candidate || substr(alphabet, (get_byte(random_bytes, char_position) % length(alphabet)) + 1, 1);
    END LOOP;
    -- se o código já existir, sorteia outro
    EXIT WHEN NOT EXISTS (SELECT 1 FROM orders WHERE friendly_id = candidate);
  END LOOP;
  RETURN candidate;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION set_order_friendly_id() RETURNS trigger AS $$
BEGIN
  IF NEW.friendly_id IS NULL THEN
    NEW.friendly_id := generate_order_friendly_id();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS orders_set_friendly_id ON orders;
CREATE TRIGGER orders_set_friendly_id
  BEFORE INSERT ON orders
  FOR EACH ROW EXECUTE FUNCTION set_order_friendly_id();

-- pedidos que já existiam antes desta regra ganham um código também
UPDATE orders SET friendly_id = generate_order_friendly_id() WHERE friendly_id IS NULL;

ALTER TABLE orders ALTER COLUMN friendly_id SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS orders_friendly_id_key ON orders (friendly_id);

-- Modelo de planos, solicitações e orçamentos
ALTER TABLE services ADD COLUMN IF NOT EXISTS price_type text NOT NULL DEFAULT 'fixed'
  CHECK (price_type IN ('fixed', 'from', 'evaluation'));
ALTER TABLE services ADD COLUMN IF NOT EXISTS accepts_quotes boolean NOT NULL DEFAULT false;
ALTER TABLE services ADD COLUMN IF NOT EXISTS briefing_questions jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE services ADD COLUMN IF NOT EXISTS cancellation_policy text;
-- Horário de atendimento: [{weekday 1-7 (ISO), start "HH:MM", end "HH:MM"}] no horário de Brasília.
-- Vazio = serviço antigo, sem restrição (obrigatório para serviços novos; ver src/schedule.js).
ALTER TABLE services ADD COLUMN IF NOT EXISTS availability jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS quote_id uuid;

CREATE TABLE IF NOT EXISTS plan_catalog (
  plan_code text PRIMARY KEY
    CHECK (plan_code IN ('free', 'standard', 'pro', 'premium')),
  display_name text NOT NULL,
  description text,
  monthly_approval_limit int CHECK (monthly_approval_limit IS NULL OR monthly_approval_limit >= 0),
  features jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(features) = 'object'),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO plan_catalog (plan_code,display_name,description,monthly_approval_limit,features)
VALUES
  ('free','Grátis','Recursos básicos da prestadora.',20,
    '{"finance":true,"clients":false,"statistics":false,"promotions":false,"team":false}'::jsonb),
  ('standard','Standard','Mais solicitações de orçamento por mês.',40,
    '{"finance":true,"clients":true,"statistics":true,"promotions":false,"team":false}'::jsonb),
  ('pro','Pro','Limite ampliado de solicitações de orçamento.',100,
    '{"finance":true,"clients":true,"statistics":true,"promotions":true,"team":false}'::jsonb),
  ('premium','Premium','Solicitações sem limite fixo e gestão de equipe.',NULL,
    '{"finance":true,"clients":true,"statistics":true,"promotions":true,"team":true}'::jsonb)
ON CONFLICT (plan_code) DO NOTHING;

CREATE TABLE IF NOT EXISTS provider_plans (
  provider_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  plan_name text NOT NULL DEFAULT 'free'
    CHECK (plan_name IN ('free', 'standard', 'pro', 'premium')),
  monthly_approval_limit int,
  renewal_at timestamptz NOT NULL DEFAULT date_trunc('month', now()) + interval '1 month',
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE provider_plans DROP CONSTRAINT IF EXISTS provider_plans_plan_name_check;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'provider_plans_plan_name_fkey'
      AND conrelid = 'provider_plans'::regclass
  ) THEN
    ALTER TABLE provider_plans
      ADD CONSTRAINT provider_plans_plan_name_fkey
      FOREIGN KEY (plan_name) REFERENCES plan_catalog(plan_code);
  END IF;
END;
$$;

CREATE TABLE IF NOT EXISTS monthly_approval_usage (
  provider_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  period text NOT NULL,
  approved_count int NOT NULL DEFAULT 0,
  reserved_count int NOT NULL DEFAULT 0,
  PRIMARY KEY (provider_id, period),
  CHECK (approved_count >= 0),
  CHECK (reserved_count >= 0)
);

CREATE TABLE IF NOT EXISTS service_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES users(id),
  provider_id uuid REFERENCES users(id),
  service_id uuid REFERENCES services(id),
  status text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'with_quotes', 'accepted', 'cancelled', 'expired')),
  description text,
  brief_answers jsonb NOT NULL DEFAULT '{}'::jsonb,
  photo_urls text[] NOT NULL DEFAULT '{}',
  address_id uuid REFERENCES addresses(id),
  date_window_start timestamptz,
  date_window_end timestamptz,
  estimated_value numeric(10,2),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS quotes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL REFERENCES service_requests(id) ON DELETE CASCADE,
  provider_id uuid NOT NULL REFERENCES users(id),
  customer_id uuid NOT NULL REFERENCES users(id),
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'open', 'countered', 'approved', 'rejected', 'expired', 'cancelled')),
  total_amount numeric(10,2) NOT NULL,
  valid_until timestamptz NOT NULL,
  terms text,
  reserved_quota boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS quote_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_id uuid NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
  service_id uuid REFERENCES services(id),
  description text NOT NULL,
  quantity numeric(10,2) NOT NULL DEFAULT 1 CHECK (quantity > 0),
  unit_price numeric(10,2) NOT NULL CHECK (unit_price >= 0),
  kind text NOT NULL DEFAULT 'service'
    CHECK (kind IN ('service', 'travel', 'discount', 'additional')),
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE quote_items ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();

-- mês (YYYY-MM) em que a cota do orçamento foi reservada; usado para devolver/aprovar no mesmo período
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS quota_period text;

CREATE TABLE IF NOT EXISTS quote_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_id uuid NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
  actor_id uuid REFERENCES users(id),
  type text NOT NULL,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_service_requests_customer ON service_requests(customer_id, status);
CREATE INDEX IF NOT EXISTS idx_service_requests_provider ON service_requests(provider_id, status);
CREATE INDEX IF NOT EXISTS idx_quotes_request ON quotes(request_id, status);
CREATE INDEX IF NOT EXISTS idx_quotes_provider ON quotes(provider_id, status);

CREATE TABLE IF NOT EXISTS quote_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_id uuid NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
  author_id uuid NOT NULL REFERENCES users(id),
  text text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS quote_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_id uuid NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
  author_id uuid NOT NULL REFERENCES users(id),
  total_amount numeric(10,2) NOT NULL,
  valid_until timestamptz NOT NULL,
  terms text,
  change_type text NOT NULL CHECK (change_type IN ('counter', 'revision')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_quote_messages_quote ON quote_messages(quote_id, created_at);
CREATE INDEX IF NOT EXISTS idx_quote_versions_quote ON quote_versions(quote_id, created_at);

CREATE TABLE IF NOT EXISTS notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type text NOT NULL,
  title text NOT NULL,
  body text,
  read boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS financial_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  entry_type text NOT NULL CHECK (entry_type IN ('income','expense','receivable')),
  amount numeric(10,2) NOT NULL CHECK (amount >= 0),
  category text NOT NULL,
  description text,
  payment_method text,
  service_id uuid REFERENCES services(id),
  customer_id uuid REFERENCES users(id),
  source_order_id uuid REFERENCES orders(id) ON DELETE SET NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE financial_entries
  ADD COLUMN IF NOT EXISTS source_order_id uuid REFERENCES orders(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_financial_entries_source_order
  ON financial_entries(source_order_id) WHERE source_order_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS provider_clients (
  provider_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tags text[] NOT NULL DEFAULT '{}',
  notes text,
  birthday date,
  next_contact_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider_id, customer_id)
);

CREATE TABLE IF NOT EXISTS provider_stats (
  provider_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  profile_views int NOT NULL DEFAULT 0,
  quote_sent int NOT NULL DEFAULT 0,
  quote_approved int NOT NULL DEFAULT 0,
  average_response_minutes int,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS promotions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  service_id uuid REFERENCES services(id),
  message text NOT NULL,
  radius_km numeric(8,2) NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','active','ended','cancelled','pending_review')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS plan_purchases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  store_product_id text NOT NULL,
  purchase_kind text NOT NULL CHECK (purchase_kind IN ('subscription','approval_pack','promotion_pack','featured')),
  quantity int NOT NULL DEFAULT 1 CHECK (quantity > 0),
  plan_name text,
  expires_at timestamptz,
  status text NOT NULL DEFAULT 'pending',
  gateway_provider text,
  gateway_transaction_id text,
  amount numeric(10,2),
  currency text NOT NULL DEFAULT 'BRL',
  paid_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE plan_purchases ADD COLUMN IF NOT EXISTS plan_name text;
ALTER TABLE plan_purchases ADD COLUMN IF NOT EXISTS gateway_provider text;
ALTER TABLE plan_purchases ADD COLUMN IF NOT EXISTS gateway_transaction_id text;
ALTER TABLE plan_purchases ADD COLUMN IF NOT EXISTS amount numeric(10,2);
ALTER TABLE plan_purchases ADD COLUMN IF NOT EXISTS currency text NOT NULL DEFAULT 'BRL';
ALTER TABLE plan_purchases ADD COLUMN IF NOT EXISTS paid_at timestamptz;
ALTER TABLE plan_purchases ALTER COLUMN status SET DEFAULT 'pending';

CREATE TABLE IF NOT EXISTS team_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  invited_user_id uuid REFERENCES users(id),
  email text NOT NULL,
  role text NOT NULL DEFAULT 'assistant'
    CHECK (role IN ('assistant','manager')),
  permissions jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'invited'
    CHECK (status IN ('invited','active','removed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider_id, email)
);

CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_financial_provider ON financial_entries(provider_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_provider_clients ON provider_clients(provider_id);

-- Revisão manual das verificações de identidade pelo admin
ALTER TABLE verifications ADD COLUMN IF NOT EXISTS review_note text;
ALTER TABLE verifications ADD COLUMN IF NOT EXISTS reviewed_at timestamptz;
ALTER TABLE verifications ADD COLUMN IF NOT EXISTS reviewed_by uuid REFERENCES users(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_verifications_result ON verifications(result, created_at);

-- Aprovar a prestadora é a verificação dela: quem já estava aprovada passa a
-- constar como verificada (o catálogo do app só mostra aprovadas e verificadas).
UPDATE provider_profiles SET verified=true WHERE activation_status='active' AND verified=false;
