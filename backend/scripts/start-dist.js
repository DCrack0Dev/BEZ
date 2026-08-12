/**
 * Start compiled backend. If dist is missing (stale Render build settings),
 * rebuild once before requiring boot.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const boot = path.join(__dirname, '..', 'dist', 'boot.js');
const generated = path.join(__dirname, '..', 'dist', 'generated', 'prisma');

function rebuild() {
  console.log('[start-dist] dist missing or incomplete — running npm run build…');
  const r = spawnSync('npm', ['run', 'build'], {
    cwd: path.join(__dirname, '..'),
    stdio: 'inherit',
    shell: true,
  });
  if (r.status !== 0) {
    console.error('[start-dist] build failed — cannot start');
    process.exit(r.status || 1);
  }
}

if (!fs.existsSync(boot) || !fs.existsSync(generated)) {
  rebuild();
}

if (!fs.existsSync(boot)) {
  console.error('FATAL: dist/boot.js still missing after build');
  process.exit(1);
}

require(boot);
