import { Router } from 'express';
import { z } from 'zod';
import { todayISO } from '../../lib/today.js';
import { amountSchema, dateSchema, parse } from '../../lib/validation.js';
import { getBudgetSummary } from '../insights/insights.service.js';
import { listPeriodTransactions } from '../transactions/transactions.service.js';
import { createDemoBudget, SCENARIO_IDS } from './budget.demo.js';
import { startPeriod, updateActivePeriod } from './budget.service.js';

// Every budget response is { today, budget, summary }: the period and its
// Safe to Spend figures, recalculated after the change.
const router = Router();

const budgetFields = {
  label: z
    .string({ error: 'Give this period a name, like "November allowance".' })
    .trim()
    .min(1, 'Give this period a name, like "November allowance".')
    .max(40, 'Keep the period name to 40 characters or fewer.'),
  startingAmount: amountSchema,
  nextIncomeDate: dateSchema,
};

// Same rules as the frontend's new-period dialog. startDate defaults to today.
const newPeriodSchema = z
  .object({ ...budgetFields, startDate: dateSchema.optional() })
  .transform((period) => ({ ...period, startDate: period.startDate ?? todayISO() }))
  .refine((period) => period.startDate <= todayISO(), {
    error: "The start date can't be in the future.",
    path: ['startDate'],
  })
  .refine((period) => period.nextIncomeDate > todayISO(), {
    error: 'Choose a next income date after today.',
    path: ['nextIncomeDate'],
  });

// Same rules as the frontend's budget form. A next income date that has already
// passed is allowed: the dashboard then asks the user to start a new period.
const updatePeriodSchema = z
  .object({ ...budgetFields, startDate: dateSchema })
  .refine((period) => period.startDate <= todayISO(), {
    error: "The start date can't be in the future.",
    path: ['startDate'],
  })
  .refine((period) => period.nextIncomeDate > period.startDate, {
    error: 'Choose a next income date after the start date.',
    path: ['nextIncomeDate'],
  });

const demoSchema = z.object({
  scenario: z.enum(SCENARIO_IDS, { error: 'scenario must be "on-track" or "survival".' }),
});

// `budget` and `summary` are null until the user sets one up: show the setup screen then.
router.get('/', async (req, res) => {
  res.json(await getBudgetSummary(req.userId));
});

// First-time setup and "Start a new period".
router.post('/', async (req, res) => {
  const period = parse(newPeriodSchema, req.body);
  await startPeriod(req.userId, period);
  res.status(201).json(await getBudgetSummary(req.userId));
});

// Edit the current period.
router.put('/', async (req, res) => {
  const period = parse(updatePeriodSchema, req.body);
  await updateActivePeriod(req.userId, period);
  res.json(await getBudgetSummary(req.userId));
});

// Settings → Demo data. Starts a new period filled with the frontend's sample story.
// Only the personal budget changes: Roommate Kitty is shared with real people.
router.post('/demo', async (req, res) => {
  const { scenario } = parse(demoSchema, req.body);
  const { period, transactions } = createDemoBudget(scenario, todayISO());
  const budget = await startPeriod(req.userId, period, transactions);
  res.status(201).json({
    ...(await getBudgetSummary(req.userId)),
    transactions: await listPeriodTransactions(budget.id),
  });
});

export default router;
