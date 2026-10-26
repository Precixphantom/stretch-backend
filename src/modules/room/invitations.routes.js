import { Router } from 'express';
import { parseId } from '../../lib/validation.js';
import { acceptInvitation, declineInvitation, listInvitations } from './room.service.js';

// Room invitations sent to the signed-in user's email.
// The frontend can check this after sign-in and show a popup.
const router = Router();

const NOT_FOUND = 'Invitation not found. It may have been cancelled.';

router.get('/', async (req, res) => {
  res.json({ invitations: await listInvitations(req.userId) });
});

router.post('/:id/accept', async (req, res) => {
  const id = parseId(req.params.id, NOT_FOUND);
  res.json({ room: await acceptInvitation(req.userId, id) });
});

router.post('/:id/decline', async (req, res) => {
  await declineInvitation(req.userId, parseId(req.params.id, NOT_FOUND));
  res.status(204).end();
});

export default router;
