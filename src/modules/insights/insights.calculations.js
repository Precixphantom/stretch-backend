import { addDays, daysBetween, eachDay, laterOf } from '../../lib/dates.js';

// Same rules as the frontend's lib/budget-calculations.ts, so both sides agree.
// Amounts are whole naira, but averages and daily guides can be fractional:
// the frontend's formatNaira rounds them for display.

/** Complete days of history (before today) used to estimate the recent spending pace. */
const PACE_WINDOW_DAYS = 7;

/**
 * Safe to Spend Today and Survival Mode for a budget period.
 *
 * - remaining: starting funds + extra income − recorded expenses.
 * - daysRemaining: counts today but not the income date. Income tomorrow → 1.
 *   Income today or earlier → 0, and status is "period-ended".
 * - dailyGuide: money available before today's spending ÷ daysRemaining.
 * - leftToday: dailyGuide − spentToday. Negative once today's guide is passed.
 * - guideFromTomorrow: set once today's guide is passed. What remains ÷ the days after today.
 * - evenSpread: what remains ÷ daysRemaining, from now.
 */
export function summarizeBudget(budget, transactions, today) {
  let totalIncome = 0;
  let totalSpent = 0;
  let spentToday = 0;

  for (const transaction of transactions) {
    if (transaction.type === 'income') {
      totalIncome += transaction.amount;
    } else {
      totalSpent += transaction.amount;
      if (transaction.date === today) spentToday += transaction.amount;
    }
  }

  const remaining = budget.startingAmount + totalIncome - totalSpent;
  const daysRemaining = Math.max(0, daysBetween(today, budget.nextIncomeDate));
  const hasDays = daysRemaining > 0;

  const dailyGuide = hasDays ? Math.max(0, remaining + spentToday) / daysRemaining : 0;
  const leftToday = dailyGuide - spentToday;
  const guideFromTomorrow =
    hasDays && leftToday < 0 && daysRemaining > 1 ? Math.max(0, remaining) / (daysRemaining - 1) : null;
  const evenSpread = hasDays ? Math.max(0, remaining) / daysRemaining : 0;

  const pace = estimatePace(budget, transactions, remaining, today);

  let status;
  if (!hasDays) status = 'period-ended';
  else if (remaining <= 0) status = 'overspent';
  else if (pace.kind === 'no-history') status = 'no-history';
  else if (pace.daysMoneyLasts < daysRemaining) status = 'survival';
  else status = 'on-track';

  return {
    totalIncome,
    totalSpent,
    remaining,
    daysRemaining,
    dailyGuide,
    spentToday,
    leftToday,
    guideFromTomorrow,
    evenSpread,
    pace,
    status,
  };
}

/**
 * Average daily spending over the last complete days of this period (today is
 * excluded because it is still in progress), and how long the remaining money
 * lasts at that rate.
 */
function estimatePace(budget, transactions, remaining, today) {
  const windowStart = laterOf(addDays(today, -PACE_WINDOW_DAYS), budget.startDate);
  const windowDays = daysBetween(windowStart, today);
  if (windowDays <= 0) return { kind: 'no-history' };

  const spent = transactions
    .filter((t) => t.type === 'expense' && t.date >= windowStart && t.date < today)
    .reduce((sum, expense) => sum + expense.amount, 0);
  if (spent <= 0) return { kind: 'no-history' };

  const averageDaily = spent / windowDays;
  return {
    kind: 'estimated',
    averageDaily,
    windowDays,
    daysMoneyLasts: Math.max(0, remaining) / averageDaily,
  };
}

export function expensesBetween(transactions, from, to) {
  return transactions.filter((t) => t.type === 'expense' && t.date >= from && t.date <= to);
}

/** Biggest first. `share` is the fraction of all spending in the set, 0–1. */
export function totalsByCategory(expenses) {
  const totals = new Map();
  let grandTotal = 0;
  for (const expense of expenses) {
    const entry = totals.get(expense.category) ?? { total: 0, count: 0 };
    entry.total += expense.amount;
    entry.count += 1;
    totals.set(expense.category, entry);
    grandTotal += expense.amount;
  }
  return [...totals.entries()]
    .map(([category, { total, count }]) => ({
      category,
      total,
      count,
      share: grandTotal > 0 ? total / grandTotal : 0,
    }))
    .sort((a, b) => b.total - a.total);
}

/** One entry per day from `from` to `to`, including days with no spending. */
export function totalsByDay(expenses, from, to) {
  const totals = new Map();
  for (const expense of expenses) {
    totals.set(expense.date, (totals.get(expense.date) ?? 0) + expense.amount);
  }
  return eachDay(from, to).map((date) => ({ date, total: totals.get(date) ?? 0 }));
}
