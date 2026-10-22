// dotenv MUST load first, before any file that reads process.env
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const pool = require('./db');
const authRoutes = require('./routes/auth');
const budgetRoutes = require('./routes/budget');
const roomRoutes = require('./routes/rooms');
const { loginLimiter, signupLimiter } = require('./middleware/rateLimit');
const insightsRoutes = require('./routes/insights');
const settingsRoutes = require('./routes/settings');

const app = express();

app.set('trust proxy', 1);

app.use(cors());
app.use(express.json()); // lets us read JSON request bodies

// Health check: also proves the database connection works
app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', database: 'connected' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ status: 'error', database: 'not connected' });
  }
});

app.get('/ping', (req, res) => res.json({ ok: true }));

app.use('/auth/login', loginLimiter);
app.use('/auth/signup', signupLimiter);
app.use('/auth', authRoutes);
app.use('/budget', budgetRoutes);
app.use('/insights', insightsRoutes);
app.use('/rooms', roomRoutes);
app.use('/settings', settingsRoutes);

// Anything that matched no route
app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// Last safety net for unexpected errors
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Something went wrong' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));