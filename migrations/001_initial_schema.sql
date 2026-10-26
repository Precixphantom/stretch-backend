-- Stretch schema. Money is whole naira (INTEGER), calendar dates are DATE ('YYYY-MM-DD'),
-- matching the frontend. Ids are UUIDs so they can't be guessed or enumerated.

-- People sign in with Google only. google_sub is Google's stable account id;
-- email is kept so roommates can be invited by it.
CREATE TABLE users (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  google_sub            TEXT NOT NULL UNIQUE,
  email                 TEXT NOT NULL UNIQUE CHECK (email = lower(email)),
  name                  TEXT NOT NULL,
  avatar_url            TEXT,
  reminder_enabled      BOOLEAN NOT NULL DEFAULT true,
  reminder_time         TEXT NOT NULL DEFAULT '21:00' CHECK (reminder_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  reminder_dismissed_on DATE,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Personal budget. Starting a new period deactivates the old one, which keeps its history.
CREATE TABLE budget_periods (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label            TEXT NOT NULL CHECK (char_length(label) BETWEEN 1 AND 40),
  starting_amount  INTEGER NOT NULL CHECK (starting_amount > 0),
  start_date       DATE NOT NULL,
  next_income_date DATE NOT NULL,
  is_active        BOOLEAN NOT NULL DEFAULT true,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (next_income_date > start_date)
);
CREATE UNIQUE INDEX budget_periods_one_active_per_user ON budget_periods (user_id) WHERE is_active;

CREATE TABLE transactions (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  period_id  UUID NOT NULL REFERENCES budget_periods(id) ON DELETE CASCADE,
  type       TEXT NOT NULL CHECK (type IN ('expense', 'income')),
  amount     INTEGER NOT NULL CHECK (amount > 0),
  category   TEXT CHECK (category IN (
    'food', 'transport', 'printing', 'data', 'personal-care', 'giving', 'outings', 'others'
  )),
  date       DATE NOT NULL,
  note       TEXT NOT NULL DEFAULT '' CHECK (char_length(note) <= 60),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Expenses always have a category; income never does.
  CHECK ((type = 'expense') = (category IS NOT NULL))
);
CREATE INDEX transactions_period_date ON transactions (period_id, date);

-- Roommate Kitty. Each person is in at most one room at a time.
CREATE TABLE rooms (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 60),
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Leaving sets left_at instead of deleting the row, so past expenses still show who paid.
CREATE TABLE room_members (
  room_id   UUID NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  user_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  left_at   TIMESTAMPTZ,
  PRIMARY KEY (room_id, user_id)
);
CREATE UNIQUE INDEX room_members_one_room_per_user ON room_members (user_id) WHERE left_at IS NULL;

-- Pending invites only: accepting, declining or cancelling deletes the row.
-- The invitee may not have an account yet; they see it once they sign in with this email.
CREATE TABLE room_invites (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id    UUID NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  email      TEXT NOT NULL CHECK (email = lower(email)),
  invited_by UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (room_id, email)
);
CREATE INDEX room_invites_email ON room_invites (email);

CREATE TABLE room_expenses (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id     UUID NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  description TEXT NOT NULL CHECK (char_length(description) BETWEEN 1 AND 60),
  amount      INTEGER NOT NULL CHECK (amount > 0),
  date        DATE NOT NULL,
  paid_by     UUID NOT NULL REFERENCES users(id),
  created_by  UUID NOT NULL REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX room_expenses_room ON room_expenses (room_id);

-- Each person's share is fixed when the expense is recorded, so later
-- membership changes never rewrite old splits.
CREATE TABLE room_expense_shares (
  expense_id UUID NOT NULL REFERENCES room_expenses(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES users(id),
  amount     INTEGER NOT NULL CHECK (amount >= 0),
  PRIMARY KEY (expense_id, user_id)
);

-- Status values match the frontend. Only confirmed settlements change balances.
CREATE TABLE room_settlements (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id        UUID NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  from_user      UUID NOT NULL REFERENCES users(id),
  to_user        UUID NOT NULL REFERENCES users(id),
  amount         INTEGER NOT NULL CHECK (amount > 0),
  status         TEXT NOT NULL DEFAULT 'awaiting-confirmation'
                 CHECK (status IN ('awaiting-confirmation', 'confirmed', 'declined')),
  marked_paid_on DATE NOT NULL,
  confirmed_on   DATE,
  declined_on    DATE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (from_user <> to_user)
);
CREATE INDEX room_settlements_room ON room_settlements (room_id);
-- One payment awaiting confirmation per debtor and recipient at a time.
CREATE UNIQUE INDEX room_settlements_one_pending_per_pair
  ON room_settlements (room_id, from_user, to_user) WHERE status = 'awaiting-confirmation';
