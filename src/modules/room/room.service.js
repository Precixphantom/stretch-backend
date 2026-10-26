import { pool, withTransaction } from '../../db.js';
import { HttpError } from '../../lib/http-error.js';
import { todayISO } from '../../lib/today.js';
import { calculateBalances, splitAmount, suggestTransfers } from './room.calculations.js';

const NO_ROOM = "You're not in a room yet. Invite a roommate to start one.";

const naira = (amount) => `₦${amount.toLocaleString('en-NG')}`;

async function findRoomId(db, userId) {
  const { rows } = await db.query('SELECT room_id FROM room_members WHERE user_id = $1 AND left_at IS NULL', [
    userId,
  ]);
  return rows[0]?.room_id ?? null;
}

/**
 * Finds the user's room and locks it until the transaction ends, so changes to one
 * room, and the balance checks they rely on, happen one at a time.
 */
async function lockUsersRoom(client, userId) {
  const { rows } = await client.query(
    `SELECT r.id FROM rooms r
     JOIN room_members m ON m.room_id = r.id
     WHERE m.user_id = $1 AND m.left_at IS NULL
     FOR UPDATE OF r`,
    [userId],
  );
  if (!rows[0]) throw new HttpError(404, NO_ROOM);
  return rows[0].id;
}

/** Current members in room order: whoever joined first gets leftover naira first. */
async function activeMemberIds(db, roomId) {
  const { rows } = await db.query(
    'SELECT user_id FROM room_members WHERE room_id = $1 AND left_at IS NULL ORDER BY joined_at, user_id',
    [roomId],
  );
  return rows.map((row) => row.user_id);
}

/**
 * Everything the Roommate Kitty page shows, from `userId`'s point of view.
 * Only shared costs appear here, never anyone's personal budget.
 */
async function loadRoom(db, roomId, userId) {
  const { rows: rooms } = await db.query('SELECT id, name FROM rooms WHERE id = $1', [roomId]);

  // Includes people who have left, so older expenses can still show their names.
  const { rows: members } = await db.query(
    `SELECT u.id, u.name, u.avatar_url AS "avatarUrl", m.left_at IS NOT NULL AS "hasLeft"
     FROM room_members m
     JOIN users u ON u.id = m.user_id
     WHERE m.room_id = $1
     ORDER BY m.joined_at, u.id`,
    [roomId],
  );

  // Lists below are newest first, ready to display as they are.
  const { rows: invites } = await db.query(
    `SELECT id, email, invited_by AS "invitedBy", created_at AS "createdAt"
     FROM room_invites
     WHERE room_id = $1
     ORDER BY created_at DESC, id DESC`,
    [roomId],
  );

  const { rows: expenses } = await db.query(
    `SELECT e.id, e.description, e.amount, e.date, e.paid_by AS "paidBy", e.created_by AS "createdBy",
            e.created_at AS "createdAt",
            json_agg(json_build_object('memberId', s.user_id, 'amount', s.amount)) AS shares
     FROM room_expenses e
     JOIN room_expense_shares s ON s.expense_id = e.id
     WHERE e.room_id = $1
     GROUP BY e.id
     ORDER BY e.date DESC, e.created_at DESC, e.id DESC`,
    [roomId],
  );

  const { rows: settlements } = await db.query(
    `SELECT id, from_user AS "from", to_user AS "to", amount, status,
            marked_paid_on AS "markedPaidOn", confirmed_on AS "confirmedOn", declined_on AS "declinedOn",
            created_at AS "createdAt"
     FROM room_settlements
     WHERE room_id = $1
     ORDER BY created_at DESC, id DESC`,
    [roomId],
  );

  const position = new Map(members.map((member, index) => [member.id, index]));
  const sharedExpenses = expenses.map(({ shares, ...expense }) => {
    const ordered = shares.sort((a, b) => position.get(a.memberId) - position.get(b.memberId));
    return { ...expense, splitWith: ordered.map((share) => share.memberId), shares: ordered };
  });

  const balances = calculateBalances(
    members.map((member) => member.id),
    sharedExpenses,
    settlements,
  );

  return {
    id: rooms[0].id,
    name: rooms[0].name,
    currentMemberId: userId,
    members,
    invites,
    sharedExpenses,
    settlements,
    balances,
    transfers: suggestTransfers(balances),
  };
}

/** Leaving needs a zero balance and no payments waiting. The last person out closes the room. */
async function leave(client, roomId, userId) {
  const room = await loadRoom(client, roomId, userId);
  const { net } = room.balances.find((balance) => balance.memberId === userId);
  if (net < 0) {
    throw new HttpError(409, `Settle up before leaving. You still owe ${naira(-net)}.`);
  }
  if (net > 0) {
    throw new HttpError(409, `Settle up before leaving. Your roommates still owe you ${naira(net)}.`);
  }
  const waiting = room.settlements.some(
    (settlement) =>
      settlement.status === 'awaiting-confirmation' && (settlement.from === userId || settlement.to === userId),
  );
  if (waiting) {
    throw new HttpError(409, 'Confirm or decline the payments waiting on you before leaving.');
  }

  await client.query('UPDATE room_members SET left_at = now() WHERE room_id = $1 AND user_id = $2', [roomId, userId]);
  // Deleting the room also removes its history and pending invites.
  await client.query(
    `DELETE FROM rooms
     WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM room_members WHERE room_id = $1 AND left_at IS NULL)`,
    [roomId],
  );
}

// The user's room

/** The user's room, or null if they aren't in one. */
export async function getRoom(userId) {
  const roomId = await findRoomId(pool, userId);
  return roomId ? loadRoom(pool, roomId, userId) : null;
}

export async function renameRoom(userId, name) {
  return withTransaction(async (client) => {
    const roomId = await lockUsersRoom(client, userId);
    await client.query('UPDATE rooms SET name = $2 WHERE id = $1', [roomId, name]);
    return loadRoom(client, roomId, userId);
  });
}

export async function leaveRoom(userId) {
  return withTransaction(async (client) => {
    const roomId = await lockUsersRoom(client, userId);
    await leave(client, roomId, userId);
  });
}

/**
 * Invites a roommate by email. They may not have signed up yet: the invite waits
 * until they sign in with Google using that email. The first invite creates the room.
 */
export async function inviteRoommate(userId, email) {
  return withTransaction(async (client) => {
    const { rows: users } = await client.query('SELECT name, email FROM users WHERE id = $1', [userId]);
    const inviter = users[0];
    if (email === inviter.email) {
      const message = "That's your own email. Enter your roommate's email address.";
      throw new HttpError(400, message, { email: message });
    }

    let roomId = await findRoomId(client, userId);
    if (roomId) {
      await client.query('SELECT 1 FROM rooms WHERE id = $1 FOR UPDATE', [roomId]);
    } else {
      const firstName = inviter.name.split(' ')[0].slice(0, 40);
      const { rows } = await client.query('INSERT INTO rooms (name, created_by) VALUES ($1, $2) RETURNING id', [
        `${firstName}'s room`,
        userId,
      ]);
      roomId = rows[0].id;
      await client.query('INSERT INTO room_members (room_id, user_id) VALUES ($1, $2)', [roomId, userId]);
    }

    const { rowCount: alreadyMember } = await client.query(
      `SELECT 1 FROM room_members m
       JOIN users u ON u.id = m.user_id
       WHERE m.room_id = $1 AND u.email = $2 AND m.left_at IS NULL`,
      [roomId, email],
    );
    if (alreadyMember) throw new HttpError(409, `${email} is already in this room.`);

    // Inviting the same email again keeps the existing invite.
    await client.query(
      `INSERT INTO room_invites (room_id, email, invited_by)
       VALUES ($1, $2, $3)
       ON CONFLICT (room_id, email) DO NOTHING`,
      [roomId, email, userId],
    );
    return loadRoom(client, roomId, userId);
  });
}

export async function cancelInvite(userId, inviteId) {
  return withTransaction(async (client) => {
    const roomId = await lockUsersRoom(client, userId);
    const { rowCount } = await client.query('DELETE FROM room_invites WHERE id = $1 AND room_id = $2', [
      inviteId,
      roomId,
    ]);
    if (rowCount === 0) throw new HttpError(404, 'Invite not found.');
    return loadRoom(client, roomId, userId);
  });
}

// Shared expenses

export async function addSharedExpense(userId, { description, amount, date, paidBy, splitWith }) {
  return withTransaction(async (client) => {
    const roomId = await lockUsersRoom(client, userId);
    const memberIds = await activeMemberIds(client, roomId);

    if (!memberIds.includes(paidBy)) {
      const message = 'Choose who paid from the people in this room.';
      throw new HttpError(400, message, { paidBy: message });
    }
    const sharing = new Set(splitWith);
    if ([...sharing].some((id) => !memberIds.includes(id))) {
      const message = 'Only people in this room can share a cost.';
      throw new HttpError(400, message, { splitWith: message });
    }

    // Shares are worked out once, here, and stored with the expense.
    const shares = splitAmount(
      amount,
      memberIds.filter((id) => sharing.has(id)),
    );
    const { rows } = await client.query(
      `INSERT INTO room_expenses (room_id, description, amount, date, paid_by, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [roomId, description, amount, date, paidBy, userId],
    );
    await client.query(
      `INSERT INTO room_expense_shares (expense_id, user_id, amount)
       SELECT $1::uuid, member_id, share FROM unnest($2::uuid[], $3::int[]) AS s (member_id, share)`,
      [rows[0].id, shares.map((share) => share.memberId), shares.map((share) => share.amount)],
    );
    return loadRoom(client, roomId, userId);
  });
}

export async function deleteSharedExpense(userId, expenseId) {
  return withTransaction(async (client) => {
    const roomId = await lockUsersRoom(client, userId);
    const { rows } = await client.query(
      'SELECT paid_by, created_by FROM room_expenses WHERE id = $1 AND room_id = $2',
      [expenseId, roomId],
    );
    const expense = rows[0];
    if (!expense) throw new HttpError(404, 'Shared expense not found.');
    if (userId !== expense.paid_by && userId !== expense.created_by) {
      throw new HttpError(403, 'Only the person who added this expense, or who paid for it, can delete it.');
    }

    await client.query('DELETE FROM room_expenses WHERE id = $1', [expenseId]);
    return loadRoom(client, roomId, userId);
  });
}

// Settling up. No money moves through Stretch: the debtor records that they paid
// outside the app, and balances only change once the recipient confirms it arrived.

/** The signed-in user says they paid `to`. `amount` defaults to everything they owe them. */
export async function markSettlementPaid(userId, { to, amount }) {
  return withTransaction(async (client) => {
    const roomId = await lockUsersRoom(client, userId);
    const room = await loadRoom(client, roomId, userId);

    const recipient = room.members.find((member) => member.id === to && !member.hasLeft);
    if (!recipient || to === userId) {
      const message = 'Choose the roommate you paid.';
      throw new HttpError(400, message, { to: message });
    }

    const owed = room.transfers.find((transfer) => transfer.from === userId && transfer.to === to);
    if (!owed) throw new HttpError(409, `You don't owe ${recipient.name} anything right now.`);

    const paid = amount ?? owed.amount;
    if (paid > owed.amount) {
      const message = `You owe ${recipient.name} ${naira(owed.amount)}. Enter that amount or less.`;
      throw new HttpError(400, message, { amount: message });
    }

    const alreadyWaiting = room.settlements.some(
      (settlement) => settlement.status === 'awaiting-confirmation' && settlement.from === userId && settlement.to === to,
    );
    if (alreadyWaiting) {
      throw new HttpError(409, `You've already marked a payment to ${recipient.name}. Wait for them to confirm it.`);
    }

    await client.query(
      `INSERT INTO room_settlements (room_id, from_user, to_user, amount, marked_paid_on)
       VALUES ($1, $2, $3, $4, $5)`,
      [roomId, userId, to, paid, todayISO()],
    );
    return loadRoom(client, roomId, userId);
  });
}

/** Only the recipient can say whether the money arrived. */
async function resolveSettlement(userId, settlementId, status) {
  return withTransaction(async (client) => {
    const roomId = await lockUsersRoom(client, userId);
    const { rows } = await client.query(
      `SELECT s.to_user, s.status, u.name AS "recipientName"
       FROM room_settlements s
       JOIN users u ON u.id = s.to_user
       WHERE s.id = $1 AND s.room_id = $2`,
      [settlementId, roomId],
    );
    const settlement = rows[0];
    if (!settlement) throw new HttpError(404, 'Payment not found.');
    if (settlement.to_user !== userId) {
      throw new HttpError(403, `Only ${settlement.recipientName} can say whether this payment arrived.`);
    }
    if (settlement.status !== 'awaiting-confirmation') {
      throw new HttpError(409, `This payment was already ${settlement.status}.`);
    }

    await client.query(
      `UPDATE room_settlements
       SET status = $2,
           confirmed_on = CASE WHEN $2 = 'confirmed' THEN $3::date END,
           declined_on = CASE WHEN $2 = 'declined' THEN $3::date END
       WHERE id = $1`,
      [settlementId, status, todayISO()],
    );
    return loadRoom(client, roomId, userId);
  });
}

export function confirmSettlement(userId, settlementId) {
  return resolveSettlement(userId, settlementId, 'confirmed');
}

/** "Not received": the debt stays outstanding, and the payer can see it was declined. */
export function declineSettlement(userId, settlementId) {
  return resolveSettlement(userId, settlementId, 'declined');
}

// Invitations the signed-in user has received

export async function listInvitations(userId) {
  const { rows } = await pool.query(
    `SELECT i.id, i.created_at AS "createdAt",
            r.id AS "roomId", r.name AS "roomName",
            (SELECT count(*) FROM room_members m WHERE m.room_id = r.id AND m.left_at IS NULL) AS "memberCount",
            inviter.name AS "inviterName", inviter.avatar_url AS "inviterAvatarUrl"
     FROM users me
     JOIN room_invites i ON i.email = me.email
     JOIN rooms r ON r.id = i.room_id
     JOIN users inviter ON inviter.id = i.invited_by
     WHERE me.id = $1
     ORDER BY i.created_at DESC`,
    [userId],
  );
  return rows.map((row) => ({
    id: row.id,
    room: { id: row.roomId, name: row.roomName, memberCount: row.memberCount },
    invitedBy: { name: row.inviterName, avatarUrl: row.inviterAvatarUrl },
    createdAt: row.createdAt,
  }));
}

/**
 * Joins the inviting room. Someone already sharing a room with others must leave
 * it first. A room with only them in it has nothing to settle, so it's closed.
 */
export async function acceptInvitation(userId, inviteId) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT i.room_id
       FROM room_invites i
       JOIN users u ON u.email = i.email
       WHERE i.id = $1 AND u.id = $2`,
      [inviteId, userId],
    );
    if (!rows[0]) throw new HttpError(404, 'Invitation not found. It may have been cancelled.');
    const roomId = rows[0].room_id;

    const currentRoomId = await findRoomId(client, userId);
    if (currentRoomId && currentRoomId !== roomId) {
      await client.query('SELECT 1 FROM rooms WHERE id = $1 FOR UPDATE', [currentRoomId]);
      const others = (await activeMemberIds(client, currentRoomId)).filter((id) => id !== userId);
      if (others.length > 0) {
        throw new HttpError(409, "You're already in a room with other roommates. Leave it before joining this one.");
      }
      await leave(client, currentRoomId, userId);
    }

    await client.query('SELECT 1 FROM rooms WHERE id = $1 FOR UPDATE', [roomId]);
    await client.query(
      `INSERT INTO room_members (room_id, user_id)
       VALUES ($1, $2)
       ON CONFLICT (room_id, user_id) DO UPDATE SET left_at = NULL`,
      [roomId, userId],
    );
    await client.query('DELETE FROM room_invites WHERE id = $1', [inviteId]);
    return loadRoom(client, roomId, userId);
  });
}

export async function declineInvitation(userId, inviteId) {
  const { rowCount } = await pool.query(
    `DELETE FROM room_invites i
     USING users u
     WHERE i.id = $1 AND u.id = $2 AND u.email = i.email`,
    [inviteId, userId],
  );
  if (rowCount === 0) throw new HttpError(404, 'Invitation not found. It may have been cancelled.');
}
