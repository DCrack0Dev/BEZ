/**
 * Fail fast before `prisma migrate deploy` if DATABASE_URL is missing.
 * Render does not ship a .env file — the var must be set in the dashboard.
 */
const url = (process.env.DATABASE_URL || '').trim();

if (!url) {
  console.error(`
FATAL: DATABASE_URL is not set.

Render fix:
  1. Dashboard → PostgreSQL → create/open liquibot-db
  2. Connect → copy "Internal Database URL"
  3. Web Service liquibot-back → Environment → Add:
       DATABASE_URL = <Internal Database URL>
       JWT_SECRET   = <openssl rand -hex 32>
       EA_API_KEY   = <same as MT5 EA ApiKey>
       NODE_ENV     = production
  4. Manual Deploy → Clear build cache & deploy

Do NOT use localhost. The URL must contain .render.com
`);
  process.exit(1);
}

if (/localhost|127\.0\.0\.1/i.test(url)) {
  console.error('FATAL: DATABASE_URL points at localhost — Render needs the Internal Database URL.');
  process.exit(1);
}

console.log('DATABASE_URL present (' + url.replace(/:[^:@/]+@/, ':****@').slice(0, 64) + '…)');
