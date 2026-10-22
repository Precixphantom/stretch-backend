CREATE TABLE rooms (
  id         SERIAL PRIMARY KEY,
  name       TEXT NOT NULL,
  join_code  TEXT UNIQUE NOT NULL,
  created_by INT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE room_members (
  room_id   INT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  user_id   INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (room_id, user_id)
);

CREATE TABLE room_expenses (
  id          SERIAL PRIMARY KEY,
  room_id     INT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  paid_by     INT NOT NULL REFERENCES users(id),
  item        TEXT NOT NULL,
  amount_kobo BIGINT NOT NULL CHECK (amount_kobo > 0),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_room_expenses_room ON room_expenses (room_id);

-- One row per person who shares an expense, with their exact share
CREATE TABLE room_expense_shares (
  expense_id INT NOT NULL REFERENCES room_expenses(id) ON DELETE CASCADE,
  user_id    INT NOT NULL REFERENCES users(id),
  share_kobo BIGINT NOT NULL CHECK (share_kobo >= 0),
  PRIMARY KEY (expense_id, user_id)
);

CREATE TABLE room_settlements (
  id           SERIAL PRIMARY KEY,
  room_id      INT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  from_user    INT NOT NULL REFERENCES users(id),
  to_user      INT NOT NULL REFERENCES users(id),
  amount_kobo  BIGINT NOT NULL CHECK (amount_kobo > 0),
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  confirmed_at TIMESTAMPTZ,
  CHECK (from_user <> to_user)
);
CREATE INDEX idx_room_settlements_room ON room_settlements (room_id);