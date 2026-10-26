import { addDays, daysBetween, laterOf } from '../../lib/dates.js';
import { HttpError } from '../../lib/http-error.js';
import { todayISO } from '../../lib/today.js';
import { findActivePeriod } from '../budget/budget.service.js';
import { listInvitations } from '../room/room.service.js';
import { listPeriodTransactions } from '../transactions/transactions.service.js';
import { getProfile } from '../users/users.service.js';
import { expensesBetween, summarizeBudget, totalsByCategory, totalsByDay } from './insights.calculations.js';

// Read-only views computed from the budget and its transactions. `today` is
// included so the frontend uses the same date the figures were worked out for.

/** The current budget and its Safe to Spend figures. Both are null before setup. */
export async function getBudgetSummary(userId) {
  const today = todayISO();
  const budget = await findActivePeriod(userId);
  if (!budget) return { today, budget: null, summary: null };

  const transactions = await listPeriodTransactions(budget.id);
  return { today, budget, summary: summarizeBudget(budget, transactions, today) };
}

/**
 * Everything the dashboard shows, in one request. Pending room invitations are
 * included so the frontend can show its popup on the landing page.
 */
export async function getDashboard(userId) {
  const today = todayISO();
  const [{ user, reminder }, budget, invitations] = await Promise.all([
    getProfile(userId),
    findActivePeriod(userId),
    listInvitations(userId),
  ]);
  if (!budget) {
    return { today, user, reminder, budget: null, summary: null, recentTransactions: [], categories: [], invitations };
  }

  const transactions = await listPeriodTransactions(budget.id);
  return {
    today,
    user,
    reminder,
    budget,
    summary: summarizeBudget(budget, transactions, today),
    recentTransactions: transactions.slice(0, 5),
    categories: totalsByCategory(expensesBetween(transactions, budget.startDate, today)),
    invitations,
  };
}

/**
 * The Analytics page. `range` is "period" (since the budget started) or "week"
 * (the last 7 days, never before the budget started), both up to today.
 */
export async function getAnalytics(userId, range) {
  const today = todayISO();
  const budget = await findActivePeriod(userId);
  if (!budget) throw new HttpError(409, 'Set up your budget first.');

  const transactions = await listPeriodTransactions(budget.id);
  const from = range === 'period' ? budget.startDate : laterOf(addDays(today, -6), budget.startDate);
  const dayCount = Math.max(1, daysBetween(from, today) + 1);
  const expenses = expensesBetween(transactions, from, today);
  const totalSpent = expenses.reduce((sum, expense) => sum + expense.amount, 0);
  const categories = totalsByCategory(expenses);
  const days = totalsByDay(expenses, from, today);
  const highestDay = days.reduce((max, day) => (day.total > max.total ? day : max), days[0]);

  return {
    today,
    range,
    from,
    to: today,
    dayCount,
    totalSpent,
    expenseCount: expenses.length,
    dailyAverage: totalSpent / dayCount,
    topCategory: categories[0] ?? null,
    highestDay: totalSpent > 0 ? highestDay : null,
    categories,
    days,
    // The "What stands out" observations compare the average with summary.dailyGuide.
    summary: summarizeBudget(budget, transactions, today),
  };
}
