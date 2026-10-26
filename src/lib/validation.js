import { z } from 'zod';
import { HttpError } from './http-error.js';
import { todayISO } from './today.js';

// Same limit as the frontend's parseAmount.
export const MAX_AMOUNT = 10_000_000;

/** Whole naira, greater than zero. */
export const amountSchema = z
  .int({ error: 'Enter a whole naira amount, for example 1500.' })
  .min(1, 'Enter an amount greater than ₦0.')
  .max(MAX_AMOUNT, 'That amount is larger than Stretch supports.');

/** A calendar date, `YYYY-MM-DD`. */
export const dateSchema = z.iso.date({ error: 'Choose a valid date (YYYY-MM-DD).' });

export const pastOrTodaySchema = dateSchema.refine(
  (date) => date <= todayISO(),
  "Choose today or an earlier date. Dates can't be in the future.",
);

/**
 * Returns the parsed data, or throws a 400. The response's `error` is the first
 * problem; `details` maps each invalid field to its message.
 */
export function parse(schema, data) {
  const result = schema.safeParse(data ?? {});
  if (result.success) return result.data;

  const details = {};
  for (const issue of result.error.issues) {
    details[issue.path.join('.') || 'body'] ??= issue.message;
  }
  throw new HttpError(400, result.error.issues[0].message, details);
}

/** Ids in URLs are UUIDs. Anything else can't match a row, so it's a 404. */
export function parseId(value, notFoundMessage) {
  if (!z.uuid().safeParse(value).success) throw new HttpError(404, notFoundMessage);
  return value;
}
