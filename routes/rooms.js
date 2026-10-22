const express = require('express');
const crypto = require('crypto');
const pool = require('../db');
const requireAuth = require('../middleware/auth');
const { joinLimiter } = require('../middleware/rateLimit');

const router = express.Router();
router.use(requireAuth);

// ---------- Helpers ----------

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function sendError(res, err) {
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: err.message });
  }
  console.error(err);
  return res.status(500).json({ error: 'Something went wrong' });
}

// Turns "12" into 12, and anything else (like "abc" or "1; DROP") into null
function parseId(value) {
  return /^\d{1,9}$/.test(value) ? Number(value) : null;
}

// Runs fn inside a transaction: all of its queries succeed, or none do.
async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Join codes skip look alike characters (no 0/O, 1/I)
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function makeJoinCode() {
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  }
  return code;
}

// Runs automatically for every route that has :roomId in its path.
// Rejects anyone who is not a member of that room.
router.param('roomId', async (req, res, next, value) => {
  try {
    const roomId = parseId(value);
    if (roomId === null) {
      return res.status(404).json({ error: 'Room not found' });
    }
    const result = await pool.query(
      'SELECT 1 FROM room_members WHERE room_id = $1 AND user_id = $2',
      [roomId, req.userId]
    );
    // Same 404 for "no such room" and "not your room", so outsiders
    // cannot discover which rooms exist.
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Room not found' });
    }
    req.roomId = roomId;
    next();
  } catch (err) {
    sendError(res, err);
  }
});

// Net position of every member. db can be the pool or a transaction client.
// Only ACTIVE expenses count. Disputed and withdrawn ones are ignored.
async function getBalances(db, roomId) {
  const result = await db.query(
    `SELECT
       m.user_id,
       u.name,
       COALESCE((SELECT SUM(amount_kobo) FROM room_expenses
                 WHERE room_id = $1 AND paid_by = m.user_id AND status = 'active'), 0)
       - COALESCE((SELECT SUM(s.share_kobo) FROM room_expense_shares s
                   JOIN room_expenses e ON e.id = s.expense_id
                   WHERE e.room_id = $1 AND s.user_id = m.user_id AND e.status = 'active'), 0)
       + COALESCE((SELECT SUM(amount_kobo) FROM room_settlements
                   WHERE room_id = $1 AND from_user = m.user_id AND status = 'confirmed'), 0)
       - COALESCE((SELECT SUM(amount_kobo) FROM room_settlements
                   WHERE room_id = $1 AND to_user = m.user_id AND status = 'confirmed'), 0)
       AS net_kobo
     FROM room_members m
     JOIN users u ON u.id = m.user_id
     WHERE m.room_id = $1
     ORDER BY m.user_id`,
    [roomId]
  );
  return result.rows.map(r => ({
    userId: r.user_id,
    name: r.name,
    netKobo: Number(r.net_kobo)
  }));
}

// Turns net positions into a short list of "X owes Y" lines.
// Biggest debtor pays the biggest creditor first, until everyone is at zero.
function simplifyDebts(balances) {
  const creditors = balances
    .filter(b => b.netKobo > 0)
    .map(b => ({ userId: b.userId, name: b.name, left: b.netKobo }))
    .sort((a, b) => b.left - a.left);
  const debtors = balances
    .filter(b => b.netKobo < 0)
    .map(b => ({ userId: b.userId, name: b.name, left: -b.netKobo }))
    .sort((a, b) => b.left - a.left);

  const debts = [];
  let i = 0;
  let j = 0;
  while (i < debtors.length && j < creditors.length) {
    const amount = Math.min(debtors[i].left, creditors[j].left);
    debts.push({
      fromUserId: debtors[i].userId,
      fromName: debtors[i].name,
      toUserId: creditors[j].userId,
      toName: creditors[j].name,
      amountKobo: amount
    });
    debtors[i].left -= amount;
    creditors[j].left -= amount;
    if (debtors[i].left === 0) i++;
    if (creditors[j].left === 0) j++;
  }
  return debts;
}

// A payment from "from" to "to" must not exceed what "from" owes
// or what "to" is owed.
function checkSettlementFits(balances, fromUser, toUser, amountKobo) {
  const from = balances.find(b => b.userId === fromUser);
  const to = balances.find(b => b.userId === toUser);
  if (!from || !to) throw new HttpError(400, 'Both people must be members of this room');
  if (from.netKobo >= 0) throw new HttpError(400, 'This person does not owe anything in this room');
  if (to.netKobo <= 0) throw new HttpError(400, 'This person is not owed anything in this room');
  if (amountKobo > -from.netKobo || amountKobo > to.netKobo) {
    throw new HttpError(400, 'Amount is more than what is actually owed');
  }
}

// ---------- Create a room ----------
router.post('/', async (req, res) => {
  try {
    const { name, maxMembers } = req.body || {};
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 60) {
      return res.status(400).json({ error: 'name is required (max 60 characters)' });
    }
    // maxMembers counts everyone in the room, INCLUDING the creator
    if (!Number.isInteger(maxMembers) || maxMembers < 2 || maxMembers > 20) {
      return res.status(400).json({ error: 'maxMembers must be a whole number from 2 to 20 (counting you)' });
    }

    for (let attempt = 0; attempt < 5; attempt++) {
      const code = makeJoinCode();
      try {
        // One statement: create the room AND add the creator as a member,
        // so we can never end up with a room that has no members.
        const result = await pool.query(
          `WITH new_room AS (
             INSERT INTO rooms (name, join_code, created_by, max_members)
             VALUES ($1, $2, $3::int, $4)
             RETURNING id
           )
           INSERT INTO room_members (room_id, user_id)
           SELECT id, $3::int FROM new_room
           RETURNING room_id`,
          [name.trim(), code, req.userId, maxMembers]
        );
        return res.status(201).json({
          roomId: result.rows[0].room_id,
          name: name.trim(),
          maxMembers,
          joinCode: code
        });
      } catch (err) {
        if (err.code === '23505') continue; // code already taken, try another
        throw err;
      }
    }
    throw new HttpError(500, 'Could not generate a join code, please try again');
  } catch (err) {
    sendError(res, err);
  }
});

// ---------- Join a room with a code ----------
router.post('/join', joinLimiter, async (req, res) => {
  try {
    const { code } = req.body || {};
    if (typeof code !== 'string' || !code.trim()) {
      return res.status(400).json({ error: 'code is required' });
    }

    const joined = await withTransaction(async (client) => {
      // FOR UPDATE locks this room's row until the transaction ends.
      // If two people join at the same moment, the second one waits here,
      // then counts the members AFTER the first person is already inside.
      const room = await client.query(
        'SELECT id, name, max_members FROM rooms WHERE join_code = $1 FOR UPDATE',
        [code.trim().toUpperCase()]
      );
      const r = room.rows[0];
      if (!r) throw new HttpError(404, 'No room with that code');

      const already = await client.query(
        'SELECT 1 FROM room_members WHERE room_id = $1 AND user_id = $2',
        [r.id, req.userId]
      );

      // Someone already inside takes no new seat, so skip the capacity check
      if (already.rows.length === 0) {
        const count = await client.query(
          'SELECT COUNT(*) AS n FROM room_members WHERE room_id = $1',
          [r.id]
        );
        if (Number(count.rows[0].n) >= r.max_members) {
          throw new HttpError(409, 'This room is full');
        }
        await client.query(
          'INSERT INTO room_members (room_id, user_id) VALUES ($1, $2)',
          [r.id, req.userId]
        );
      }
      return r;
    });

    res.json({ roomId: joined.id, name: joined.name });
  } catch (err) {
    sendError(res, err);
  }
});

// ---------- My rooms ----------
router.get('/', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT r.id, r.name, r.max_members,
              (SELECT COUNT(*) FROM room_members WHERE room_id = r.id) AS member_count
       FROM rooms r
       JOIN room_members m ON m.room_id = r.id
       WHERE m.user_id = $1
       ORDER BY r.created_at DESC`,
      [req.userId]
    );
    res.json(result.rows.map(r => ({
      roomId: r.id,
      name: r.name,
      maxMembers: r.max_members,
      memberCount: Number(r.member_count),
      isFull: Number(r.member_count) >= r.max_members
    })));
  } catch (err) {
    sendError(res, err);
  }
});

// ---------- Room summary: members, balances, who owes whom ----------
router.get('/:roomId', async (req, res) => {
  try {
    const room = await pool.query(
      'SELECT id, name, join_code, max_members FROM rooms WHERE id = $1',
      [req.roomId]
    );
    const balances = await getBalances(pool, req.roomId);
    const disputed = await pool.query(
      `SELECT COUNT(*) AS n FROM room_expenses WHERE room_id = $1 AND status = 'disputed'`,
      [req.roomId]
    );

    res.json({
      roomId: room.rows[0].id,
      name: room.rows[0].name,
      joinCode: room.rows[0].join_code,
      maxMembers: room.rows[0].max_members,
      memberCount: balances.length,
      isFull: balances.length >= room.rows[0].max_members,
      disputedExpenses: Number(disputed.rows[0].n), // these are NOT counted in the balances
      members: balances,             // netKobo > 0 means owed money, < 0 means owes money
      debts: simplifyDebts(balances) // e.g. "Halima owes Tobi 300000"
    });
  } catch (err) {
    sendError(res, err);
  }
});

// ---------- Record a shared expense ----------
router.post('/:roomId/expenses', async (req, res) => {
  try {
    const { item, amountKobo, sharedWith } = req.body || {};

    if (typeof item !== 'string' || !item.trim() || item.trim().length > 100) {
      return res.status(400).json({ error: 'item is required (max 100 characters)' });
    }
    if (!Number.isInteger(amountKobo) || amountKobo <= 0) {
      return res.status(400).json({ error: 'amountKobo must be a positive whole number' });
    }
    if (!Array.isArray(sharedWith) || sharedWith.length === 0
        || !sharedWith.every(Number.isInteger)) {
      return res.status(400).json({ error: 'sharedWith must be a list of user ids' });
    }

    const sharers = [...new Set(sharedWith)].sort((a, b) => a - b);

    const members = await pool.query(
      'SELECT user_id FROM room_members WHERE room_id = $1',
      [req.roomId]
    );
    const memberIds = new Set(members.rows.map(r => r.user_id));
    if (!sharers.every(id => memberIds.has(id))) {
      return res.status(400).json({ error: 'Everyone in sharedWith must be a member of this room' });
    }

    // Split fairly in whole kobo. Example: 100000 kobo among 3 people
    // gives 33334, 33333, 33333. The first few people (lowest id) take
    // the extra kobo, so the shares ALWAYS add up to the exact total.
    const base = Math.floor(amountKobo / sharers.length);
    const remainder = amountKobo % sharers.length;
    const shares = sharers.map((userId, index) => ({
      userId,
      shareKobo: base + (index < remainder ? 1 : 0)
    }));

    const created = await withTransaction(async (client) => {
      const expense = await client.query(
        `INSERT INTO room_expenses (room_id, paid_by, item, amount_kobo)
         VALUES ($1, $2, $3, $4)
         RETURNING id, item, amount_kobo, status, created_at`,
        [req.roomId, req.userId, item.trim(), amountKobo]
      );
      for (const s of shares) {
        await client.query(
          `INSERT INTO room_expense_shares (expense_id, user_id, share_kobo)
           VALUES ($1, $2, $3)`,
          [expense.rows[0].id, s.userId, s.shareKobo]
        );
      }
      return expense.rows[0];
    });

    res.status(201).json({
      id: created.id,
      item: created.item,
      amountKobo: Number(created.amount_kobo),
      status: created.status,
      paidBy: req.userId,
      createdAt: created.created_at,
      shares
    });
  } catch (err) {
    sendError(res, err);
  }
});

// ---------- Expense history (includes disputed and withdrawn ones) ----------
router.get('/:roomId/expenses', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT e.id, e.item, e.amount_kobo, e.status, e.created_at,
              e.paid_by, u.name AS paid_by_name,
              e.disputed_by, du.name AS disputed_by_name,
              e.dispute_reason, e.disputed_at,
              (SELECT json_agg(
                        json_build_object('userId', s.user_id, 'name', su.name, 'shareKobo', s.share_kobo)
                        ORDER BY s.user_id)
               FROM room_expense_shares s
               JOIN users su ON su.id = s.user_id
               WHERE s.expense_id = e.id) AS shares
       FROM room_expenses e
       JOIN users u ON u.id = e.paid_by
       LEFT JOIN users du ON du.id = e.disputed_by
       WHERE e.room_id = $1
       ORDER BY e.created_at DESC, e.id DESC`,
      [req.roomId]
    );
    res.json(result.rows.map(r => ({
      id: r.id,
      item: r.item,
      amountKobo: Number(r.amount_kobo),
      status: r.status,
      paidBy: r.paid_by,
      paidByName: r.paid_by_name,
      createdAt: r.created_at,
      disputedBy: r.disputed_by,
      disputedByName: r.disputed_by_name,
      disputeReason: r.dispute_reason,
      disputedAt: r.disputed_at,
      shares: r.shares
    })));
  } catch (err) {
    sendError(res, err);
  }
});

// ---------- Dispute an expense ----------
router.post('/:roomId/expenses/:expenseId/dispute', async (req, res) => {
  try {
    const expenseId = parseId(req.params.expenseId);
    if (expenseId === null) {
      return res.status(404).json({ error: 'Expense not found' });
    }
    const { reason } = req.body || {};
    if (typeof reason !== 'string' || !reason.trim() || reason.trim().length > 200) {
      return res.status(400).json({ error: 'reason is required (max 200 characters)' });
    }

    const updated = await withTransaction(async (client) => {
      // FOR UPDATE: two simultaneous actions on the same expense are handled one at a time
      const found = await client.query(
        `SELECT id, paid_by, status FROM room_expenses
         WHERE id = $1 AND room_id = $2
         FOR UPDATE`,
        [expenseId, req.roomId]
      );
      const e = found.rows[0];
      if (!e) throw new HttpError(404, 'Expense not found');
      if (e.status === 'withdrawn') throw new HttpError(409, 'This expense was withdrawn');
      if (e.status === 'disputed') throw new HttpError(409, 'This expense is already disputed');
      if (e.paid_by === req.userId) {
        throw new HttpError(403, 'You recorded this expense, so you cannot dispute it. Withdraw it instead.');
      }

      const sharer = await client.query(
        'SELECT 1 FROM room_expense_shares WHERE expense_id = $1 AND user_id = $2',
        [expenseId, req.userId]
      );
      if (sharer.rows.length === 0) {
        throw new HttpError(403, 'Only someone sharing this expense can dispute it');
      }

      const result = await client.query(
        `UPDATE room_expenses
         SET status = 'disputed', disputed_by = $2, dispute_reason = $3, disputed_at = now()
         WHERE id = $1
         RETURNING id, status, disputed_by, dispute_reason, disputed_at`,
        [expenseId, req.userId, reason.trim()]
      );
      return result.rows[0];
    });

    res.json({
      id: updated.id,
      status: updated.status,
      disputedBy: updated.disputed_by,
      disputeReason: updated.dispute_reason,
      disputedAt: updated.disputed_at
    });
  } catch (err) {
    sendError(res, err);
  }
});

// ---------- Retract a dispute (only the person who raised it) ----------
router.post('/:roomId/expenses/:expenseId/retract-dispute', async (req, res) => {
  try {
    const expenseId = parseId(req.params.expenseId);
    if (expenseId === null) {
      return res.status(404).json({ error: 'Expense not found' });
    }

    const updated = await withTransaction(async (client) => {
      const found = await client.query(
        `SELECT id, status, disputed_by FROM room_expenses
         WHERE id = $1 AND room_id = $2
         FOR UPDATE`,
        [expenseId, req.roomId]
      );
      const e = found.rows[0];
      if (!e) throw new HttpError(404, 'Expense not found');
      if (e.status !== 'disputed') throw new HttpError(409, 'This expense is not disputed');
      if (e.disputed_by !== req.userId) {
        throw new HttpError(403, 'Only the person who raised the dispute can retract it');
      }

      const result = await client.query(
        `UPDATE room_expenses
         SET status = 'active', disputed_by = NULL, dispute_reason = NULL, disputed_at = NULL
         WHERE id = $1
         RETURNING id, status`,
        [expenseId]
      );
      return result.rows[0];
    });

    res.json({ id: updated.id, status: updated.status });
  } catch (err) {
    sendError(res, err);
  }
});

// ---------- Withdraw an expense (only the person who recorded it) ----------
router.post('/:roomId/expenses/:expenseId/withdraw', async (req, res) => {
  try {
    const expenseId = parseId(req.params.expenseId);
    if (expenseId === null) {
      return res.status(404).json({ error: 'Expense not found' });
    }

    const updated = await withTransaction(async (client) => {
      const found = await client.query(
        `SELECT id, paid_by, status FROM room_expenses
         WHERE id = $1 AND room_id = $2
         FOR UPDATE`,
        [expenseId, req.roomId]
      );
      const e = found.rows[0];
      if (!e) throw new HttpError(404, 'Expense not found');
      if (e.paid_by !== req.userId) {
        throw new HttpError(403, 'Only the person who recorded this expense can withdraw it');
      }
      if (e.status === 'withdrawn') throw new HttpError(409, 'This expense was already withdrawn');

      const result = await client.query(
        `UPDATE room_expenses SET status = 'withdrawn' WHERE id = $1 RETURNING id, status`,
        [expenseId]
      );
      return result.rows[0];
    });

    res.json({ id: updated.id, status: updated.status });
  } catch (err) {
    sendError(res, err);
  }
});

// ---------- Payer says "I have paid" ----------
router.post('/:roomId/settlements', async (req, res) => {
  try {
    const { toUserId, amountKobo } = req.body || {};

    if (!Number.isInteger(toUserId)) {
      return res.status(400).json({ error: 'toUserId must be a user id' });
    }
    if (!Number.isInteger(amountKobo) || amountKobo <= 0) {
      return res.status(400).json({ error: 'amountKobo must be a positive whole number' });
    }
    if (toUserId === req.userId) {
      return res.status(400).json({ error: 'You cannot pay yourself' });
    }

    const balances = await getBalances(pool, req.roomId);
    checkSettlementFits(balances, req.userId, toUserId, amountKobo);

    const result = await pool.query(
      `INSERT INTO room_settlements (room_id, from_user, to_user, amount_kobo)
       VALUES ($1, $2, $3, $4)
       RETURNING id, amount_kobo, status, created_at`,
      [req.roomId, req.userId, toUserId, amountKobo]
    );

    res.status(201).json({
      id: result.rows[0].id,
      fromUser: req.userId,
      toUser: toUserId,
      amountKobo: Number(result.rows[0].amount_kobo),
      status: result.rows[0].status,
      createdAt: result.rows[0].created_at
    });
  } catch (err) {
    sendError(res, err);
  }
});

// ---------- Receiver says "I received it" ----------
router.post('/:roomId/settlements/:settlementId/confirm', async (req, res) => {
  try {
    const settlementId = parseId(req.params.settlementId);
    if (settlementId === null) {
      return res.status(404).json({ error: 'Settlement not found' });
    }

    const confirmed = await withTransaction(async (client) => {
      // FOR UPDATE locks this row so two simultaneous confirms cannot both succeed
      const found = await client.query(
        `SELECT id, from_user, to_user, amount_kobo, status
         FROM room_settlements
         WHERE id = $1 AND room_id = $2
         FOR UPDATE`,
        [settlementId, req.roomId]
      );
      const s = found.rows[0];
      if (!s) throw new HttpError(404, 'Settlement not found');
      if (s.to_user !== req.userId) {
        throw new HttpError(403, 'Only the person receiving the money can confirm');
      }
      if (s.status !== 'pending') {
        throw new HttpError(409, 'This payment is no longer pending');
      }

      // Check again, because other changes may have moved the balances
      const balances = await getBalances(client, req.roomId);
      checkSettlementFits(balances, s.from_user, s.to_user, Number(s.amount_kobo));

      const updated = await client.query(
        `UPDATE room_settlements
         SET status = 'confirmed', confirmed_at = now()
         WHERE id = $1
         RETURNING id, from_user, to_user, amount_kobo, status, confirmed_at`,
        [settlementId]
      );
      return updated.rows[0];
    });

    res.json({
      id: confirmed.id,
      fromUser: confirmed.from_user,
      toUser: confirmed.to_user,
      amountKobo: Number(confirmed.amount_kobo),
      status: confirmed.status,
      confirmedAt: confirmed.confirmed_at
    });
  } catch (err) {
    sendError(res, err);
  }
});

// ---------- Settlement history ----------
router.get('/:roomId/settlements', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT s.id, s.from_user, fu.name AS from_name, s.to_user, tu.name AS to_name,
              s.amount_kobo, s.status, s.created_at, s.confirmed_at, s.reject_reason
       FROM room_settlements s
       JOIN users fu ON fu.id = s.from_user
       JOIN users tu ON tu.id = s.to_user
       WHERE s.room_id = $1
       ORDER BY s.created_at DESC, s.id DESC`,
      [req.roomId]
    );
    res.json(result.rows.map(r => ({
      id: r.id,
      fromUser: r.from_user,
      fromName: r.from_name,
      toUser: r.to_user,
      toName: r.to_name,
      amountKobo: Number(r.amount_kobo),
      status: r.status,
      createdAt: r.created_at,
      confirmedAt: r.confirmed_at,    rejectReason: r.reject_reason
    })));
  } catch (err) {
    sendError(res, err);
  }
});

// ---------- Receiver says "I did not receive this" ----------
router.post('/:roomId/settlements/:settlementId/reject', async (req, res) => {
  try {
    const settlementId = parseId(req.params.settlementId);
    if (settlementId === null) {
      return res.status(404).json({ error: 'Settlement not found' });
    }
    const { reason } = req.body || {};
    if (typeof reason !== 'string' || !reason.trim() || reason.trim().length > 200) {
      return res.status(400).json({ error: 'reason is required (max 200 characters)' });
    }

    const rejected = await withTransaction(async (client) => {
      const found = await client.query(
        `SELECT id, to_user, status FROM room_settlements
         WHERE id = $1 AND room_id = $2
         FOR UPDATE`,
        [settlementId, req.roomId]
      );
      const s = found.rows[0];
      if (!s) throw new HttpError(404, 'Settlement not found');
      if (s.to_user !== req.userId) {
        throw new HttpError(403, 'Only the person receiving the money can reject it');
      }
      if (s.status !== 'pending') {
        throw new HttpError(409, 'Only a pending payment can be rejected');
      }

      const result = await client.query(
        `UPDATE room_settlements
         SET status = 'rejected', reject_reason = $2, rejected_at = now()
         WHERE id = $1
         RETURNING id, status, reject_reason, rejected_at`,
        [settlementId, reason.trim()]
      );
      return result.rows[0];
    });

    res.json({
      id: rejected.id,
      status: rejected.status,
      rejectReason: rejected.reject_reason,
      rejectedAt: rejected.rejected_at
    });
  } catch (err) {
    sendError(res, err);
  }
});

// ---------- Gentle reminder: "you still owe me" ----------
router.post('/:roomId/nudges', async (req, res) => {
  try {
    const { toUserId } = req.body || {};
    if (!Number.isInteger(toUserId)) {
      return res.status(400).json({ error: 'toUserId must be a user id' });
    }
    if (toUserId === req.userId) {
      return res.status(400).json({ error: 'You cannot remind yourself' });
    }

    // Only allowed along a real debt line: toUserId must currently owe YOU
    const balances = await getBalances(pool, req.roomId);
    const debt = simplifyDebts(balances).find(
      d => d.fromUserId === toUserId && d.toUserId === req.userId
    );
    if (!debt) {
      return res.status(400).json({ error: 'This person does not owe you anything right now' });
    }

    // If they already marked a payment, you should confirm or reject it instead
    const pending = await pool.query(
      `SELECT 1 FROM room_settlements
       WHERE room_id = $1 AND from_user = $2 AND to_user = $3 AND status = 'pending'`,
      [req.roomId, toUserId, req.userId]
    );
    if (pending.rows.length > 0) {
      return res.status(409).json({ error: 'They already marked a payment. Confirm or reject it first.' });
    }

    // At most one reminder per person per 24 hours, so nobody gets spammed
    const recent = await pool.query(
      `SELECT 1 FROM room_nudges
       WHERE room_id = $1 AND from_user = $2 AND to_user = $3
         AND created_at > now() - interval '24 hours'`,
      [req.roomId, req.userId, toUserId]
    );
    if (recent.rows.length > 0) {
      return res.status(429).json({ error: 'You already reminded this person in the last 24 hours' });
    }

    const result = await pool.query(
      `INSERT INTO room_nudges (room_id, from_user, to_user, amount_kobo)
       VALUES ($1, $2, $3, $4)
       RETURNING id, amount_kobo, created_at`,
      [req.roomId, req.userId, toUserId, debt.amountKobo]
    );

    res.status(201).json({
      id: result.rows[0].id,
      toUserId,
      amountKobo: Number(result.rows[0].amount_kobo),
      createdAt: result.rows[0].created_at
    });
  } catch (err) {
    sendError(res, err);
  }
});

// ---------- Reminders sent to me in this room (latest 20) ----------
router.get('/:roomId/nudges', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT n.id, n.from_user, u.name AS from_name, n.amount_kobo, n.created_at, n.seen_at
       FROM room_nudges n
       JOIN users u ON u.id = n.from_user
       WHERE n.room_id = $1 AND n.to_user = $2
       ORDER BY n.created_at DESC, n.id DESC
       LIMIT 20`,
      [req.roomId, req.userId]
    );
    res.json(result.rows.map(r => ({
      id: r.id,
      fromUserId: r.from_user,
      fromName: r.from_name,
      amountKobo: Number(r.amount_kobo), // the amount at the time. Show the live debt from GET /rooms/:roomId
      createdAt: r.created_at,
      seen: r.seen_at !== null
    })));
  } catch (err) {
    sendError(res, err);
  }
});

// ---------- Mark my reminders in this room as seen ----------
router.post('/:roomId/nudges/seen', async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE room_nudges SET seen_at = now()
       WHERE room_id = $1 AND to_user = $2 AND seen_at IS NULL
       RETURNING id`,
      [req.roomId, req.userId]
    );
    res.json({ marked: result.rows.length });
  } catch (err) {
    sendError(res, err);
  }
});

module.exports = router;