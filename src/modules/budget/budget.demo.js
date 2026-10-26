import { addDays, monthName } from '../../lib/dates.js';

// The frontend's demo scenarios (data/mock-budget.ts). Dates are relative to today,
// so the demo always tells the same story whenever it is loaded.

// [days ago, amount, category, note]
const SCENARIOS = {
  /** ₦40,000 − ₦12,250 spent = ₦27,750 left. 15 days remain, so Safe to Spend Today is ₦1,850. */
  'on-track': {
    periodLength: 30,
    daysElapsed: 15,
    startingAmount: 40_000,
    expenses: [
      [15, 1_500, 'data', 'Monthly data bundle'],
      [15, 800, 'food', 'Rice and stew at the cafeteria'],
      [14, 400, 'transport', 'Keke to faculty'],
      [13, 650, 'food', 'Noodles and egg'],
      [12, 350, 'printing', 'Lecture notes photocopy'],
      [11, 1_200, 'food', 'Groceries from campus market'],
      [10, 600, 'transport', 'Bus to town'],
      [10, 500, 'giving', 'Weekly offering'],
      [9, 1_100, 'personal-care', 'Toiletries'],
      [8, 700, 'food', 'Jollof rice'],
      [7, 500, 'data', 'Airtime'],
      [6, 400, 'transport', 'Keke to faculty'],
      [6, 250, 'others', 'Pen and notebook'],
      [5, 900, 'food', 'Lunch with course mates'],
      [4, 500, 'printing', 'Assignment printing'],
      [3, 1_000, 'outings', 'Movie night'],
      [2, 600, 'food', 'Bread and tea'],
      [1, 300, 'transport', 'Okada to hostel'],
    ],
  },
  /**
   * ₦40,000 − ₦34,000 spent = ₦6,000 left with 9 days to go. The last 7 days
   * averaged ₦1,500 a day, so the money may last about 4 days: Survival Mode.
   */
  survival: {
    periodLength: 30,
    daysElapsed: 21,
    startingAmount: 40_000,
    expenses: [
      [21, 2_500, 'data', 'Monthly data bundle'],
      [20, 4_500, 'food', 'Foodstuff shopping'],
      [19, 800, 'transport', 'Bus to town'],
      [18, 2_000, 'outings', 'Birthday dinner'],
      [17, 1_200, 'food', 'Lunch at the cafeteria'],
      [16, 600, 'printing', 'Handout photocopy'],
      [15, 3_500, 'personal-care', 'Hair appointment'],
      [14, 1_000, 'giving', 'Weekly offering'],
      [13, 1_500, 'food', 'Suya and drinks'],
      [12, 2_400, 'outings', 'Weekend outing'],
      [11, 900, 'transport', 'Keke rides'],
      [10, 500, 'others', 'Laundry'],
      [9, 1_100, 'food', 'Groceries'],
      [8, 1_000, 'data', 'Airtime'],
      [7, 2_000, 'outings', 'Concert ticket'],
      [6, 1_800, 'food', 'Eating out'],
      [5, 1_200, 'food', 'Shawarma and a drink'],
      [4, 1_500, 'transport', 'Trip home and back'],
      [3, 1_000, 'food', 'Lunch'],
      [2, 2_000, 'personal-care', 'Toiletries and skincare'],
      [1, 1_000, 'data', 'Data top-up'],
    ],
  },
};

export const SCENARIO_IDS = Object.keys(SCENARIOS);

/** A budget period and its expenses, in the order they were "added". */
export function createDemoBudget(scenarioId, today) {
  const scenario = SCENARIOS[scenarioId];
  const startDate = addDays(today, -scenario.daysElapsed);

  return {
    period: {
      label: `${monthName(startDate)} allowance`,
      startingAmount: scenario.startingAmount,
      startDate,
      nextIncomeDate: addDays(startDate, scenario.periodLength),
    },
    transactions: scenario.expenses.map(([daysAgo, amount, category, note]) => ({
      type: 'expense',
      amount,
      category,
      date: addDays(today, -daysAgo),
      note,
    })),
  };
}
