/**
 * Local Windows APK build (EAS --local is macOS/Linux only).
 * Uses expo prebuild + Gradle assembleRelease.
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const root = path.resolve(__dirname, '..');
const sdk =
  process.env.ANDROID_HOME ||
  process.env.ANDROID_SDK_ROOT ||
  path.join(os.homedir(), 'AppData', 'Local', 'Android', 'Sdk');
const javaHome =
  process.env.JAVA_HOME ||
  'C:\\Program Files\\Android\\Android Studio\\jbr';

process.env.ANDROID_HOME = sdk;
process.env.ANDROID_SDK_ROOT = sdk;
process.env.JAVA_HOME = javaHome;
process.env.EXPO_PUBLIC_API_URL =
  process.env.EXPO_PUBLIC_API_URL || 'https://liquibot-back.onrender.com';
process.env.PATH = [
  path.join(sdk, 'platform-tools'),
  path.join(javaHome, 'bin'),
  process.env.PATH || '',
].join(path.delimiter);

function run(cmd, args, cwd = root) {
  console.log(`\n> ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit', shell: true, env: process.env });
  if (r.status !== 0) process.exit(r.status || 1);
}

if (!fs.existsSync(sdk)) {
  console.error(`ANDROID_HOME not found: ${sdk}`);
  process.exit(1);
}

run('npx', ['expo', 'prebuild', '-p', 'android', '--clean', '--no-install']);
run(path.join(root, 'android', 'gradlew.bat'), ['assembleRelease', '--no-daemon'], path.join(root, 'android'));

const apkDir = path.join(root, 'android', 'app', 'build', 'outputs', 'apk');
function findApks(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    if (fs.statSync(p).isDirectory()) findApks(p, out);
    else if (name.endsWith('.apk')) out.push(p);
  }
  return out;
}

const apks = findApks(apkDir);
console.log('\n=== APK ready ===');
for (const p of apks) {
  const mb = (fs.statSync(p).size / (1024 * 1024)).toFixed(1);
  console.log(`${p} (${mb} MB)`);
}
if (!apks.length) {
  console.error('No APK found under android/app/build/outputs/apk');
  process.exit(1);
}
