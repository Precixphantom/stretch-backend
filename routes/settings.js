const express = require('express');
const pool = require('../db');
const requireAuth = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/; // 24 hour clock, like 21:00

router.get('/', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT reminder_enabled, to_char(reminder_time, 'HH24:MI') AS reminder_time
       FROM users WHERE id = $1`,
      [req.userId]
    );
    const r = result.rows[0];
    res.json({ reminderEnabled: r.reminder_enabled, reminderTime: r.reminder_time });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

router.put('/', async (req, res) => {
  try {
    const { reminderEnabled, reminderTime } = req.body || {};

    if (reminderEnabled === undefined && reminderTime === undefined) {
      return res.status(400).json({ error: 'Send reminderEnabled and/or reminderTime' });
    }
    if (reminderEnabled !== undefined && typeof reminderEnabled !== 'boolean') {
      return res.status(400).json({ error: 'reminderEnabled must be true or false' });
    }
    if (reminderTime !== undefined && (typeof reminderTime !== 'string' || !TIME_RE.test(reminderTime))) {
      return res.status(400).json({ error: 'reminderTime must look like 21:00' });
    }

    const result = await pool.query(
      `UPDATE users
       SET reminder_enabled = COALESCE($2::boolean, reminder_enabled),
           reminder_time = COALESCE($3::time, reminder_time)
       WHERE id = $1
       RETURNING reminder_enabled, to_char(reminder_time, 'HH24:MI') AS reminder_time`,
      [
        req.userId,
        reminderEnabled === undefined ? null : reminderEnabled,
        reminderTime === undefined ? null : reminderTime
      ]
    );
    const r = result.rows[0];
    res.json({ reminderEnabled: r.reminder_enabled, reminderTime: r.reminder_time });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

module.exports = router;