const rateLimit = require('express-rate-limit');

// Login: 30 attempts per 15 minutes per IP
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Try again in 15 minutes.' }
});

// Signup: 20 accounts per hour per IP
const signupLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many signups from this network. Try again later.' }
});

// Join: 10 attempts per 10 minutes per LOGGED IN USER.
// This only works on a route that runs requireAuth first,
// because it reads req.userId.
const joinLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => String(req.userId),
  message: { error: 'Too many join attempts. Try again in a few minutes.' }
});

module.exports = { loginLimiter, signupLimiter, joinLimiter };