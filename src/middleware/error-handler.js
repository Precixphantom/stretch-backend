import { HttpError } from '../lib/http-error.js';

export function notFoundHandler(req, res) {
  res.status(404).json({ error: 'Route not found' });
}

// Express 5 passes errors thrown in async handlers here, so routes can just `throw`.
// Express recognises an error handler by its four arguments, so `next` must stay.
export function errorHandler(err, req, res, next) {
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: err.message, ...(err.details && { details: err.details }) });
  }

  // Malformed JSON, oversized bodies and the like, raised by express.json().
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'The request body must be valid JSON.' });
  }
  if (err.expose && err.status >= 400 && err.status < 500) {
    return res.status(err.status).json({ error: err.message });
  }

  console.error(err);
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
}
