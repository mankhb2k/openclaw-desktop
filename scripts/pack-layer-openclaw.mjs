#!/usr/bin/env node
/**
 * pack-layer-openclaw.mjs
 *
 * Pack node_modules/openclaw/ → release/layer-openclaw-v{ver}.tar.gz
 *
 * Exclusions (mirror electron-builder.yml rules + RULE-02):
 *   MUST:  openclaw/docs/
 *   MAY:   openclaw/dist/extensions/*\/node_modules/  (đã hoist lên openclaw/node_modules/)
 *          **\/*.map, **\/*.d.ts
 *          **/test/, **/__tests__/, **/spec/
 *          README*, CHANGELOG*, examples/, demo/, benchmark/, fixtures/
 *          tsconfig*.json, .eslintrc*, .prettierrc*, jest.config*, .npmignore
 *
 * Output: release/layer-openclaw-v{ver}.tar.gz
 *         release/layer-openclaw-v{ver}.tar.gz.sha256
 *
 * Tar structure: entries start with node_modules/openclaw/
 * → extract to dataRoot/backend/ tạo ra dataRoot/backend/node_modules/openclaw/
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { create } from 'tar'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const NM = path.join(ROOT, 'node_modules')
const OPENCLAW_DIR = path.join(NM, 'openclaw')
const RELEASE_DIR = path.join(ROOT, 'release')

// ── Version ─────────────────────────────────────────────────────────────────
const rootPkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
// Strip semver range prefix (^, ~, >=, etc.)
const ocVersion = rootPkg.dependencies.openclaw.replace(/^[^0-9]*/, '')
const OUTPUT = path.join(RELEASE_DIR, `layer-openclaw-v${ocVersion}.tar.gz`)

// ── Sanity checks ────────────────────────────────────────────────────────────
if (!fs.existsSync(OPENCLAW_DIR)) {
  console.error(`[pack-openclaw] ERROR: ${OPENCLAW_DIR} not found. Run "npm install" first.`)
  process.exit(1)
}
if (!fs.existsSync(path.join(OPENCLAW_DIR, 'openclaw.mjs'))) {
  console.error(`[pack-openclaw] ERROR: openclaw.mjs not found inside ${OPENCLAW_DIR}.`)
  process.exit(1)
}

fs.mkdirSync(RELEASE_DIR, { recursive: true })

// ── Exclusion filter ─────────────────────────────────────────────────────────
// `p` is relative to ROOT (cwd), using forward slashes.
const EXT_NM_RE = /^node_modules\/openclaw\/dist\/extensions\/[^/]+\/node_modules(\/|$)/
const TEST_DIR_RE = /\/(test|tests|__tests__|spec|specs)(\/|$)/i
const META_FILE_RE = /^(README|CHANGELOG|CHANGES|HISTORY|NOTICE|AUTHORS|CONTRIBUTORS)(\.|$)/i
const JUNK_EXT_RE = /\.(flow|npmignore|eslintignore)$/i
const RC_FILE_RE = /^(\.|_)(eslintrc|prettierrc|babelrc)/i
const JUNK_DIR_RE = /\/(examples|demo|demos|benchmark|benchmarks|fixtures|sample|samples)(\/|$)/i

function shouldExclude(p) {
  const rel = p.replace(/\\/g, '/')

  // MUST: openclaw/docs/
  if (rel.startsWith('node_modules/openclaw/docs/') || rel === 'node_modules/openclaw/docs') return true

  // MAY: dist/extensions/*/node_modules/
  if (EXT_NM_RE.test(rel)) return true

  const base = path.posix.basename(rel)

  // Source maps and TypeScript declarations
  if (base.endsWith('.map') || base.endsWith('.d.ts')) return true

  // Test directories
  if (TEST_DIR_RE.test(rel)) return true

  // Documentation and meta files
  if (META_FILE_RE.test(base)) return true

  // Dev config and junk extensions
  if (JUNK_EXT_RE.test(base)) return true
  if (RC_FILE_RE.test(base)) return true
  if (/^jest\.config/.test(base)) return true
  if (/^tsconfig.*\.json$/.test(base)) return true

  // Example / demo / benchmark / fixture directories
  if (JUNK_DIR_RE.test(rel)) return true

  return false
}

// ── Pack ─────────────────────────────────────────────────────────────────────
console.log(`[pack-openclaw] openclaw@${ocVersion}`)
console.log(`[pack-openclaw] Source: node_modules/openclaw/`)
console.log(`[pack-openclaw] Output: ${path.relative(ROOT, OUTPUT)}`)
console.log(`[pack-openclaw] Packing... (this may take 1–3 minutes)`)

const startTime = Date.now()

await create(
  {
    gzip: { level: 6 },
    file: OUTPUT,
    cwd: ROOT,
    filter: (p) => !shouldExclude(p),
    portable: true,
  },
  ['node_modules/openclaw']
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

fs.writeFileSync(`${OUTPUT}.sha256`, `${sha256}  ${path.basename(OUTPUT)}\n`)

console.log(`[pack-openclaw] Done in ${elapsed}s`)
console.log(`[pack-openclaw] Size:   ${sizeMB} MB (${stats.size.toLocaleString()} bytes)`)
console.log(`[pack-openclaw] SHA256: ${sha256}`)
console.log(`[pack-openclaw] Sidecar: ${path.relative(ROOT, OUTPUT)}.sha256`)
