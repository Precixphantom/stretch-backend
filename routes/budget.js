const express = require('express');
const pool = require('../db');
const requireAuth = require('../middleware/auth');
const { calculateSummary } = require('../services/summary');

const router = express.Router();
router.use(requireAuth); // every route below needs a valid token

const CATEGORIES = [
  'Food', 'Transport', 'Printing and Photocopy', 'Data and Airtime',
  'Personal Care', 'Church or Mosque Giving', 'Outings', 'Others'
];

// "Today" must be Nigerian time, or late night spending lands on the wrong day
const LAGOS_TODAY = `(now() AT TIME ZONE 'Africa/Lagos')::date`;

async function getActivePeriodId(userId) {
  const result = await pool.query(
    'SELECT id FROM budget_periods WHERE user_id = $1 AND is_active = true',
    [userId]
  );
  return result.rows[0] ? result.rows[0].id : null;
}

// ---------- Start a new allowance cycle ----------
router.post('/setup', async (req, res) => {
  const { startingBalanceKobo, nextAllowanceDate } = req.body || {};

  if (!Number.isInteger(startingBalanceKobo) || startingBalanceKobo < 0) {
    return res.status(400).json({ error: 'startingBalanceKobo must be a whole number of kobo, 0 or more' });
  }
  if (typeof nextAllowanceDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(nextAllowanceDate)) {
    return res.status(400).json({ error: 'nextAllowanceDate must look like 2026-11-20' });
  }

  const client = await pool.connect();
  try {
    // A transaction means: either ALL these steps happen, or NONE do.
    await client.query('BEGIN');

    const check = await client.query(
      `SELECT ($1::date > ${LAGOS_TODAY}) AS is_future`,
      [nextAllowanceDate]
    );
    if (!check.rows[0].is_future) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'nextAllowanceDate must be after today' });
    }

    // Close the old cycle, if there is one
    await client.query(
      'UPDATE budget_periods SET is_active = false WHERE user_id = $1 AND is_active = true',
      [req.userId]
    );

    const inserted = await client.query(
      `INSERT INTO budget_periods (user_id, starting_balance_kobo, start_date, next_allowance_date)
       VALUES ($1, $2, ${LAGOS_TODAY}, $3)
       RETURNING id`,
      [req.userId, startingBalanceKobo, nextAllowanceDate]
    );

    await client.query('COMMIT');
    res.status(201).json({ periodId: inserted.rows[0].id });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '22007' || err.code === '22008') { // invalid date such as Feb 31
      return res.status(400).json({ error: 'nextAllowanceDate is not a real date' });
    }
    console.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  } finally {
    client.release(); // always give the connection back to the pool
  }
});

// ---------- Record spending ----------
router.post('/expenses', async (req, res) => {
  try {
    const { amountKobo, category, note } = req.body || {};

    if (!Number.isInteger(amountKobo) || amountKobo <= 0) {
      return res.status(400).json({ error: 'amountKobo must be a positive whole number' });
    }
    if (!CATEGORIES.includes(category)) {
      return res.status(400).json({ error: 'Invalid category', allowed: CATEGORIES });
    }

    const periodId = await getActivePeriodId(req.userId);
    if (!periodId) {
      return res.status(404).json({ error: 'No active budget. Call POST /budget/setup first.' });
    }

    const result = await pool.query(
      `INSERT INTO expenses (period_id, amount_kobo, category, note)
       VALUES ($1, $2, $3, $4)
       RETURNING id, amount_kobo, category, note, spent_at`,
      [periodId, amountKobo, category, typeof note === 'string' ? note : null]
    );

        const row = result.rows[0];
    res.status(201).json({
      id: row.id,
      amountKobo: Number(row.amount_kobo),
      category: row.category,
      note: row.note,
      spentAt: row.spent_at
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

// ---------- Record extra money ----------
router.post('/income', async (req, res) => {
  try {
    const { amountKobo, note } = req.body || {};

    if (!Number.isInteger(amountKobo) || amountKobo <= 0) {
      return res.status(400).json({ error: 'amountKobo must be a positive whole number' });
    }

    const periodId = await getActivePeriodId(req.userId);
    if (!periodId) {
      return res.status(404).json({ error: 'No active budget. Call POST /budget/setup first.' });
    }

    const result = await pool.query(
      `INSERT INTO extra_income (period_id, amount_kobo, note)
       VALUES ($1, $2, $3)
       RETURNING id, amount_kobo, note, received_at`,
      [periodId, amountKobo, typeof note === 'string' ? note : null]
    );

        const row = result.rows[0];
    res.status(201).json({
      id: row.id,
      amountKobo: Number(row.amount_kobo),
      note: row.note,
      receivedAt: row.received_at
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

// ---------- The home screen: everything in one call ----------
router.get('/summary', async (req, res) => {
  try {
    const periodResult = await pool.query(
      `SELECT
         bp.id,
         bp.starting_balance_kobo,
         bp.start_date::text AS start_date,
         bp.next_allowance_date::text AS next_allowance_date,
         (bp.next_allowance_date - ${LAGOS_TODAY}) AS days_left,
         ((${LAGOS_TODAY} - bp.start_date) + 1) AS days_elapsed,
         COALESCE((SELECT SUM(amount_kobo) FROM expenses WHERE period_id = bp.id), 0) AS total_spent,
         COALESCE((SELECT SUM(amount_kobo) FROM extra_income WHERE period_id = bp.id), 0) AS total_extra,
         COALESCE((SELECT SUM(amount_kobo) FROM expenses
                   WHERE period_id = bp.id
                   AND (spent_at AT TIME ZONE 'Africa/Lagos')::date = ${LAGOS_TODAY}), 0) AS spent_today
       FROM budget_periods bp
       WHERE bp.user_id = $1 AND bp.is_active = true`,
      [req.userId]
    );

    const row = periodResult.rows[0];
    if (!row) {
      return res.status(404).json({ error: 'No active budget. Call POST /budget/setup first.' });
    }

    const categoryResult = await pool.query(
      `SELECT category, SUM(amount_kobo) AS total_kobo
       FROM expenses WHERE period_id = $1
       GROUP BY category ORDER BY total_kobo DESC`,
      [row.id]
    );

    res.json({
      periodId: row.id,
      startDate: row.start_date,
      nextAllowanceDate: row.next_allowance_date,
      ...calculateSummary(row),
      spendingByCategory: categoryResult.rows.map(r => ({
        category: r.category,
        totalKobo: Number(r.total_kobo)
      }))
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

// ---------- Sync entries that were recorded offline ----------
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_SYNC_ITEMS = 200;

router.post('/sync', async (req, res) => {
  const body = req.body || {};
  const expenses = body.expenses === undefined ? [] : body.expenses;
  const income = body.income === undefined ? [] : body.income;

  if (!Array.isArray(expenses) || !Array.isArray(income)) {
    return res.status(400).json({ error: 'expenses and income must be lists' });
  }
  if (expenses.length + income.length === 0) {
    return res.status(400).json({ error: 'Nothing to sync' });
  }
  if (expenses.length > MAX_SYNC_ITEMS || income.length > MAX_SYNC_ITEMS) {
    return res.status(400).json({ error: `At most ${MAX_SYNC_ITEMS} expenses and ${MAX_SYNC_ITEMS} income entries per sync` });
  }

  const client = await pool.connect();
  try {
    const periodRow = await client.query(
      'SELECT id, start_date::text AS start_date FROM budget_periods WHERE user_id = $1 AND is_active = true',
      [req.userId]
    );
    const period = periodRow.rows[0];
    if (!period) {
      return res.status(404).json({ error: 'No active budget. Call POST /budget/setup first.' });
    }

    await client.query('BEGIN');

    // An offline entry must fall inside the current cycle and not be in the future.
    // The 5 minute allowance covers a phone clock that runs slightly fast.
    async function checkTime(raw) {
      if (typeof raw !== 'string') return { reason: 'time must be a date string' };
      const d = new Date(raw);
      if (Number.isNaN(d.getTime())) return { reason: 'time is not a valid date' };
      const iso = d.toISOString();
      const r = await client.query(
        `SELECT ($1::timestamptz AT TIME ZONE 'Africa/Lagos')::date >= $2::date AS in_cycle,
                $1::timestamptz <= now() + interval '5 minutes' AS not_future`,
        [iso, period.start_date]
      );
      if (!r.rows[0].in_cycle) return { reason: 'belongs to an earlier cycle' };
      if (!r.rows[0].not_future) return { reason: 'time is in the future' };
      return { iso };
    }

    const expenseResults = [];
    for (const raw of expenses) {
      const e = raw || {};
      const clientId = typeof e.clientId === 'string' ? e.clientId.toLowerCase() : null;
      const reject = (reason) => expenseResults.push({ clientId: e.clientId ?? null, status: 'rejected', reason });

      if (!clientId || !UUID_RE.test(clientId)) { reject('clientId must be a UUID'); continue; }
      if (!Number.isInteger(e.amountKobo) || e.amountKobo <= 0) { reject('amountKobo must be a positive whole number'); continue; }
      if (!CATEGORIES.includes(e.category)) { reject('Invalid category'); continue; }
      const t = await checkTime(e.spentAt);
      if (!t.iso) { reject(t.reason); continue; }

      const inserted = await client.query(
        `INSERT INTO expenses (period_id, amount_kobo, category, note, spent_at, client_id)
         VALUES ($1, $2, $3, $4, $5::timestamptz, $6::uuid)
         ON CONFLICT (period_id, client_id) WHERE client_id IS NOT NULL DO NOTHING
         RETURNING id`,
        [period.id, e.amountKobo, e.category, typeof e.note === 'string' ? e.note.slice(0, 200) : null, t.iso, clientId]
      );
      // No row back means this clientId was already saved on an earlier upload
      expenseResults.push({ clientId, status: inserted.rows.length ? 'created' : 'duplicate' });
    }

    const incomeResults = [];
    for (const raw of income) {
      const i = raw || {};
      const clientId = typeof i.clientId === 'string' ? i.clientId.toLowerCase() : null;
      const reject = (reason) => incomeResults.push({ clientId: i.clientId ?? null, status: 'rejected', reason });

      if (!clientId || !UUID_RE.test(clientId)) { reject('clientId must be a UUID'); continue; }
      if (!Number.isInteger(i.amountKobo) || i.amountKobo <= 0) { reject('amountKobo must be a positive whole number'); continue; }
      const t = await checkTime(i.receivedAt);
      if (!t.iso) { reject(t.reason); continue; }

      const inserted = await client.query(
        `INSERT INTO extra_income (period_id, amount_kobo, note, received_at, client_id)
         VALUES ($1, $2, $3, $4::timestamptz, $5::uuid)
         ON CONFLICT (period_id, client_id) WHERE client_id IS NOT NULL DO NOTHING
         RETURNING id`,
        [period.id, i.amountKobo, typeof i.note === 'string' ? i.note.slice(0, 200) : null, t.iso, clientId]
      );
      incomeResults.push({ clientId, status: inserted.rows.length ? 'created' : 'duplicate' });
    }

    await client.query('COMMIT');
    res.json({ expenses: expenseResults, income: incomeResults });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (e) { /* connection already gone */ }
    console.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  } finally {
    client.release();
  }
});

// ---------- Expense history (current cycle, newest first) ----------
router.get('/expenses', async (req, res) => {
  try {
    let limit = 50;
    if (req.query.limit !== undefined) {
      limit = Number(req.query.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        return res.status(400).json({ error: 'limit must be a whole number from 1 to 100' });
      }
    }
    let offset = 0;
    if (req.query.offset !== undefined) {
      offset = Number(req.query.offset);
      if (!Number.isInteger(offset) || offset < 0) {
        return res.status(400).json({ error: 'offset must be a whole number, 0 or more' });
      }
    }

    const periodId = await getActivePeriodId(req.userId);
    if (!periodId) {
      return res.status(404).json({ error: 'No active budget. Call POST /budget/setup first.' });
    }

    // Ask for one extra row. If it comes back, we know there is another page.
    const result = await pool.query(
      `SELECT id, amount_kobo, category, note, spent_at
       FROM expenses
       WHERE period_id = $1
       ORDER BY spent_at DESC, id DESC
       LIMIT $2 OFFSET $3`,
      [periodId, limit + 1, offset]
    );

    const hasMore = result.rows.length > limit;
    const rows = result.rows.slice(0, limit);

    res.json({
      expenses: rows.map(r => ({
        id: r.id,
        amountKobo: Number(r.amount_kobo),
        category: r.category,
        note: r.note,
        spentAt: r.spent_at
      })),
      hasMore
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

// ---------- Edit an expense in the current cycle ----------
router.patch('/expenses/:expenseId', async (req, res) => {
  try {
    if (!/^\d{1,9}$/.test(req.params.expenseId)) {
      return res.status(404).json({ error: 'Expense not found in your current cycle' });
    }
    const expenseId = Number(req.params.expenseId);

    const { amountKobo, category, note } = req.body || {};

    if (amountKobo === undefined && category === undefined && note === undefined) {
      return res.status(400).json({ error: 'Send at least one of amountKobo, category, note' });
    }
    if (amountKobo !== undefined && (!Number.isInteger(amountKobo) || amountKobo <= 0)) {
      return res.status(400).json({ error: 'amountKobo must be a positive whole number' });
    }
    if (category !== undefined && !CATEGORIES.includes(category)) {
      return res.status(400).json({ error: 'Invalid category', allowed: CATEGORIES });
    }
    if (note !== undefined && note !== null && typeof note !== 'string') {
      return res.status(400).json({ error: 'note must be text, or null to clear it' });
    }

    const noteProvided = note !== undefined;

    // The WHERE clause only matches an expense that belongs to a cycle that
    // is active AND owned by this user. Anything else matches nothing.
    const result = await pool.query(
      `UPDATE expenses e
       SET amount_kobo = COALESCE($3::bigint, e.amount_kobo),
           category    = COALESCE($4::text, e.category),
           note        = CASE WHEN $5::boolean THEN $6::text ELSE e.note END
       FROM budget_periods bp
       WHERE e.id = $1
         AND e.period_id = bp.id
         AND bp.user_id = $2
         AND bp.is_active = true
       RETURNING e.id, e.amount_kobo, e.category, e.note, e.spent_at`,
      [
        expenseId,
        req.userId,
        amountKobo ?? null,
        category ?? null,
        noteProvided,
        noteProvided ? note : null
      ]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Expense not found in your current cycle' });
    }

    const row = result.rows[0];
    res.json({
      id: row.id,
      amountKobo: Number(row.amount_kobo),
      category: row.category,
      note: row.note,
      spentAt: row.spent_at
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

// ---------- Delete an expense in the current cycle ----------
router.delete('/expenses/:expenseId', async (req, res) => {
  try {
    if (!/^\d{1,9}$/.test(req.params.expenseId)) {
      return res.status(404).json({ error: 'Expense not found in your current cycle' });
    }
    const expenseId = Number(req.params.expenseId);

    const result = await pool.query(
      `DELETE FROM expenses e
       USING budget_periods bp
       WHERE e.id = $1
         AND e.period_id = bp.id
         AND bp.user_id = $2
         AND bp.is_active = true
       RETURNING e.id`,
      [expenseId, req.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Expense not found in your current cycle' });
    }

    res.json({ deleted: result.rows[0].id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

module.exports = router;