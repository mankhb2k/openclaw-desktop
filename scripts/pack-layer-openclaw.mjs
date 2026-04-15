#!/usr/bin/env node
/**
 * pack-layer-openclaw.mjs
 *
 * Pack the openclaw package PLUS its full runtime dependency tree into one layer.
 *
 * Uses a recursive dep-walker starting from openclaw/package.json to collect
 * only the packages that openclaw actually needs at runtime (no dev-tool bleed).
 *
 * Exclusions inside openclaw/:
 *   MUST:  openclaw/docs/
 *   MAY:   openclaw/dist/extensions/<ext>/node_modules/  (already hoisted to openclaw/node_modules/)
 *          *.map, *.d.ts, test/, __tests__/, README*, CHANGELOG*, examples/, benchmark/
 *
 * Output: release/layer-openclaw-v{ver}.tar.gz
 *         release/layer-openclaw-v{ver}.tar.gz.sha256
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

// ── Version ─────────────────────────────────────────────────────────────────
const ocPkg = JSON.parse(fs.readFileSync(path.join(OPENCLAW_DIR, 'package.json'), 'utf8'))
const ocVersion = ocPkg.version
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

// ── Recursive dep walker ─────────────────────────────────────────────────────
/**
 * Given a package name, find its directory by walking up from a starting node_modules dir.
 * npm flattens deps to the highest possible level, so we look in:
 *   1. The immediate node_modules (peer context)
 *   2. Root node_modules (hoisted)
 */
function findPkgDir(pkgName, contextNm = NM) {
  // Check context node_modules first (nested resolution)
  const localPath = path.join(contextNm, pkgName)
  if (fs.existsSync(localPath) && fs.existsSync(path.join(localPath, 'package.json'))) {
    return localPath
  }
  // Fall back to root node_modules
  const rootPath = path.join(NM, pkgName)
  if (fs.existsSync(rootPath) && fs.existsSync(path.join(rootPath, 'package.json'))) {
    return rootPath
  }
  return null
}

/**
 * Collect all packages in openclaw's runtime dep tree.
 * Returns a Map<relPath, absPath> e.g. 'node_modules/tslog' → '/abs/path/to/tslog'
 */
const collected = new Map() // relPath → absPath
const queue = [] // {pkgName, contextNm}

// Seed with openclaw's direct deps
const ocDepsAll = { ...ocPkg.dependencies }
for (const dep of Object.keys(ocDepsAll)) {
  queue.push({ pkgName: dep, contextNm: OPENCLAW_DIR + '/node_modules' })
}

// Also include openclaw itself (handled separately in tar entries)
const OPENCLAW_REL = 'node_modules/openclaw'

while (queue.length > 0) {
  const { pkgName, contextNm } = queue.shift()

  // Find the package directory
  const pkgDir = findPkgDir(pkgName, contextNm)
  if (!pkgDir) {
    // Could be nested inside openclaw/node_modules (extension deps already hoisted)
    continue
  }

  // Compute relative path from ROOT
  const rel = path.relative(ROOT, pkgDir).replace(/\\/g, '/')
  if (collected.has(rel)) continue // already visited
  collected.set(rel, pkgDir)

  // Walk this package's production dependencies
  const pkgJsonPath = path.join(pkgDir, 'package.json')
  let pkg
  try {
    pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'))
  } catch {
    continue
  }

  const deps = pkg.dependencies || {}
  const peerDepsOptional = pkg.peerDependenciesMeta || {}
  const peerDeps = pkg.peerDependencies || {}

  for (const dep of Object.keys(deps)) {
    // Look in this package's own node_modules first, then root
    const nestedNm = path.join(pkgDir, 'node_modules')
    queue.push({ pkgName: dep, contextNm: nestedNm })
  }

  // Include non-optional peerDependencies
  for (const [dep, _ver] of Object.entries(peerDeps)) {
    const meta = peerDepsOptional[dep]
    if (meta?.optional) continue
    const nestedNm = path.join(pkgDir, 'node_modules')
    queue.push({ pkgName: dep, contextNm: nestedNm })
  }
}

// Convert to set of relPaths (all unique top-level node_modules entries we need to include)
// We want top-level paths only (node_modules/<pkg>), not nested node_modules inside packages
// (those are already included when we tar the package dir recursively)
const topLevelEntries = new Set([OPENCLAW_REL])
for (const rel of collected.keys()) {
  // Only include paths directly under root node_modules (not nested)
  if (rel.startsWith('node_modules/') && rel.split('/').length === 2) {
    topLevelEntries.add(rel)
  } else if (rel.startsWith('node_modules/@') && rel.split('/').length === 3) {
    // Scoped: node_modules/@scope/pkg
    topLevelEntries.add(rel)
  }
  // Nested node_modules (node_modules/foo/node_modules/bar) are included via the parent dir
}

console.log(`[pack-openclaw] openclaw@${ocVersion}`)
console.log(`[pack-openclaw] Dep tree: ${collected.size} packages resolved`)
console.log(`[pack-openclaw] Top-level entries to pack: ${topLevelEntries.size}`)
console.log(`[pack-openclaw] Output: ${path.relative(ROOT, OUTPUT)}`)
console.log(`[pack-openclaw] Packing... (this may take 1–5 minutes)`)

// ── Exclusion filter ─────────────────────────────────────────────────────────
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

  // MAY: dist/extensions/*/node_modules/ (already hoisted)
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

console.log(`[pack-openclaw] Done in ${elapsed}s`)
console.log(`[pack-openclaw] Size:   ${sizeMB} MB (${stats.size.toLocaleString()} bytes)`)
console.log(`[pack-openclaw] SHA256: ${sha256}`)
console.log(`[pack-openclaw] Sidecar: ${path.relative(ROOT, OUTPUT)}.sha256`)
