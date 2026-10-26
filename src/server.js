import app from './app.js';
import { config } from './config.js';
import { pool } from './db.js';

const server = app.listen(config.port, () => {
  console.log(`Stretch API listening on http://localhost:${config.port}`);
});

// Finish in-flight requests and close database connections when the host stops the app.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    server.close(() => pool.end().finally(() => process.exit(0)));
  });
}
