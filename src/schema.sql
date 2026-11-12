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
