import pg from 'pg';
import { config } from './config.js';

// Return DATE columns as the 'YYYY-MM-DD' strings the frontend uses. The default
// parser builds a JS Date at local midnight, which shifts days across time zones.
pg.types.setTypeParser(pg.types.builtins.DATE, (value) => value);
// count(*) and SUM over integers are BIGINT. Naira totals fit safely in a JS number.
pg.types.setTypeParser(pg.types.builtins.INT8, Number);

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  connectionTimeoutMillis: 10_000, // hosted databases can take a few seconds to wake up
});

/** Runs `fn` with a client inside a transaction: every query in it succeeds, or none do. */
export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
