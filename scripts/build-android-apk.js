import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { syncAndroidAllowlist } from './sync-android-allowlist.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

console.log('🚀 Starting certified Android APK compilation for AKA PAY Observer...');

// Resolve Toolchain Paths dynamically across macOS, Linux, and Windows
const isWin = process.platform === 'win32';

function findBinary(name, winExt = '.exe', searchDirs = []) {
  const binaryName = isWin ? `${name}${winExt}` : name;
  for (const dir of searchDirs) {
    if (!dir) continue;
    const full = path.join(dir, binaryName);
    if (fs.existsSync(full)) return full;
  }
  return binaryName;
}

const ANDROID_HOME = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || (
  isWin
    ? path.join(process.env.LOCALAPPDATA || 'C:\\', 'Android', 'Sdk')
    : path.join(process.env.HOME || '/', 'Library', 'Android', 'sdk')
);

// Find latest build tools version dynamically
const buildToolsBase = path.join(ANDROID_HOME, 'build-tools');
let buildToolsDir = '';
if (fs.existsSync(buildToolsBase)) {
  const versions = fs.readdirSync(buildToolsBase).sort().reverse();
  if (versions.length > 0) {
    buildToolsDir = path.join(buildToolsBase, versions[0]);
  }
}

// Find latest android.jar dynamically
const platformsBase = path.join(ANDROID_HOME, 'platforms');
let androidJar = '';
if (fs.existsSync(platformsBase)) {
  const platforms = fs.readdirSync(platformsBase).sort().reverse();
  for (const plat of platforms) {
    const candidate = path.join(platformsBase, plat, 'android.jar');
    if (fs.existsSync(candidate)) {
      androidJar = candidate;
      break;
    }
  }
}

const javaSearchDirs = [
  process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, 'bin') : '',
  'C:\\Program Files\\Java\\jdk-23\\bin',
  'C:\\Program Files\\Android\\Android Studio\\jbr\\bin'
];

const JAVAC = findBinary('javac', '.exe', javaSearchDirs);
const D8 = findBinary('d8', '.bat', [buildToolsDir]);
const AAPT = findBinary('aapt', '.exe', [buildToolsDir]);
const ZIPALIGN = findBinary('zipalign', '.exe', [buildToolsDir]);
const APKSIGNER = findBinary('apksigner', '.bat', [buildToolsDir]);
const ANDROID_JAR = androidJar;

console.log('ℹ️  Toolchain:');
console.log(`   Android SDK: ${ANDROID_HOME}`);
console.log(`   Build Tools: ${buildToolsDir}`);
console.log(`   Android JAR: ${ANDROID_JAR}`);
console.log(`   javac:       ${JAVAC}`);
console.log(`   d8:          ${D8}`);
console.log(`   aapt:        ${AAPT}`);
console.log(`   zipalign:    ${ZIPALIGN}`);
console.log(`   apksigner:   ${APKSIGNER}`);

const APP_DIR = path.resolve(REPO_ROOT, 'apps/android-observer-app');
const APP_SRC = path.resolve(APP_DIR, 'app/src/main');
const JAVA_DIR = path.resolve(APP_SRC, 'java/com/akapay/observer');
const RES_DIR = path.resolve(APP_SRC, 'res');
const MANIFEST = path.resolve(APP_SRC, 'AndroidManifest.xml');
const WORK_DIR = path.resolve(REPO_ROOT, '.tmp_apk_build');
const BIN_DIR = path.resolve(WORK_DIR, 'bin');
const LIB_DIR = path.resolve(APP_DIR, 'app/libs');

// Cleanup old working directory
if (fs.existsSync(WORK_DIR)) {
  fs.rmSync(WORK_DIR, { recursive: true, force: true });
}
fs.mkdirSync(BIN_DIR, { recursive: true });

async function build() {
  // 0. Synchronize banking allowlist
  console.log('🔄 [0/6] Synchronizing Android banking package allowlist from @akapay/common...');
  syncAndroidAllowlist();

  // Collect Java sources and external library jars
  const javaSources = fs.readdirSync(JAVA_DIR)
    .filter((f) => f.endsWith('.java'))
    .map((f) => path.join(JAVA_DIR, f));

  const libJars = fs.existsSync(LIB_DIR)
    ? fs.readdirSync(LIB_DIR).filter((f) => f.endsWith('.jar')).map((f) => path.join(LIB_DIR, f))
    : [];

  // 1. Compile Java Sources to .class files
  console.log('📦 [1/6] Compiling Java source files with javac...');
  const cpSeparator = isWin ? ';' : ':';
  const classpath = [ANDROID_JAR, ...libJars].join(cpSeparator);

  const javacCmd = `"${JAVAC}" -encoding UTF-8 -cp "${classpath}" -d "${BIN_DIR}" ${javaSources.map((s) => `"${s}"`).join(' ')}`;
  execSync(javacCmd, { stdio: 'inherit' });
  console.log('   ✅ Java compilation succeeded.');

  // 2. Convert .class files + library JARs to Dalvik Executable (classes.dex)
  console.log('⚡ [2/6] Converting Java bytecode to Dalvik Executable (classes.dex) with D8...');
  const classFiles = [];
  function collectClasses(dir) {
    for (const file of fs.readdirSync(dir)) {
      const p = path.join(dir, file);
      if (fs.statSync(p).isDirectory()) {
        collectClasses(p);
      } else if (p.endsWith('.class')) {
        classFiles.push(p);
      }
    }
  }
  collectClasses(BIN_DIR);

  // Write all input class paths into an argfile (@args.txt) so D8 reads raw paths without shell expansion of '$'
  const d8ArgFile = path.join(WORK_DIR, 'd8_inputs.txt');
  fs.writeFileSync(d8ArgFile, [...classFiles, ...libJars].join('\n'), 'utf8');

  if (isWin) {
    execFileSync('cmd.exe', ['/c', D8, '--lib', ANDROID_JAR, '--output', WORK_DIR, `@${d8ArgFile}`], { stdio: 'inherit' });
  } else {
    execFileSync(D8, ['--lib', ANDROID_JAR, '--output', WORK_DIR, `@${d8ArgFile}`], { stdio: 'inherit' });
  }

  const dexPath = path.join(WORK_DIR, 'classes.dex');
  if (!fs.existsSync(dexPath)) {
    throw new Error('D8 failed to generate classes.dex');
  }
  console.log(`   ✅ Dalvik classes.dex created (${fs.statSync(dexPath).size} bytes).`);

  // 3. Package Resources and compiled binary AndroidManifest.xml into initial APK with AAPT
  console.log('📜 [3/6] Packaging resources & compiled binary AndroidManifest with AAPT...');
  const unalignedApk = path.join(WORK_DIR, 'unaligned.apk');
  execSync(`"${AAPT}" package -f -M "${MANIFEST}" -S "${RES_DIR}" -I "${ANDROID_JAR}" -F "${unalignedApk}"`, {
    stdio: 'inherit'
  });

  // Add classes.dex into unaligned APK
  process.chdir(WORK_DIR);
  execSync(`"${AAPT}" add -v "${unalignedApk}" classes.dex`, {
    stdio: 'pipe'
  });
  console.log('   ✅ Base APK packaged with classes.dex and compiled binary manifest.');

  // 4. Align 4-byte boundaries using zipalign
  console.log('📐 [4/6] 4-byte boundary zip-aligning APK...');
  const alignedApk = path.join(WORK_DIR, 'aligned.apk');
  execSync(`"${ZIPALIGN}" -f 4 "${unalignedApk}" "${alignedApk}"`, {
    stdio: 'inherit'
  });
  console.log('   ✅ APK successfully zip-aligned.');

  // 5. Generate self-signed RSA keystore and sign APK with apksigner (v1, v2, v3 scheme)
  console.log('✍️  [5/6] Generating developer certificate and signing APK with apksigner...');
  const keystorePath = path.join(WORK_DIR, 'release.keystore');
  const KEY_ALIAS = 'akapay';
  const KEY_PASS = 'akapay123456';

  const keytool = findBinary('keytool', '.exe', javaSearchDirs);
  execSync(
    `"${keytool}" -genkeypair -v -keystore "${keystorePath}" -alias "${KEY_ALIAS}" -keyalg RSA -keysize 2048 -validity 10000 -storepass "${KEY_PASS}" -keypass "${KEY_PASS}" -dname "CN=AKA PAY Observer, OU=Core Payments, O=AKA PAY, L=Hyderabad, ST=Telangana, C=IN"`,
    { stdio: 'pipe' }
  );

  const signedApk = path.join(WORK_DIR, 'akapay-observer.apk');
  if (isWin) {
    execFileSync('cmd.exe', [
      '/c',
      APKSIGNER,
      'sign',
      '--ks', keystorePath,
      '--ks-key-alias', KEY_ALIAS,
      '--ks-pass', `pass:${KEY_PASS}`,
      '--key-pass', `pass:${KEY_PASS}`,
      '--out', signedApk,
      alignedApk
    ], { stdio: 'inherit' });
  } else {
    execFileSync(APKSIGNER, [
      'sign',
      '--ks', keystorePath,
      '--ks-key-alias', KEY_ALIAS,
      '--ks-pass', `pass:${KEY_PASS}`,
      '--key-pass', `pass:${KEY_PASS}`,
      '--out', signedApk,
      alignedApk
    ], { stdio: 'inherit' });
  }

  // Verify APK signature
  if (isWin) {
    execFileSync('cmd.exe', ['/c', APKSIGNER, 'verify', '--verbose', signedApk], { stdio: 'pipe' });
  } else {
    execFileSync(APKSIGNER, ['verify', '--verbose', signedApk], { stdio: 'pipe' });
  }
  console.log('   ✅ APK cryptographically signed & verified (v1, v2, v3 schemes active).');

  // 6. Compute SHA-256 and distribute to certified locations
  console.log('📋 [6/6] Computing SHA-256 fingerprint & deploying certified release binaries...');
  const apkBytes = fs.readFileSync(signedApk);
  const sha256 = crypto.createHash('sha256').update(apkBytes).digest('hex');

  const targets = [
    path.resolve(REPO_ROOT, 'apps/android-observer-app/akapay-observer.apk'),
    path.resolve(REPO_ROOT, 'apps/payment-api/public/akapay-observer.apk'),
    path.resolve(REPO_ROOT, 'apps/merchant-admin/public/akapay-observer.apk')
  ];

  for (const t of targets) {
    const dir = path.dirname(t);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(signedApk, t);
    fs.writeFileSync(`${t}.sha256`, `${sha256}  akapay-observer.apk\n`, 'utf8');
    console.log(`   👉 Deployed to ${path.relative(REPO_ROOT, t)}`);
  }

  // Cleanup
  process.chdir(REPO_ROOT);
  fs.rmSync(WORK_DIR, { recursive: true, force: true });

  console.log('\n🎉 AKA PAY Android Observer APK compilation completed successfully!');
  console.log(`📦 Size:    ${(apkBytes.length / 1024).toFixed(1)} KB`);
  console.log(`🔑 SHA-256: ${sha256}`);
}

build().catch((err) => {
  console.error('\n❌ Compilation failed:', err);
  process.exit(1);
});
