import { HttpError } from '../lib/http-error.js';
import { verifySessionToken } from '../modules/auth/auth.service.js';

/** Accepts `Authorization: Bearer <token>` and sets `req.userId`. */
export function requireAuth(req, res, next) {
  const [scheme, token] = (req.get('authorization') ?? '').split(' ');
  if (scheme !== 'Bearer' || !token) {
    return next(new HttpError(401, 'Sign in to continue.'));
  }

  try {
    req.userId = verifySessionToken(token);
    next();
  } catch {
    next(new HttpError(401, 'Your session has expired. Sign in again.'));
  }
}
