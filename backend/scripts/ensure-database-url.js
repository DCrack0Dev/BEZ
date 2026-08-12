/**
 * Fail fast before `prisma migrate deploy` if DATABASE_URL is missing.
 * Loads backend/.env for local runs; on Render the var comes from the dashboard.
 */
try {
  require('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), quiet: true });
} catch (_) {
  /* dotenv optional if already in env */
}

const url = (process.env.DATABASE_URL || '').trim();

if (!url) {
  console.error(`
FATAL: DATABASE_URL is not set.

Local: put DATABASE_URL in backend/.env
Render:
  1. Dashboard → PostgreSQL → create/open liquibot-db
  2. Connect → copy Internal Database URL into liquibot-back Environment
  3. Also set JWT_SECRET, EA_API_KEY, NODE_ENV=production
  4. Manual Deploy → Clear build cache & deploy
`);
  process.exit(1);
}

if (process.env.RENDER && /localhost|127\.0\.0\.1/i.test(url)) {
  console.error('FATAL: On Render, DATABASE_URL must be the Internal Database URL (not localhost).');
  process.exit(1);
}

console.log('DATABASE_URL present (' + url.replace(/:[^:@/]+@/, ':****@').slice(0, 72) + '…)');
