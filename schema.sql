CREATE TABLE users (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL,
  email         TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE budget_periods (
  id                    SERIAL PRIMARY KEY,
  user_id               INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  starting_balance_kobo BIGINT NOT NULL CHECK (starting_balance_kobo >= 0),
  start_date            DATE NOT NULL,
  next_allowance_date   DATE NOT NULL,
  is_active             BOOLEAN NOT NULL DEFAULT true,
  CHECK (next_allowance_date > start_date)
);

-- A user can have only ONE active period at a time
CREATE UNIQUE INDEX one_active_period_per_user
  ON budget_periods (user_id) WHERE is_active = true;

CREATE TABLE expenses (
  id          SERIAL PRIMARY KEY,
  period_id   INT NOT NULL REFERENCES budget_periods(id) ON DELETE CASCADE,
  amount_kobo BIGINT NOT NULL CHECK (amount_kobo > 0),
  category    TEXT NOT NULL CHECK (category IN (
    'Food', 'Transport', 'Printing and Photocopy', 'Data and Airtime',
    'Personal Care', 'Church or Mosque Giving', 'Outings', 'Others'
  )),
  note        TEXT,
  spent_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_expenses_period ON expenses (period_id);

CREATE TABLE extra_income (
  id          SERIAL PRIMARY KEY,
  period_id   INT NOT NULL REFERENCES budget_periods(id) ON DELETE CASCADE,
  amount_kobo BIGINT NOT NULL CHECK (amount_kobo > 0),
  note        TEXT,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_income_period ON extra_income (period_id);