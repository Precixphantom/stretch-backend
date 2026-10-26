import { Router } from 'express';
import { z } from 'zod';
import { dateSchema, parse } from '../../lib/validation.js';
import { getProfile, updateReminder } from './users.service.js';

const router = Router();

const reminderSchema = z
  .object({
    enabled: z.boolean({ error: 'enabled must be true or false.' }).optional(),
    time: z
      .string({ error: 'Use a 24-hour time like 21:00.' })
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use a 24-hour time like 21:00.')
      .optional(),
    /** The day the user tapped "I'm all done". null clears it. */
    dismissedOn: dateSchema.nullable().optional(),
  })
  .refine((changes) => Object.keys(changes).length > 0, 'Send enabled, time or dismissedOn.');

// The signed-in user and their evening reminder setting.
router.get('/', async (req, res) => {
  res.json(await getProfile(req.userId));
});

router.patch('/reminder', async (req, res) => {
  const changes = parse(reminderSchema, req.body);
  res.json({ reminder: await updateReminder(req.userId, changes) });
});

export default router;
