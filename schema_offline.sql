BEGIN;

-- Part 1: offline sync
ALTER TABLE expenses ADD COLUMN client_id UUID;
ALTER TABLE extra_income ADD COLUMN client_id UUID;

CREATE UNIQUE INDEX uniq_expenses_client ON expenses (period_id, client_id)
  WHERE client_id IS NOT NULL;
CREATE UNIQUE INDEX uniq_income_client ON extra_income (period_id, client_id)
  WHERE client_id IS NOT NULL;

-- Part 2: debt reminders
CREATE TABLE room_nudges (
  id          SERIAL PRIMARY KEY,
  room_id     INT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  from_user   INT NOT NULL REFERENCES users(id),
  to_user     INT NOT NULL REFERENCES users(id),
  amount_kobo BIGINT NOT NULL CHECK (amount_kobo > 0),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  seen_at     TIMESTAMPTZ,
  CHECK (from_user <> to_user)
);
CREATE INDEX idx_room_nudges_to ON room_nudges (room_id, to_user);

-- Part 3: reminder preference
ALTER TABLE users
  ADD COLUMN reminder_enabled BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN reminder_time TIME NOT NULL DEFAULT '21:00';

COMMIT;