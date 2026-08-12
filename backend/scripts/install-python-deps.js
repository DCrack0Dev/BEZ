/**
 * Install Python deps for train/backtest on Render (native Node runtime).
 * Safe no-op locally if python/pip is missing — Node API still boots.
 */
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const root = path.join(__dirname, '..');
const reqFile = path.join(root, 'python', 'requirements-cloud.txt');

function whichPython() {
  const candidates = [
    process.env.PYTHON_PATH,
    'python3',
    'python',
  ].filter(Boolean);

  for (const bin of candidates) {
    const r = spawnSync(bin, ['--version'], { encoding: 'utf8' });
    if (r.status === 0) return bin;
  }
  return null;
}

if (!fs.existsSync(reqFile)) {
  console.warn('[python-deps] requirements-cloud.txt missing — skip');
  process.exit(0);
}

const py = whichPython();
if (!py) {
  console.warn('[python-deps] No python3/python found — skip (train/backtest will fail until installed)');
  process.exit(0);
}

console.log(`[python-deps] Using ${py}`);
console.log(`[python-deps] Installing from ${reqFile}`);

const pip = spawnSync(
  py,
  ['-m', 'pip', 'install', '--upgrade', 'pip', 'setuptools', 'wheel'],
  { cwd: root, stdio: 'inherit', env: process.env }
);
if (pip.status !== 0) {
  console.error('[python-deps] pip bootstrap failed');
  process.exit(pip.status || 1);
}

const install = spawnSync(
  py,
  ['-m', 'pip', 'install', '-r', reqFile],
  { cwd: root, stdio: 'inherit', env: process.env }
);
if (install.status !== 0) {
  console.error('[python-deps] pip install failed — train/backtest will not work');
  // Fail the Render build so we notice missing numpy instead of runtime ModuleNotFoundError
  process.exit(install.status || 1);
}

const check = spawnSync(py, ['-c', 'import numpy, torch; print("numpy", numpy.__version__, "torch", torch.__version__)'], {
  cwd: root,
  encoding: 'utf8',
});
if (check.status !== 0) {
  console.error('[python-deps] import check failed:\n', check.stderr || check.stdout);
  process.exit(1);
}
console.log('[python-deps] OK:', (check.stdout || '').trim());
process.exit(0);