-- Supabase publishes every table in the public schema through its Data API, using a
-- key that is public by design. This API reaches the data only through this server,
-- so turn on row-level security with no policies: Supabase's API roles can then see
-- nothing. The server connects as the tables' owner, which row-level security doesn't
-- restrict, and on plain PostgreSQL this changes nothing.
ALTER TABLE schema_migrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE budget_periods ENABLE ROW LEVEL SECURITY;
ALTER TABLE transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE rooms ENABLE ROW LEVEL SECURITY;
ALTER TABLE room_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE room_invites ENABLE ROW LEVEL SECURITY;
ALTER TABLE room_expenses ENABLE ROW LEVEL SECURITY;
ALTER TABLE room_expense_shares ENABLE ROW LEVEL SECURITY;
ALTER TABLE room_settlements ENABLE ROW LEVEL SECURITY;
