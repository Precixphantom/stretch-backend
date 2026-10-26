import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { addDays } from '../src/lib/dates.js';
import { createDemoBudget } from '../src/modules/budget/budget.demo.js';
import {
  expensesBetween,
  summarizeBudget,
  totalsByCategory,
  totalsByDay,
} from '../src/modules/insights/insights.calculations.js';

const today = '2026-11-15';

function demo(scenario) {
  const { period, transactions } = createDemoBudget(scenario, today);
  return { budget: period, transactions };
}

describe('summarizeBudget', () => {
  // The frontend README's demo walkthrough.
  it('on track: ₦27,750 left over 15 days is ₦1,850 a day', () => {
    const { budget, transactions } = demo('on-track');
    const summary = summarizeBudget(budget, transactions, today);
    assert.equal(summary.remaining, 27_750);
    assert.equal(summary.daysRemaining, 15);
    assert.equal(summary.dailyGuide, 1_850);
    assert.equal(summary.leftToday, 1_850);
    assert.equal(summary.status, 'on-track');
  });

  it('spending ₦2,000 today drops the card to ₦0 and spreads the rest over 14 days', () => {
    const { budget, transactions } = demo('on-track');
    transactions.push({ type: 'expense', amount: 2_000, category: 'food', date: today, note: '' });
    const summary = summarizeBudget(budget, transactions, today);
    assert.equal(summary.dailyGuide, 1_850); // fixed for the day
    assert.equal(summary.leftToday, -150);
    assert.equal(summary.guideFromTomorrow, 25_750 / 14);
  });

  it('survival: ₦6,000 left, 9 days, ₦1,500 a day lasts about 4 days', () => {
    const { budget, transactions } = demo('survival');
    const summary = summarizeBudget(budget, transactions, today);
    assert.equal(summary.remaining, 6_000);
    assert.equal(summary.daysRemaining, 9);
    assert.deepEqual(summary.pace, { kind: 'estimated', averageDaily: 1_500, windowDays: 7, daysMoneyLasts: 4 });
    assert.equal(Math.round(summary.evenSpread), 667);
    assert.equal(summary.status, 'survival');
  });

  it('extra income raises what is left', () => {
    const { budget, transactions } = demo('survival');
    transactions.push({ type: 'income', amount: 3_000, date: today, note: 'From mum' });
    const summary = summarizeBudget(budget, transactions, today);
    assert.equal(summary.totalIncome, 3_000);
    assert.equal(summary.remaining, 9_000);
  });

  it('ends the period on the income date instead of dividing by zero', () => {
    const budget = { startingAmount: 10_000, startDate: addDays(today, -30), nextIncomeDate: today };
    const summary = summarizeBudget(budget, [], today);
    assert.equal(summary.daysRemaining, 0);
    assert.equal(summary.dailyGuide, 0);
    assert.equal(summary.status, 'period-ended');
  });

  it('has no pace estimate on the first day', () => {
    const budget = { startingAmount: 10_000, startDate: today, nextIncomeDate: addDays(today, 10) };
    const summary = summarizeBudget(budget, [], today);
    assert.deepEqual(summary.pace, { kind: 'no-history' });
    assert.equal(summary.status, 'no-history');
  });

  it('is overspent once the money runs out', () => {
    const budget = { startingAmount: 1_000, startDate: addDays(today, -2), nextIncomeDate: addDays(today, 5) };
    const spent = [{ type: 'expense', amount: 1_500, category: 'food', date: addDays(today, -1), note: '' }];
    const summary = summarizeBudget(budget, spent, today);
    assert.equal(summary.remaining, -500);
    assert.equal(summary.status, 'overspent');
  });
});

describe('analytics totals', () => {
  it('ranks categories by spending, with shares adding up to 1', () => {
    const { budget, transactions } = demo('on-track');
    const totals = totalsByCategory(expensesBetween(transactions, budget.startDate, today));
    assert.equal(totals[0].category, 'food');
    assert.equal(totals[0].total, 4_850);
    assert.ok(Math.abs(totals.reduce((sum, item) => sum + item.share, 0) - 1) < 1e-9);
  });

  it('lists every day in the range, including days with no spending', () => {
    const { transactions } = demo('on-track');
    const days = totalsByDay(expensesBetween(transactions, addDays(today, -6), today), addDays(today, -6), today);
    assert.equal(days.length, 7);
    assert.deepEqual(days.at(-1), { date: today, total: 0 });
    assert.deepEqual(days[0], { date: addDays(today, -6), total: 650 });
  });
});
