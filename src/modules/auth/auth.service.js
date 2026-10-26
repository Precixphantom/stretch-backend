import { OAuth2Client } from 'google-auth-library';
import jwt from 'jsonwebtoken';
import { config } from '../../config.js';
import { HttpError } from '../../lib/http-error.js';

// Caches Google's public signing keys between requests.
const googleClient = new OAuth2Client();

/**
 * Verifies the ID token ("credential") that Sign In With Google gave the browser.
 * verifyIdToken checks the signature against Google's keys, and the aud, iss and exp
 * claims. We also require a verified email, because roommates are invited by email.
 */
export async function verifyGoogleCredential(credential) {
  let payload;
  try {
    const ticket = await googleClient.verifyIdToken({ idToken: credential, audience: config.googleClientIds });
    payload = ticket.getPayload();
  } catch (err) {
    console.warn('Rejected Google credential:', err.message);
    throw new HttpError(401, "Google sign-in didn't work. Please try again.");
  }

  if (!payload?.sub || !payload.email) {
    throw new HttpError(401, "Google didn't share your account details. Please try again.");
  }
  if (payload.email_verified !== true) {
    throw new HttpError(403, 'Verify your Google account email address, then sign in again.');
  }

  const email = payload.email.toLowerCase();
  return {
    googleSub: payload.sub, // Google's permanent account id. Emails can change; this can't.
    email,
    name: payload.name?.trim() || payload.given_name?.trim() || email.split('@')[0],
    avatarUrl: payload.picture ?? null,
  };
}

/** Our own session token, sent back by the frontend as `Authorization: Bearer <token>`. */
export function createSessionToken(userId) {
  return jwt.sign({}, config.jwtSecret, { subject: userId, expiresIn: config.jwtExpiresIn, algorithm: 'HS256' });
}

/** Returns the user id, or throws if the token is invalid or expired. */
export function verifySessionToken(token) {
  const { sub } = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] });
  if (!sub) throw new Error('Session token has no subject');
  return sub;
}
