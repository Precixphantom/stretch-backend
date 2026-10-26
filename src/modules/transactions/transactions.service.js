import { pool } from '../../db.js';
import { categoriesMatching } from '../../lib/categories.js';
import { HttpError } from '../../lib/http-error.js';
import { requireActivePeriod } from '../budget/budget.service.js';

const COLUMNS = 't.id, t.type, t.amount, t.category, t.date, t.note, t.created_at AS "createdAt"';
// Newest first: latest date, then most recently added. Display lists in this order as they are.
const NEWEST_FIRST = 't.date DESC, t.created_at DESC, t.id DESC';
const NOT_FOUND = 'Transaction not found.';

// Income has no category field at all, matching the frontend's IncomeTransaction.
function toTransaction({ category, ...transaction }) {
  return transaction.type === 'expense' ? { ...transaction, category } : transaction;
}

function assertNotBefore(date, earliest) {
  if (date < earliest) {
    const message = `Choose a date in this budget period, from ${earliest} onwards.`;
    throw new HttpError(400, message, { date: message });
  }
}

/** `%` and `_` are wildcards in ILIKE. Escape them so they match themselves. */
function likePattern(text) {
  return `%${text.replace(/[\\%_]/g, '\\$&')}%`;
}

/** Every transaction in a period, newest first. Used for budget calculations. */
export async function listPeriodTransactions(periodId) {
  const { rows } = await pool.query(
    `SELECT ${COLUMNS} FROM transactions t WHERE t.period_id = $1 ORDER BY ${NEWEST_FIRST}`,
    [periodId],
  );
  return rows.map(toTransaction);
}

/**
 * The current period's transactions, filtered like the Expenses page, newest first.
 * `totals` covers every match (not just this page); `periodCount` ignores the filters,
 * so the frontend can tell "no transactions yet" from "nothing matches these filters".
 */
export async function listTransactions(userId, { type, category, from, to, search, limit, offset }) {
  const params = [userId];
  const filters = [];
  const where = (condition, value) => {
    params.push(value);
    filters.push(condition.replace('?', `$${params.length}`));
  };

  if (type !== 'all') where('t.type = ?', type);
  // Like the frontend, a category filter only applies when income isn't selected.
  if (category !== 'all' && type !== 'income') where('t.category = ?', category);
  if (from) where('t.date >= ?', from);
  if (to) where('t.date <= ?', to);
  if (search) {
    params.push(likePattern(search), categoriesMatching(search));
    filters.push(`(t.note ILIKE $${params.length - 1} OR t.category = ANY($${params.length}::text[]))`);
  }

  const base = 'FROM transactions t JOIN budget_periods p ON p.id = t.period_id WHERE p.user_id = $1 AND p.is_active';
  const matches = filters.length ? filters.join(' AND ') : 'true';

  const { rows: totals } = await pool.query(
    `SELECT count(*) AS "periodCount",
            count(*) FILTER (WHERE ${matches}) AS count,
            COALESCE(sum(t.amount) FILTER (WHERE ${matches} AND t.type = 'expense'), 0) AS spent,
            COALESCE(sum(t.amount) FILTER (WHERE ${matches} AND t.type = 'income'), 0) AS received
     ${base}`,
    params,
  );

  const { rows } = await pool.query(
    `SELECT ${COLUMNS} ${base} AND ${matches}
     ORDER BY ${NEWEST_FIRST}
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit ?? null, offset],
  );

  const { periodCount, ...filtered } = totals[0];
  return { transactions: rows.map(toTransaction), totals: filtered, periodCount };
}

export async function getTransaction(userId, id) {
  const { rows } = await pool.query(
    `SELECT ${COLUMNS}
     FROM transactions t
     JOIN budget_periods p ON p.id = t.period_id
     WHERE t.id = $1 AND p.user_id = $2 AND p.is_active`,
    [id, userId],
  );
  if (!rows[0]) throw new HttpError(404, NOT_FOUND);
  return toTransaction(rows[0]);
}

export async function createTransaction(userId, { type, amount, category = null, date, note }) {
  const period = await requireActivePeriod(userId);
  assertNotBefore(date, period.startDate);

  const { rows } = await pool.query(
    `INSERT INTO transactions AS t (period_id, type, amount, category, date, note)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING ${COLUMNS}`,
    [period.id, type, amount, category, date, note],
  );
  return toTransaction(rows[0]);
}

export async function updateTransaction(userId, id, { type, amount, category = null, date, note }) {
  const { rows: found } = await pool.query(
    `SELECT t.date, p.start_date AS "startDate"
     FROM transactions t
     JOIN budget_periods p ON p.id = t.period_id
     WHERE t.id = $1 AND p.user_id = $2 AND p.is_active`,
    [id, userId],
  );
  const existing = found[0];
  if (!existing) throw new HttpError(404, NOT_FOUND);

  // An entry dated before the period start (after the start moved) may keep its date.
  assertNotBefore(date, existing.date < existing.startDate ? existing.date : existing.startDate);

  const { rows } = await pool.query(
    `UPDATE transactions AS t
     SET type = $2, amount = $3, category = $4, date = $5, note = $6
     WHERE t.id = $1
     RETURNING ${COLUMNS}`,
    [id, type, amount, category, date, note],
  );
  return toTransaction(rows[0]);
}

export async function deleteTransaction(userId, id) {
  const { rowCount } = await pool.query(
    `DELETE FROM transactions t
     USING budget_periods p
     WHERE t.id = $1 AND p.id = t.period_id AND p.user_id = $2 AND p.is_active`,
    [id, userId],
  );
  if (rowCount === 0) throw new HttpError(404, NOT_FOUND);
}
