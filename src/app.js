import cors from 'cors';
import express from 'express';
import { config } from './config.js';
import { pool } from './db.js';
import { errorHandler, notFoundHandler } from './middleware/error-handler.js';
import { requireAuth } from './middleware/require-auth.js';
import authRoutes from './modules/auth/auth.routes.js';
import budgetRoutes from './modules/budget/budget.routes.js';
import { analyticsRoutes, dashboardRoutes } from './modules/insights/insights.routes.js';
import invitationsRoutes from './modules/room/invitations.routes.js';
import roomRoutes from './modules/room/room.routes.js';
import transactionsRoutes from './modules/transactions/transactions.routes.js';
import usersRoutes from './modules/users/users.routes.js';

const app = express();

app.disable('x-powered-by');
app.use(cors({ origin: config.corsOrigins }));
app.use(express.json({ limit: '100kb' }));

// Also proves the database connection works.
app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', database: 'connected' });
  } catch (err) {
    console.error(err);
    res.status(503).json({ status: 'error', database: 'not connected' });
  }
});

app.use('/api/auth', authRoutes);
app.use('/api/me', requireAuth, usersRoutes);
app.use('/api/dashboard', requireAuth, dashboardRoutes);
app.use('/api/analytics', requireAuth, analyticsRoutes);
app.use('/api/budget', requireAuth, budgetRoutes);
app.use('/api/transactions', requireAuth, transactionsRoutes);
app.use('/api/room', requireAuth, roomRoutes);
app.use('/api/invitations', requireAuth, invitationsRoutes);

app.use(notFoundHandler);
app.use(errorHandler);

export default app;
