import { Router } from 'express';
import { z } from 'zod';
import { parse } from '../../lib/validation.js';
import { getAnalytics, getDashboard } from './insights.service.js';

const analyticsQuerySchema = z.object({
  range: z.enum(['period', 'week'], { error: 'range must be "period" or "week".' }).default('period'),
});

export const dashboardRoutes = Router().get('/', async (req, res) => {
  res.json(await getDashboard(req.userId));
});

export const analyticsRoutes = Router().get('/', async (req, res) => {
  const { range } = parse(analyticsQuerySchema, req.query);
  res.json(await getAnalytics(req.userId, range));
});
