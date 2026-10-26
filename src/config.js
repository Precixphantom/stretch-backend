// Reads and checks environment variables once, at startup.

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing environment variable ${name}. Copy .env.example to .env and fill it in.`);
  }
  return value;
}

function list(value) {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

export const config = {
  port: Number(process.env.PORT) || 4000,
  databaseUrl: required('DATABASE_URL'),
  /** OAuth web client id(s) from Google Cloud Console. ID tokens must be issued to one of these. */
  googleClientIds: list(required('GOOGLE_CLIENT_ID')),
  jwtSecret: required('JWT_SECRET'),
  jwtExpiresIn: process.env.JWT_EXPIRES_IN?.trim() || '7d',
  /** Frontend origins allowed to call the API. */
  corsOrigins: list(process.env.CORS_ORIGIN || 'http://localhost:3000'),
  /** Decides what "today" is when validating dates. Stretch's users are in Nigeria. */
  timeZone: process.env.APP_TIMEZONE?.trim() || 'Africa/Lagos',
};

if (config.jwtSecret.length < 32) {
  throw new Error('JWT_SECRET must be at least 32 characters long.');
}
