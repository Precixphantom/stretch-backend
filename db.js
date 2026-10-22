const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: 10000 // wait up to 10 seconds for a sleeping database to wake
});

module.exports = pool;