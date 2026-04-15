#!/usr/bin/env node
/**
 * pack-layer-backend.mjs
 *
 * Pack toàn bộ backend runtime vào 1 file tar.gz duy nhất.
 *
 * Bao gồm:
 *   1. node_modules/openclaw/   — openclaw + nested node_modules (hoisted ext deps)
 *   2. Tất cả transitive deps của openclaw tại root node_modules/
 *   3. ROOT_ONLY packages: root package.json deps không phải openclaw, không phải native
 *
 * Exclusions:
 *   - *.map, *.d.ts                     (type/source files, không cần runtime)
 *   - openclaw/docs/                     (docs)
 *   - test/, __tests__/, spec/          (test files)
 *   - README*, CHANGELOG*, NOTICE*      (doc files, chỉ exclude khi không có .js/.mjs ext)
 *   - examples/, demo/, benchmark/      (junk dirs)
 *
 * Output: release/layer-backend-v{version}.tar.gz
 *         release/layer-backend-v{version}.tar.gz.sha256
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
const OPENCLAW_DIR = path.join(NM, 'openclaw')
const RELEASE_DIR = path.join(ROOT, 'release')

// ── Sanity checks ────────────────────────────────────────────────────────────
if (!fs.existsSync(OPENCLAW_DIR)) {
  console.error(`[pack-backend] ERROR: ${OPENCLAW_DIR} not found. Run "npm install" first.`)
  process.exit(1)
}

const ocPkg = JSON.parse(fs.readFileSync(path.join(OPENCLAW_DIR, 'package.json'), 'utf8'))
const ocVersion = ocPkg.version
const OUTPUT = path.join(RELEASE_DIR, `layer-backend-v${ocVersion}.tar.gz`)

fs.mkdirSync(RELEASE_DIR, { recursive: true })

// ── Recursive dep walker ─────────────────────────────────────────────────────
function findPkgDir(pkgName, contextNm = NM) {
  const localPath = path.join(contextNm, pkgName)
  if (fs.existsSync(localPath) && fs.existsSync(path.join(localPath, 'package.json'))) {
    return localPath
  }
  const rootPath = path.join(NM, pkgName)
  if (fs.existsSync(rootPath) && fs.existsSync(path.join(rootPath, 'package.json'))) {
    return rootPath
  }
  return null
}

const collected = new Map() // relPath → absPath
const queue = []

// Seed with openclaw's direct deps
for (const dep of Object.keys(ocPkg.dependencies || {})) {
  queue.push({ pkgName: dep, contextNm: path.join(OPENCLAW_DIR, 'node_modules') })
}

while (queue.length > 0) {
  const { pkgName, contextNm } = queue.shift()
  const pkgDir = findPkgDir(pkgName, contextNm)
  if (!pkgDir) continue

  const rel = path.relative(ROOT, pkgDir).replace(/\\/g, '/')
  if (collected.has(rel)) continue
  collected.set(rel, pkgDir)

  let pkg
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'))
  } catch { continue }

  for (const dep of Object.keys(pkg.dependencies || {})) {
    queue.push({ pkgName: dep, contextNm: path.join(pkgDir, 'node_modules') })
  }

  // Include non-optional peerDependencies
  const peerDeps = pkg.peerDependencies || {}
  const peerMeta = pkg.peerDependenciesMeta || {}
  for (const [dep] of Object.entries(peerDeps)) {
    if (peerMeta[dep]?.optional) continue
    queue.push({ pkgName: dep, contextNm: path.join(pkgDir, 'node_modules') })
  }
}

// ── ROOT_ONLY packages (from root package.json, not in openclaw's dep tree) ──
const rootPkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const rootDeps = Object.keys(rootPkg.dependencies || {})
const ocDepNames = new Set(Object.keys(ocPkg.dependencies || {}))

// ROOT_ONLY = root deps that are NOT 'openclaw', NOT already in openclaw's dep tree
const rootOnly = rootDeps.filter((p) => {
  if (p === 'openclaw') return false
  if (ocDepNames.has(p)) return false // WITH_OC: already in openclaw layer
  return true
})

console.log(`[pack-backend] openclaw@${ocVersion}`)
console.log(`[pack-backend] Dep tree (openclaw deps): ${collected.size} packages`)
console.log(`[pack-backend] ROOT_ONLY packages: ${rootOnly.join(', ')}`)

// ── Top-level entries ────────────────────────────────────────────────────────
const topLevelEntries = new Set()

// 1. openclaw itself (includes openclaw/node_modules/ with hoisted ext deps)
topLevelEntries.add('node_modules/openclaw')

// 2. Openclaw's transitive deps at root node_modules/
for (const rel of collected.keys()) {
  if (rel.startsWith('node_modules/') && rel.split('/').length === 2) {
    topLevelEntries.add(rel) // node_modules/pkg
  } else if (rel.startsWith('node_modules/@') && rel.split('/').length === 3) {
    topLevelEntries.add(rel) // node_modules/@scope/pkg
  }
  // Packages inside openclaw/node_modules/ are included via 'node_modules/openclaw'
}

// 3. ROOT_ONLY packages
for (const pkg of rootOnly) {
  const pkgPath = path.join(NM, pkg)
  if (fs.existsSync(pkgPath)) {
    topLevelEntries.add(`node_modules/${pkg}`)
  } else {
    console.warn(`[pack-backend] WARN: ROOT_ONLY "${pkg}" not found in node_modules/`)
  }
}

console.log(`[pack-backend] Top-level entries to pack: ${topLevelEntries.size}`)
console.log(`[pack-backend] Output: ${path.relative(ROOT, OUTPUT)}`)
console.log(`[pack-backend] Packing... (this may take 1–5 minutes)`)

// ── Exclusion filter ─────────────────────────────────────────────────────────
const EXT_NM_RE = /^node_modules\/openclaw\/dist\/extensions\/[^/]+\/node_modules(\/|$)/
const TEST_DIR_RE = /\/(test|tests|__tests__|spec|specs)(\/|$)/i
// Only exclude doc files (no ext, .md, .txt, .rst) — NOT .js/.mjs/.cjs source files
const META_FILE_RE = /^(README|CHANGELOG|CHANGES|HISTORY|NOTICE|AUTHORS|CONTRIBUTORS)(\.(md|txt|rst|markdown|adoc|asciidoc)|$)/i
const JUNK_EXT_RE = /\.(flow|npmignore|eslintignore)$/i
const RC_FILE_RE = /^(\.|_)(eslintrc|prettierrc|babelrc)/i
const JUNK_DIR_RE = /\/(examples|demo|demos|benchmark|benchmarks|fixtures|sample|samples)(\/|$)/i

function shouldExclude(p) {
  const rel = p.replace(/\\/g, '/')

  if (rel.startsWith('node_modules/openclaw/docs/') || rel === 'node_modules/openclaw/docs') return true
  if (EXT_NM_RE.test(rel)) return true

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
const startTime = Date.now()

await create(
  {
    gzip: { level: 6 },
    file: OUTPUT,
    cwd: ROOT,
    filter: (p) => !shouldExclude(p),
    portable: true,
  },
  [...topLevelEntries]
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

console.log(`[pack-backend] Done in ${elapsed}s`)
console.log(`[pack-backend] Size:   ${sizeMB} MB (${stats.size.toLocaleString()} bytes)`)
console.log(`[pack-backend] SHA256: ${sha256}`)
console.log(`[pack-backend] Sidecar: ${path.relative(ROOT, OUTPUT)}.sha256`)
