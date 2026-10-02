-- Initial schema. Requires PostgreSQL 15+ (uses ON DELETE SET NULL (column) on composite foreign keys).
--
-- Tenancy: every business table carries org_id. Child tables reference parents through composite
-- (org_id, id) foreign keys, so the database itself rejects any row that points at another
-- organisation's data, independent of application checks.
--
-- Money is stored as integer minor units (pence/cents) to avoid floating point rounding.

CREATE TABLE organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  timezone text NOT NULL DEFAULT 'Europe/London',
  currency text NOT NULL DEFAULT 'GBP' CHECK (currency ~ '^[A-Z]{3}$'),
  country text NOT NULL DEFAULT 'GB' CHECK (country ~ '^[A-Z]{2}$'),
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  invoice_seq integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  email text NOT NULL CHECK (email = lower(email)),
  phone text,
  role text NOT NULL CHECK (role IN ('owner', 'admin', 'employee')),
  password_hash text,
  color text NOT NULL DEFAULT '#2563eb' CHECK (color ~ '^#[0-9a-fA-F]{6}$'),
  active boolean NOT NULL DEFAULT true,
  failed_logins integer NOT NULL DEFAULT 0,
  locked_until timestamptz,
  last_login_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id)
);
CREATE UNIQUE INDEX users_email_key ON users (email);
CREATE INDEX users_org_idx ON users (org_id);

CREATE TABLE sessions (
  id text PRIMARY KEY, -- sha256(token); the raw token only ever lives in the user's cookie
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  org_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  ip text,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user_idx ON sessions (user_id);
CREATE INDEX sessions_expires_idx ON sessions (expires_at);

CREATE TABLE auth_tokens (
  id text PRIMARY KEY, -- sha256(token)
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  purpose text NOT NULL CHECK (purpose IN ('password_reset', 'invite')),
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auth_tokens_user_idx ON auth_tokens (user_id);

CREATE TABLE customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 150),
  email text,
  phone text, -- E.164
  address text,
  notes text,
  sms_opt_in boolean NOT NULL DEFAULT true,
  email_opt_in boolean NOT NULL DEFAULT true,
  marketing_opt_in boolean NOT NULL DEFAULT true,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id)
);
CREATE INDEX customers_org_name_idx ON customers (org_id, lower(name));
CREATE INDEX customers_org_email_idx ON customers (org_id, lower(email));
CREATE INDEX customers_phone_idx ON customers (phone);

CREATE TABLE vehicles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  customer_id uuid NOT NULL,
  make text,
  model text,
  year integer CHECK (year BETWEEN 1900 AND 2100),
  plate text,
  vin text,
  color text,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, customer_id) REFERENCES customers (org_id, id) ON DELETE CASCADE
);
CREATE INDEX vehicles_customer_idx ON vehicles (org_id, customer_id);
CREATE INDEX vehicles_plate_idx ON vehicles (org_id, upper(plate));

CREATE TABLE services (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  description text,
  price_cents integer NOT NULL CHECK (price_cents >= 0),
  duration_min integer NOT NULL CHECK (duration_min BETWEEN 5 AND 1440),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id)
);

-- A recurring booking. Occurrences are generated ahead of time on a rolling horizon by the scheduler,
-- computed in the series' own time zone so "every Tuesday 10:00" stays at 10:00 across DST changes.
CREATE TABLE appointment_series (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  customer_id uuid NOT NULL,
  freq text NOT NULL CHECK (freq IN ('weekly', 'monthly')),
  interval integer NOT NULL CHECK (interval BETWEEN 1 AND 52),
  anchor_local timestamp NOT NULL,
  timezone text NOT NULL,
  duration_min integer NOT NULL CHECK (duration_min BETWEEN 5 AND 1440),
  ends_after integer CHECK (ends_after BETWEEN 1 AND 520),
  ends_on date,
  template jsonb NOT NULL,
  next_index integer NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, customer_id) REFERENCES customers (org_id, id) ON DELETE CASCADE
);

CREATE TABLE appointments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  customer_id uuid NOT NULL,
  vehicle_id uuid,
  series_id uuid,
  series_index integer,
  start_at timestamptz NOT NULL,
  end_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'confirmed'
    CHECK (status IN ('pending', 'confirmed', 'in_progress', 'completed', 'canceled', 'no_show')),
  location text,
  notes text,
  discount_cents integer NOT NULL DEFAULT 0 CHECK (discount_cents >= 0),
  started_at timestamptz,
  completed_at timestamptz,
  canceled_at timestamptz,
  rescheduled_at timestamptz,
  -- Scheduler bookkeeping: the start time a reminder was last planned for (re-planned when the job
  -- moves) and when the post-job follow-up was planned. Keeps planning O(new work) per tick.
  reminder_planned_for timestamptz,
  followup_planned_at timestamptz,
  version integer NOT NULL DEFAULT 1,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (end_at > start_at),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, customer_id) REFERENCES customers (org_id, id) ON DELETE CASCADE,
  FOREIGN KEY (org_id, vehicle_id) REFERENCES vehicles (org_id, id) ON DELETE SET NULL (vehicle_id),
  FOREIGN KEY (org_id, series_id) REFERENCES appointment_series (org_id, id) ON DELETE SET NULL (series_id),
  FOREIGN KEY (org_id, created_by) REFERENCES users (org_id, id) ON DELETE SET NULL (created_by)
);
CREATE UNIQUE INDEX appointments_series_occurrence_key ON appointments (series_id, series_index)
  WHERE series_id IS NOT NULL;
CREATE INDEX appointments_org_start_idx ON appointments (org_id, start_at);
CREATE INDEX appointments_customer_idx ON appointments (org_id, customer_id, start_at DESC);
CREATE INDEX appointments_completed_idx ON appointments (completed_at) WHERE status = 'completed';
CREATE INDEX appointments_active_start_idx ON appointments (start_at) WHERE status IN ('pending', 'confirmed');

CREATE TABLE appointment_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  appointment_id uuid NOT NULL,
  service_id uuid,
  name text NOT NULL,
  unit_price_cents integer NOT NULL CHECK (unit_price_cents >= 0),
  quantity integer NOT NULL DEFAULT 1 CHECK (quantity BETWEEN 1 AND 100),
  position integer NOT NULL DEFAULT 0,
  FOREIGN KEY (org_id, appointment_id) REFERENCES appointments (org_id, id) ON DELETE CASCADE,
  FOREIGN KEY (org_id, service_id) REFERENCES services (org_id, id) ON DELETE SET NULL (service_id)
);
CREATE INDEX appointment_items_appointment_idx ON appointment_items (appointment_id);
CREATE INDEX appointment_items_service_idx ON appointment_items (service_id);

CREATE TABLE appointment_technicians (
  org_id uuid NOT NULL,
  appointment_id uuid NOT NULL,
  user_id uuid NOT NULL,
  PRIMARY KEY (appointment_id, user_id),
  FOREIGN KEY (org_id, appointment_id) REFERENCES appointments (org_id, id) ON DELETE CASCADE,
  FOREIGN KEY (org_id, user_id) REFERENCES users (org_id, id) ON DELETE CASCADE
);
CREATE INDEX appointment_technicians_user_idx ON appointment_technicians (user_id);

CREATE TABLE photos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  appointment_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('before', 'after')),
  storage_key text NOT NULL,
  thumb_key text NOT NULL,
  width integer,
  height integer,
  bytes integer,
  uploaded_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (org_id, appointment_id) REFERENCES appointments (org_id, id) ON DELETE CASCADE,
  FOREIGN KEY (org_id, uploaded_by) REFERENCES users (org_id, id) ON DELETE SET NULL (uploaded_by)
);
CREATE INDEX photos_appointment_idx ON photos (org_id, appointment_id);

-- Invoices are financial records: they are never deleted (only voided), and a customer that has
-- invoices cannot be deleted (RESTRICT) — archive the customer instead.
CREATE TABLE invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  number text NOT NULL,
  customer_id uuid NOT NULL,
  appointment_id uuid,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'paid', 'void')),
  issue_date date NOT NULL,
  due_date date NOT NULL,
  bill_to jsonb NOT NULL,
  subtotal_cents integer NOT NULL CHECK (subtotal_cents >= 0),
  discount_cents integer NOT NULL DEFAULT 0 CHECK (discount_cents >= 0),
  tax_rate_bp integer NOT NULL DEFAULT 0 CHECK (tax_rate_bp BETWEEN 0 AND 10000),
  prices_include_tax boolean NOT NULL DEFAULT true,
  tax_cents integer NOT NULL DEFAULT 0 CHECK (tax_cents >= 0),
  total_cents integer NOT NULL CHECK (total_cents >= 0),
  paid_cents integer NOT NULL DEFAULT 0 CHECK (paid_cents >= 0),
  notes text,
  paid_at timestamptz,
  voided_at timestamptz,
  void_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  UNIQUE (org_id, number),
  FOREIGN KEY (org_id, customer_id) REFERENCES customers (org_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (org_id, appointment_id) REFERENCES appointments (org_id, id) ON DELETE SET NULL (appointment_id)
);
CREATE UNIQUE INDEX invoices_one_active_per_appointment ON invoices (appointment_id)
  WHERE status <> 'void' AND appointment_id IS NOT NULL;
CREATE INDEX invoices_org_issue_idx ON invoices (org_id, issue_date DESC);
CREATE INDEX invoices_customer_idx ON invoices (org_id, customer_id);

CREATE TABLE invoice_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  invoice_id uuid NOT NULL,
  description text NOT NULL,
  quantity integer NOT NULL CHECK (quantity > 0),
  unit_price_cents integer NOT NULL CHECK (unit_price_cents >= 0),
  total_cents integer NOT NULL CHECK (total_cents >= 0),
  position integer NOT NULL DEFAULT 0,
  FOREIGN KEY (org_id, invoice_id) REFERENCES invoices (org_id, id) ON DELETE CASCADE
);
CREATE INDEX invoice_items_invoice_idx ON invoice_items (invoice_id);

CREATE TABLE payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  invoice_id uuid NOT NULL,
  amount_cents integer NOT NULL CHECK (amount_cents > 0),
  method text NOT NULL CHECK (method IN ('cash', 'card', 'bank_transfer', 'other')),
  paid_at timestamptz NOT NULL DEFAULT now(),
  reference text,
  recorded_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (org_id, invoice_id) REFERENCES invoices (org_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (org_id, recorded_by) REFERENCES users (org_id, id) ON DELETE SET NULL (recorded_by)
);
CREATE INDEX payments_invoice_idx ON payments (invoice_id);
CREATE INDEX payments_org_paid_idx ON payments (org_id, paid_at);

CREATE TABLE inventory_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  sku text,
  unit text NOT NULL DEFAULT 'units',
  quantity numeric(12, 2) NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  low_threshold numeric(12, 2) NOT NULL DEFAULT 0 CHECK (low_threshold >= 0),
  cost_cents integer NOT NULL DEFAULT 0 CHECK (cost_cents >= 0),
  supplier text,
  low_alerted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id)
);

CREATE TABLE inventory_movements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  item_id uuid NOT NULL,
  delta numeric(12, 2) NOT NULL CHECK (delta <> 0),
  quantity_after numeric(12, 2) NOT NULL CHECK (quantity_after >= 0),
  reason text NOT NULL CHECK (reason IN ('initial', 'restock', 'usage', 'adjustment')),
  note text,
  user_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (org_id, item_id) REFERENCES inventory_items (org_id, id) ON DELETE CASCADE,
  FOREIGN KEY (org_id, user_id) REFERENCES users (org_id, id) ON DELETE SET NULL (user_id)
);
CREATE INDEX inventory_movements_item_idx ON inventory_movements (item_id, created_at DESC);

-- Transactional outbox for SMS/email. Rows are written in the same transaction as the business
-- change, then delivered by the worker with retries. dedupe_key makes planned messages idempotent.
CREATE TABLE notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  appointment_id uuid,
  customer_id uuid,
  invoice_id uuid,
  kind text NOT NULL,
  channel text NOT NULL CHECK (channel IN ('sms', 'email')),
  recipient text NOT NULL,
  subject text,
  body text NOT NULL,
  html text,
  meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'sending', 'sent', 'delivered', 'simulated', 'failed', 'skipped', 'canceled')),
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  provider_id text,
  error text,
  dedupe_key text,
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (org_id, appointment_id) REFERENCES appointments (org_id, id) ON DELETE SET NULL (appointment_id),
  FOREIGN KEY (org_id, customer_id) REFERENCES customers (org_id, id) ON DELETE CASCADE,
  FOREIGN KEY (org_id, invoice_id) REFERENCES invoices (org_id, id) ON DELETE SET NULL (invoice_id)
);
CREATE UNIQUE INDEX notifications_dedupe_key ON notifications (org_id, dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX notifications_due_idx ON notifications (next_attempt_at) WHERE status = 'queued';
CREATE INDEX notifications_sending_idx ON notifications (locked_at) WHERE status = 'sending';
CREATE INDEX notifications_org_created_idx ON notifications (org_id, created_at DESC);
CREATE INDEX notifications_appointment_idx ON notifications (appointment_id);
CREATE INDEX notifications_provider_idx ON notifications (provider_id) WHERE provider_id IS NOT NULL;

CREATE TABLE activity_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  user_id uuid,
  entity_type text NOT NULL,
  entity_id uuid,
  action text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (org_id, user_id) REFERENCES users (org_id, id) ON DELETE SET NULL (user_id)
);
CREATE INDEX activity_log_entity_idx ON activity_log (org_id, entity_type, entity_id, created_at DESC);
