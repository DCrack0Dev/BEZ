/**
 * Cloud/native boot entry — validates required env BEFORE importing modules
 * that throw on missing DATABASE_URL, then starts the API.
 *
 * Render (native Node) runs: npm run start → this file.
 */
import 'dotenv/config';

function requireEnv(name: string): string {
  const v = process.env[name];
  if (v && v.trim()) return v.trim();
  const onRender = !!(process.env.RENDER || process.env.RENDER_SERVICE_ID);
  console.error(`\nFATAL: Missing required environment variable: ${name}`);
  if (onRender) {
    console.error(`
Render fix:
  1. Open https://dashboard.render.com → your Web Service (liquibot-back)
  2. Environment → Add Environment Variable
  3. Key: ${name}
  4. Value: Internal Database URL from your Render PostgreSQL
     (Dashboard → Postgres → Connect → Internal Database URL)
  5. Also set: JWT_SECRET, EA_API_KEY (same key as MT5 EA ApiKey input)
  6. Manual Deploy → Deploy latest commit
`);
  } else {
    console.error(`Set ${name} in backend/.env or your shell environment.\n`);
  }
  process.exit(1);
}

requireEnv('DATABASE_URL');
if (process.env.NODE_ENV === 'production') {
  requireEnv('JWT_SECRET');
  requireEnv('EA_API_KEY');
}

// Defer loading the app until env is confirmed
require('./main');
