#!/usr/bin/env node
/**
 * pack-layer-root-runtime.mjs
 *
 * Pack ROOT_ONLY packages → release/layer-root-runtime-v{N}.tar.gz
 *
 * Classification logic:
 *   NATIVE   = optionalDependencies in root package.json
 *              (pre-built Electron ABI binaries — bundled in EXE, never downloaded)
 *   WITH_OC  = root dependencies that also appear in openclaw/package.json
 *              (shipped as part of LAYER OPENCLAW, not here — RULE-04)
 *   ROOT_ONLY = root dependencies − openclaw − WITH_OC − NATIVE
 *              → này là LAYER ROOT-RUNTIME
 *
 * Version: auto-increment integer stored in release/root-runtime-version.txt
 *          Tăng mỗi khi có thay đổi nội dung (script sẽ hỏi xác nhận nếu muốn tăng)
 *          Pass --bump để tự động tăng version, mặc định dùng version hiện tại.
 *
 * Output: release/layer-root-runtime-v{N}.tar.gz
 *         release/layer-root-runtime-v{N}.tar.gz.sha256
 *         release/root-runtime-version.txt  (cập nhật nếu --bump)
 *
 * Tar structure: entries start with node_modules/<pkg>/
 * → extract to dataRoot/backend/ → dataRoot/backend/node_modules/<pkg>/
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { create } from 'tar'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const NM = path.join(ROOT, 'node_modules')
const RELEASE_DIR = path.join(ROOT, 'release')

const args = process.argv.slice(2)
const BUMP = args.includes('--bump')

// ── Load package manifests ───────────────────────────────────────────────────
const rootPkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))

const ocPkgPath = path.join(NM, 'openclaw', 'package.json')
if (!fs.existsSync(ocPkgPath)) {
  console.error(`[pack-root-runtime] ERROR: ${ocPkgPath} not found. Run "npm install" first.`)
  process.exit(1)
}
const ocPkg = JSON.parse(fs.readFileSync(ocPkgPath, 'utf8'))

// ── Package classification ───────────────────────────────────────────────────
const rootDeps = new Set(Object.keys(rootPkg.dependencies || {}))
const ocDeps = new Set(Object.keys(ocPkg.dependencies || {}))
const NATIVE = new Set(Object.keys(rootPkg.optionalDependencies || {}))

// WITH_OC: packages present in both root deps and openclaw deps
// Kể cả khi chúng là optional trong root (vd: playwright-core) — nếu openclaw có thì WITH_OC
const WITH_OC = new Set([...rootDeps, ...NATIVE].filter((p) => ocDeps.has(p)))

// ROOT_ONLY: root deps mà không phải openclaw, không phải WITH_OC, không phải NATIVE
const ROOT_ONLY = new Set(
  [...rootDeps].filter((p) => p !== 'openclaw' && !WITH_OC.has(p) && !NATIVE.has(p))
)

console.log(`[pack-root-runtime] Package classification:`)
console.log(`  Root deps:   ${rootDeps.size}`)
console.log(`  NATIVE:      ${NATIVE.size}  (bundled in EXE, skip)`)
console.log(`  WITH_OC:     ${WITH_OC.size}  (goes with OPENCLAW layer, skip)`)
console.log(`  ROOT_ONLY:   ${ROOT_ONLY.size}  (← these get packed)`)
console.log(`  openclaw:    1  (its own layer, skip)`)

// ── Resolve actual directories in node_modules ───────────────────────────────
const entries = []
const missing = []

for (const pkg of [...ROOT_ONLY].sort()) {
  // Handle scoped packages (@scope/name → node_modules/@scope/name)
  const pkgDir = path.join(NM, pkg)
  if (fs.existsSync(pkgDir)) {
    entries.push(path.posix.join('node_modules', pkg))
  } else {
    missing.push(pkg)
  }
}

if (missing.length > 0) {
  console.warn(`[pack-root-runtime] WARN: ${missing.length} package(s) not found in node_modules/:`)
  for (const p of missing) console.warn(`    ${p}`)
}

if (entries.length === 0) {
  console.error(`[pack-root-runtime] ERROR: No ROOT_ONLY packages found to pack.`)
  process.exit(1)
}

// ── Version management ───────────────────────────────────────────────────────
const versionFile = path.join(RELEASE_DIR, 'root-runtime-version.txt')
let version = 1
if (fs.existsSync(versionFile)) {
  version = parseInt(fs.readFileSync(versionFile, 'utf8').trim(), 10)
  if (BUMP) {
    version += 1
    console.log(`[pack-root-runtime] --bump: version ${version - 1} → ${version}`)
  } else {
    console.log(`[pack-root-runtime] Version: ${version} (pass --bump to increment)`)
  }
} else {
  console.log(`[pack-root-runtime] New version: ${version}`)
}

fs.mkdirSync(RELEASE_DIR, { recursive: true })

const OUTPUT = path.join(RELEASE_DIR, `layer-root-runtime-v${version}.tar.gz`)

// ── Exclusion filter ─────────────────────────────────────────────────────────
const TEST_DIR_RE = /\/(test|tests|__tests__|spec|specs)(\/|$)/i
const META_FILE_RE = /^(README|CHANGELOG|CHANGES|HISTORY|NOTICE|AUTHORS|CONTRIBUTORS)(\.|$)/i
const JUNK_EXT_RE = /\.(flow|npmignore|eslintignore)$/i
const RC_FILE_RE = /^(\.|_)(eslintrc|prettierrc|babelrc)/i
const JUNK_DIR_RE = /\/(examples|demo|demos|benchmark|benchmarks|fixtures|sample|samples)(\/|$)/i

function shouldExclude(p) {
  const rel = p.replace(/\\/g, '/')
  const base = path.posix.basename(rel)

  if (base.endsWith('.map') || base.endsWith('.d.ts')) return true
  if (TEST_DIR_RE.test(rel)) return true
  if (META_FILE_RE.test(base)) return true
  if (JUNK_EXT_RE.test(base)) return true
  if (RC_FILE_RE.test(base)) return true
  if (/^jest\.config/.test(base)) return true
  if (/^tsconfig.*\.json$/.test(base)) return true
  if (JUNK_DIR_RE.test(rel)) return true

  return false
}

// ── Pack ─────────────────────────────────────────────────────────────────────
console.log(`[pack-root-runtime] Packing ${entries.length} packages → layer-root-runtime-v${version}.tar.gz`)
console.log(`[pack-root-runtime] Packing... (may take ~30–60 seconds)`)

const startTime = Date.now()

await create(
  {
    gzip: { level: 6 },
    file: OUTPUT,
    cwd: ROOT,
    filter: (p) => !shouldExclude(p),
    portable: true,
  },
  entries
)

// ── SHA-256 ──────────────────────────────────────────────────────────────────
const hash = crypto.createHash('sha256')
await new Promise((resolve, reject) => {
  const s = fs.createReadStream(OUTPUT)
  s.on('data', (chunk) => hash.update(chunk))
  s.on('end', resolve)
  s.on('error', reject)
})
const sha256 = hash.digest('hex')

// ── Stats ────────────────────────────────────────────────────────────────────
const stats = fs.statSync(OUTPUT)
const sizeMB = (stats.size / 1024 / 1024).toFixed(1)
const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)

// Persist version only if bump was requested or first time
if (BUMP || !fs.existsSync(versionFile)) {
  fs.writeFileSync(versionFile, String(version))
}
fs.writeFileSync(`${OUTPUT}.sha256`, `${sha256}  ${path.basename(OUTPUT)}\n`)

console.log(`[pack-root-runtime] Done in ${elapsed}s`)
console.log(`[pack-root-runtime] Output: ${path.relative(ROOT, OUTPUT)}`)
console.log(`[pack-root-runtime] Size:   ${sizeMB} MB (${stats.size.toLocaleString()} bytes)`)
console.log(`[pack-root-runtime] SHA256: ${sha256}`)
console.log(`[pack-root-runtime] Version: ${version}`)

// ── Print ROOT_ONLY list for reference ───────────────────────────────────────
if (args.includes('--verbose') || args.includes('-v')) {
  console.log(`\n[pack-root-runtime] ROOT_ONLY packages packed:`)
  for (const e of entries) console.log(`    ${e}`)
}
if (missing.length > 0) {
  console.log(`\n[pack-root-runtime] Packages declared but missing from node_modules/:`)
  for (const p of missing) console.log(`    ${p}`)
}
