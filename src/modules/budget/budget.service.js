import { pool, withTransaction } from '../../db.js';
import { HttpError } from '../../lib/http-error.js';

const PERIOD_COLUMNS = `id, label, starting_amount AS "startingAmount", start_date AS "startDate",
  next_income_date AS "nextIncomeDate"`;

/** The user's current budget period, or null before they've set one up. */
export async function findActivePeriod(userId) {
  const { rows } = await pool.query(
    `SELECT ${PERIOD_COLUMNS} FROM budget_periods WHERE user_id = $1 AND is_active`,
    [userId],
  );
  return rows[0] ?? null;
}

export async function requireActivePeriod(userId) {
  const period = await findActivePeriod(userId);
  if (!period) throw new HttpError(409, 'Set up your budget first.');
  return period;
}

/**
 * Starts a fresh period. The previous one is kept but deactivated, so its
 * transactions drop out of the app, as "Start a new period" did in the frontend.
 * `transactions` pre-fills the period (used by the demo scenarios).
 */
export async function startPeriod(userId, { label, startingAmount, startDate, nextIncomeDate }, transactions = []) {
  return withTransaction(async (client) => {
    await client.query('UPDATE budget_periods SET is_active = false WHERE user_id = $1 AND is_active', [userId]);
    const { rows } = await client.query(
      `INSERT INTO budget_periods (user_id, label, starting_amount, start_date, next_income_date)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING ${PERIOD_COLUMNS}`,
      [userId, label, startingAmount, startDate, nextIncomeDate],
    );
    const period = rows[0];

    if (transactions.length > 0) {
      // Every row in one statement gets the same now(), so step created_at by a
      // millisecond per row to keep the order they were listed in.
      await client.query(
        `INSERT INTO transactions (period_id, type, amount, category, date, note, created_at)
         SELECT $1, t.type, t.amount, t.category, t.date, t.note, now() + t.position * interval '1 millisecond'
         FROM unnest($2::text[], $3::int[], $4::text[], $5::date[], $6::text[])
           WITH ORDINALITY AS t (type, amount, category, date, note, position)`,
        [
          period.id,
          transactions.map((t) => t.type),
          transactions.map((t) => t.amount),
          transactions.map((t) => t.category ?? null),
          transactions.map((t) => t.date),
          transactions.map((t) => t.note),
        ],
      );
    }
    return period;
  });
}

export async function updateActivePeriod(userId, { label, startingAmount, startDate, nextIncomeDate }) {
  const { rows } = await pool.query(
    `UPDATE budget_periods
     SET label = $2, starting_amount = $3, start_date = $4, next_income_date = $5
     WHERE user_id = $1 AND is_active
     RETURNING ${PERIOD_COLUMNS}`,
    [userId, label, startingAmount, startDate, nextIncomeDate],
  );
  if (!rows[0]) throw new HttpError(409, 'Set up your budget first.');
  return rows[0];
}
