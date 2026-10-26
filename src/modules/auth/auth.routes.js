import { Router } from 'express';
import { z } from 'zod';
import { parse } from '../../lib/validation.js';
import { upsertGoogleUser } from '../users/users.service.js';
import { createSessionToken, verifyGoogleCredential } from './auth.service.js';

const router = Router();

const signInSchema = z.object({
  credential: z.string({ error: 'Missing the Google credential.' }).min(1, 'Missing the Google credential.'),
});

// Sign in and sign up are the same step: the first Google sign-in creates the account.
router.post('/google', async (req, res) => {
  const { credential } = parse(signInSchema, req.body);
  const profile = await verifyGoogleCredential(credential);
  const user = await upsertGoogleUser(profile);
  res.json({ token: createSessionToken(user.id), user });
});

export default router;
