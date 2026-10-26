import { Router } from 'express';
import { z } from 'zod';
import { amountSchema, parse, parseId, pastOrTodaySchema } from '../../lib/validation.js';
import {
  addSharedExpense,
  cancelInvite,
  confirmSettlement,
  declineSettlement,
  deleteSharedExpense,
  getRoom,
  inviteRoommate,
  leaveRoom,
  markSettlementPaid,
  renameRoom,
} from './room.service.js';

// Every change responds with the whole updated room, because one change
// (an expense, a confirmed payment) moves everyone's balances.
const router = Router();

const renameSchema = z.object({
  name: z
    .string({ error: 'Give the room a name.' })
    .trim()
    .min(1, 'Give the room a name.')
    .max(60, 'Keep the room name to 60 characters or fewer.'),
});

const inviteSchema = z.object({
  email: z
    .string({ error: "Enter your roommate's email address." })
    .trim()
    .toLowerCase()
    .pipe(z.email({ error: 'Enter a valid email address, like tobi@gmail.com.' })),
});

const sharedExpenseSchema = z.object({
  description: z
    .string({ error: 'Describe what this was for.' })
    .trim()
    .min(1, 'Describe what this was for.')
    .max(60, 'Keep the description to 60 characters or fewer.'),
  amount: amountSchema,
  date: pastOrTodaySchema,
  paidBy: z.string({ error: 'Choose who paid.' }),
  splitWith: z
    .array(z.string(), { error: 'Choose at least one person to share this cost.' })
    .min(1, 'Choose at least one person to share this cost.'),
});

const settlementSchema = z.object({
  to: z.string({ error: 'Choose the roommate you paid.' }),
  amount: amountSchema.optional(),
});

// `room` is null when the user isn't in one yet.
router.get('/', async (req, res) => {
  res.json({ room: await getRoom(req.userId) });
});

router.patch('/', async (req, res) => {
  const { name } = parse(renameSchema, req.body);
  res.json({ room: await renameRoom(req.userId, name) });
});

router.post('/leave', async (req, res) => {
  await leaveRoom(req.userId);
  res.json({ room: null });
});

router.post('/invites', async (req, res) => {
  const { email } = parse(inviteSchema, req.body);
  res.status(201).json({ room: await inviteRoommate(req.userId, email) });
});

router.delete('/invites/:id', async (req, res) => {
  const id = parseId(req.params.id, 'Invite not found.');
  res.json({ room: await cancelInvite(req.userId, id) });
});

router.post('/expenses', async (req, res) => {
  const expense = parse(sharedExpenseSchema, req.body);
  res.status(201).json({ room: await addSharedExpense(req.userId, expense) });
});

router.delete('/expenses/:id', async (req, res) => {
  const id = parseId(req.params.id, 'Shared expense not found.');
  res.json({ room: await deleteSharedExpense(req.userId, id) });
});

router.post('/settlements', async (req, res) => {
  const settlement = parse(settlementSchema, req.body);
  res.status(201).json({ room: await markSettlementPaid(req.userId, settlement) });
});

router.post('/settlements/:id/confirm', async (req, res) => {
  const id = parseId(req.params.id, 'Payment not found.');
  res.json({ room: await confirmSettlement(req.userId, id) });
});

router.post('/settlements/:id/decline', async (req, res) => {
  const id = parseId(req.params.id, 'Payment not found.');
  res.json({ room: await declineSettlement(req.userId, id) });
});

export default router;
