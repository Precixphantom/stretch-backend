const express = require('express');
const pool = require('../db');
const requireAuth = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// "Today" in Nigerian time, same rule as the rest of the app
const LAGOS_TODAY = `(now() AT TIME ZONE 'Africa/Lagos')::date`;

// ---------- Weekly summary: the last 7 days of the active cycle ----------
router.get('/weekly', async (req, res) => {
  try {
    const periodResult = await pool.query(
      `SELECT
         bp.id,
         bp.starting_balance_kobo,
         (bp.next_allowance_date - ${LAGOS_TODAY}) AS days_left,
         ((${LAGOS_TODAY} - bp.start_date) + 1) AS days_elapsed,
         COALESCE((SELECT SUM(amount_kobo) FROM expenses WHERE period_id = bp.id), 0) AS total_spent,
         COALESCE((SELECT SUM(amount_kobo) FROM extra_income WHERE period_id = bp.id), 0) AS total_extra
       FROM budget_periods bp
       WHERE bp.user_id = $1 AND bp.is_active = true`,
      [req.userId]
    );
    const p = periodResult.rows[0];
    if (!p) {
      return res.status(404).json({ error: 'No active budget. Call POST /budget/setup first.' });
    }

    // "Last 7 days" means today and the 6 days before it
    const byCategory = await pool.query(
      `SELECT category, SUM(amount_kobo) AS total_kobo
       FROM expenses
       WHERE period_id = $1
         AND (spent_at AT TIME ZONE 'Africa/Lagos')::date >= ${LAGOS_TODAY} - 6
       GROUP BY category
       ORDER BY total_kobo DESC`,
      [p.id]
    );
    const byDay = await pool.query(
      `SELECT (spent_at AT TIME ZONE 'Africa/Lagos')::date::text AS day,
              SUM(amount_kobo) AS total_kobo
       FROM expenses
       WHERE period_id = $1
         AND (spent_at AT TIME ZONE 'Africa/Lagos')::date >= ${LAGOS_TODAY} - 6
       GROUP BY 1
       ORDER BY 1`,
      [p.id]
    );

    const balance = Number(p.starting_balance_kobo) + Number(p.total_extra) - Number(p.total_spent);
    const daysLeft = Number(p.days_left);
    const daysElapsed = Math.max(1, Number(p.days_elapsed));
    const windowDays = Math.min(7, daysElapsed); // a cycle younger than 7 days has fewer days to average over

    const weekTotal = byCategory.rows.reduce((sum, r) => sum + Number(r.total_kobo), 0);
    const avgDaily = Math.round(weekTotal / windowDays);

    const allowanceDue = daysLeft <= 0;
    const projectedNeed = allowanceDue ? 0 : avgDaily * daysLeft;

    res.json({
      windowDays,
      totalSpentKobo: weekTotal,
      averageDailySpendKobo: avgDaily,
      balanceKobo: balance,
      daysLeft,
      allowanceDue,
      // onTrack: would the balance cover the rest of the cycle at this week's pace?
      onTrack: allowanceDue ? null : balance >= projectedNeed,
      surplusOrShortfallKobo: allowanceDue ? null : balance - projectedNeed,
      spendingByCategory: byCategory.rows.map(r => ({
        category: r.category,
        totalKobo: Number(r.total_kobo)
      })),
      spendingByDay: byDay.rows.map(r => ({
        day: r.day,
        totalKobo: Number(r.total_kobo)
      }))
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

// ---------- Cycle history and comparison (up to the last 12 cycles) ----------
router.get('/periods', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT
         bp.id,
         bp.is_active,
         bp.starting_balance_kobo,
         bp.start_date::text AS start_date,
         bp.next_allowance_date::text AS next_allowance_date,
         (bp.next_allowance_date - bp.start_date) AS planned_days,
         COALESCE((SELECT SUM(amount_kobo) FROM expenses WHERE period_id = bp.id), 0) AS total_spent,
         COALESCE((SELECT SUM(amount_kobo) FROM extra_income WHERE period_id = bp.id), 0) AS total_extra
       FROM budget_periods bp
       WHERE bp.user_id = $1
       ORDER BY bp.id DESC
       LIMIT 12`,
      [req.userId]
    );

    const periods = result.rows.map(r => {
      const spent = Number(r.total_spent);
      const extra = Number(r.total_extra);
      return {
        periodId: r.id,
        isActive: r.is_active,
        startDate: r.start_date,
        nextAllowanceDate: r.next_allowance_date,
        plannedDays: Number(r.planned_days),
        startingBalanceKobo: Number(r.starting_balance_kobo),
        extraIncomeKobo: extra,
        totalSpentKobo: spent,
        balanceKobo: Number(r.starting_balance_kobo) + extra - spent,
        spendingByCategory: []
      };
    });

    if (periods.length > 0) {
      const ids = periods.map(p => p.periodId);
      const cats = await pool.query(
        `SELECT period_id, category, SUM(amount_kobo) AS total_kobo
         FROM expenses
         WHERE period_id = ANY($1::int[])
         GROUP BY period_id, category
         ORDER BY total_kobo DESC`,
        [ids]
      );
      const byPeriod = new Map(periods.map(p => [p.periodId, p]));
      for (const c of cats.rows) {
        byPeriod.get(c.period_id).spendingByCategory.push({
          category: c.category,
          totalKobo: Number(c.total_kobo)
        });
      }
    }

    // Compare the newest cycle with the one before it
    let comparison = null;
    if (periods.length >= 2) {
      const latest = periods[0];
      const previous = periods[1];
      const change = latest.totalSpentKobo - previous.totalSpentKobo;
      comparison = {
        latestPeriodId: latest.periodId,
        previousPeriodId: previous.periodId,
        latestIsStillRunning: latest.isActive, // an unfinished cycle is not a fair comparison yet
        spentChangeKobo: change, // negative means the student spent less than last time
        spentChangePercent: previous.totalSpentKobo > 0
          ? Math.round((change / previous.totalSpentKobo) * 1000) / 10
          : null
      };
    }

    res.json({ periods, comparison });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

module.exports = router;