BEGIN;

ALTER TABLE room_settlements DROP CONSTRAINT room_settlements_status_check;

ALTER TABLE room_settlements ADD CONSTRAINT room_settlements_status_check
  CHECK (status IN ('pending', 'confirmed', 'rejected'));

ALTER TABLE room_settlements
  ADD COLUMN reject_reason TEXT,
  ADD COLUMN rejected_at TIMESTAMPTZ;

COMMIT;