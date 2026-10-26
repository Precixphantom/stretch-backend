import { Router } from 'express';
import { z } from 'zod';
import { CATEGORY_IDS } from '../../lib/categories.js';
import { amountSchema, dateSchema, parse, parseId, pastOrTodaySchema } from '../../lib/validation.js';
import { getBudgetSummary } from '../insights/insights.service.js';
import {
  createTransaction,
  deleteTransaction,
  getTransaction,
  listTransactions,
  updateTransaction,
} from './transactions.service.js';

const router = Router();

const commonFields = {
  amount: amountSchema,
  date: pastOrTodaySchema,
  note: z
    .string({ error: 'The note must be text.' })
    .trim()
    .max(60, 'Keep the note to 60 characters or fewer.')
    .default(''),
};

const transactionSchema = z.discriminatedUnion(
  'type',
  [
    z.object({
      type: z.literal('expense'),
      category: z.enum(CATEGORY_IDS, { error: 'Choose a category.' }),
      ...commonFields,
    }),
    z.object({ type: z.literal('income'), ...commonFields }),
  ],
  { error: 'type must be "expense" or "income".' },
);

// Query string filters. Everything is optional; the defaults return the whole period.
const listQuerySchema = z
  .object({
    type: z.enum(['all', 'expense', 'income'], { error: 'type must be all, expense or income.' }).default('all'),
    category: z.enum(['all', ...CATEGORY_IDS], { error: 'Unknown category.' }).default('all'),
    from: dateSchema.optional(),
    to: dateSchema.optional(),
    search: z.string({ error: 'search must be text.' }).trim().max(60, 'Keep the search short.').optional(),
    limit: z.coerce
      .number({ error: 'limit must be a number.' })
      .int('limit must be a whole number.')
      .min(1, 'limit must be at least 1.')
      .max(500, 'limit can be at most 500.')
      .optional(),
    offset: z.coerce
      .number({ error: 'offset must be a number.' })
      .int('offset must be a whole number.')
      .min(0, "offset can't be negative.")
      .default(0),
  })
  .refine((query) => !query.from || !query.to || query.from <= query.to, {
    error: '"from" must be on or before "to".',
    path: ['from'],
  });

const NOT_FOUND = 'Transaction not found.';

router.get('/', async (req, res) => {
  const filters = parse(listQuerySchema, req.query);
  res.json(await listTransactions(req.userId, filters));
});

router.get('/:id', async (req, res) => {
  const id = parseId(req.params.id, NOT_FOUND);
  res.json({ transaction: await getTransaction(req.userId, id) });
});

// Each change also returns the recalculated budget summary, so the frontend can say
// "Expense added. You can spend ₦X more today." without another request.

router.post('/', async (req, res) => {
  const draft = parse(transactionSchema, req.body);
  const transaction = await createTransaction(req.userId, draft);
  const { summary } = await getBudgetSummary(req.userId);
  res.status(201).json({ transaction, summary });
});

router.put('/:id', async (req, res) => {
  const id = parseId(req.params.id, NOT_FOUND);
  const draft = parse(transactionSchema, req.body);
  const transaction = await updateTransaction(req.userId, id, draft);
  const { summary } = await getBudgetSummary(req.userId);
  res.json({ transaction, summary });
});

router.delete('/:id', async (req, res) => {
  await deleteTransaction(req.userId, parseId(req.params.id, NOT_FOUND));
  const { summary } = await getBudgetSummary(req.userId);
  res.json({ summary });
});

export default router;
