/**
 * Prisma generates into src/generated/prisma. TypeScript compiles
 * dist/database/index.js with require("../generated/prisma"), which resolves
 * to dist/generated/prisma — copy the client there after tsc so Node can boot.
 */
const fs = require('fs');
const path = require('path');

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, ent.name);
    const to = path.join(dest, ent.name);
    if (ent.isDirectory()) copyDir(from, to);
    else fs.copyFileSync(from, to);
  }
}

const src = path.join(__dirname, '..', 'src', 'generated');
const dest = path.join(__dirname, '..', 'dist', 'generated');

if (!fs.existsSync(src)) {
  console.error('FATAL: src/generated missing — run `npx prisma generate` before build.');
  process.exit(1);
}

copyDir(src, dest);
console.log('Copied src/generated → dist/generated');
