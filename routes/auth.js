const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../db');
const requireAuth = require('../middleware/auth');

const router = express.Router();

function makeToken(userId) {
  return jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: '7d' });
}

router.post('/signup', async (req, res) => {
  try {
    const { name, email, password } = req.body || {};

    if (typeof name !== 'string' || typeof email !== 'string' || typeof password !== 'string'
        || !name.trim() || !email.trim()) {
      return res.status(400).json({ error: 'name, email and password are required' });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    const cleanEmail = email.trim().toLowerCase();
    const passwordHash = await bcrypt.hash(password, 10);

    const result = await pool.query(
      'INSERT INTO users (name, email, password_hash) VALUES ($1, $2, $3) RETURNING id, name, email',
      [name.trim(), cleanEmail, passwordHash]
    );

    const user = result.rows[0];
    res.status(201).json({ user, token: makeToken(user.id) });
  } catch (err) {
    if (err.code === '23505') { // unique violation: email already exists
      return res.status(409).json({ error: 'An account with this email already exists' });
    }
    console.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};

    if (typeof email !== 'string' || typeof password !== 'string') {
      return res.status(400).json({ error: 'email and password are required' });
    }

    const result = await pool.query(
      'SELECT id, name, email, password_hash FROM users WHERE email = $1',
      [email.trim().toLowerCase()]
    );
    const user = result.rows[0];

    // Same message for "no such email" and "wrong password", so an
    // attacker can't use the API to discover which emails are registered.
    const ok = user && await bcrypt.compare(password, user.password_hash);
    if (!ok) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    res.json({
      user: { id: user.id, name: user.name, email: user.email },
      token: makeToken(user.id)
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

// ---------- The logged in user, plus what the app needs at startup ----------
router.get('/me', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT u.id, u.name, u.email, u.created_at,
              u.reminder_enabled,
              to_char(u.reminder_time, 'HH24:MI') AS reminder_time,
              EXISTS (SELECT 1 FROM budget_periods
                      WHERE user_id = u.id AND is_active = true) AS has_active_budget
       FROM users u
       WHERE u.id = $1`,
      [req.userId]
    );
    const u = result.rows[0];
    if (!u) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json({
      user: { id: u.id, name: u.name, email: u.email, createdAt: u.created_at },
      hasActiveBudget: u.has_active_budget,
      settings: { reminderEnabled: u.reminder_enabled, reminderTime: u.reminder_time }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

module.exports = router;