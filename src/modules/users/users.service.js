import { pool } from '../../db.js';
import { HttpError } from '../../lib/http-error.js';

const USER_COLUMNS = `id, name, email, avatar_url AS "avatarUrl"`;
const REMINDER_COLUMNS = `reminder_enabled AS enabled, reminder_time AS time, reminder_dismissed_on AS "dismissedOn"`;

/** Creates the account on first sign-in, and refreshes name, email and photo from Google after that. */
export async function upsertGoogleUser({ googleSub, email, name, avatarUrl }) {
  try {
    const { rows } = await pool.query(
      `INSERT INTO users (google_sub, email, name, avatar_url)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (google_sub) DO UPDATE
         SET email = EXCLUDED.email, name = EXCLUDED.name, avatar_url = EXCLUDED.avatar_url, updated_at = now()
       RETURNING ${USER_COLUMNS}`,
      [googleSub, email, name, avatarUrl],
    );
    return rows[0];
  } catch (err) {
    if (err.code === '23505' && err.constraint === 'users_email_key') {
      throw new HttpError(409, 'This email address is already linked to a different Google account.');
    }
    throw err;
  }
}

export async function getProfile(userId) {
  const { rows } = await pool.query(`SELECT ${USER_COLUMNS}, ${REMINDER_COLUMNS} FROM users WHERE id = $1`, [userId]);
  if (!rows[0]) throw new HttpError(401, 'Your account no longer exists. Sign in again.');

  const { enabled, time, dismissedOn, ...user } = rows[0];
  return { user, reminder: { enabled, time, dismissedOn } };
}

/** Partial update. Choosing a new time re-arms the reminder for today, as the frontend did. */
export async function updateReminder(userId, changes) {
  const resetDismissed = changes.time !== undefined && changes.dismissedOn === undefined;
  const { rows } = await pool.query(
    `UPDATE users SET
       reminder_enabled = COALESCE($2::boolean, reminder_enabled),
       reminder_time = COALESCE($3::text, reminder_time),
       reminder_dismissed_on = CASE
         WHEN $4::boolean THEN $5::date
         WHEN $6::boolean THEN NULL
         ELSE reminder_dismissed_on
       END,
       updated_at = now()
     WHERE id = $1
     RETURNING ${REMINDER_COLUMNS}`,
    [
      userId,
      changes.enabled ?? null,
      changes.time ?? null,
      changes.dismissedOn !== undefined,
      changes.dismissedOn ?? null,
      resetDismissed,
    ],
  );
  if (!rows[0]) throw new HttpError(401, 'Your account no longer exists. Sign in again.');
  return rows[0];
}
