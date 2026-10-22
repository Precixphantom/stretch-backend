ALTER TABLE rooms
  ADD COLUMN max_members INT NOT NULL DEFAULT 10
  CHECK (max_members BETWEEN 2 AND 20);

ALTER TABLE room_expenses
  ADD COLUMN status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'disputed', 'withdrawn')),
  ADD COLUMN disputed_by INT REFERENCES users(id),
  ADD COLUMN dispute_reason TEXT,
  ADD COLUMN disputed_at TIMESTAMPTZ;