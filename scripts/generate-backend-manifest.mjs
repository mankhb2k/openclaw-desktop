#!/usr/bin/env node
/**
 * generate-backend-manifest.mjs
 *
 * Tạo hoặc cập nhật release/backend-manifest.json theo schema mục 8 (layer-analysis.md).
 *
 * Usage:
 *   node scripts/generate-backend-manifest.mjs                   # update cả 2 layers
 *   node scripts/generate-backend-manifest.mjs --openclaw-only   # chỉ update openclaw layer
 *   node scripts/generate-backend-manifest.mjs --root-only       # chỉ update root-runtime layer
 *   node scripts/generate-backend-manifest.mjs --all             # update tất cả (default)
 *   node scripts/generate-backend-manifest.mjs --electron-version=36.0.0  # override electron version
 *   node scripts/generate-backend-manifest.mjs --release-tag=v1.2.0       # override release tag
 *
 * Requires:
 *   - release/layer-openclaw-v{ver}.tar.gz        (từ pack-layer-openclaw.mjs)
 *   - release/layer-root-runtime-v{N}.tar.gz      (từ pack-layer-root-runtime.mjs)
 *   - release/root-runtime-version.txt            (tạo bởi pack-layer-root-runtime.mjs)
 *
 * Output: release/backend-manifest.json
 *
 * Schema (schemaVersion: 2):
 * {
 *   schemaVersion, generatedAt, electronVersion, platform, arch,
 *   layers: {
 *     "root-runtime": { version, sha256, url, compressedBytes, uncompressedBytes,
 *                        extractTo, requiresHoist, changedFrom },
 *     "openclaw":     { version, sha256, url, compressedBytes, uncompressedBytes,
 *                        extractTo, requiresHoist, hoistScript, changedFrom }
 *   },
 *   extractOrder, minAppVersion, releaseNotes
 * }
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const RELEASE_DIR = path.join(ROOT, 'release')
const MANIFEST_PATH = path.join(RELEASE_DIR, 'backend-manifest.json')

// ── Parse CLI args ────────────────────────────────────────────────────────────
const args = process.argv.slice(2)
const onlyOpenclaw = args.includes('--openclaw-only')
const onlyRoot = args.includes('--root-only')
// Default: update all
const updateAll = !onlyOpenclaw && !onlyRoot

const electronVersionArg = args.find((a) => a.startsWith('--electron-version='))?.split('=')[1]
const releaseTagArg = args.find((a) => a.startsWith('--release-tag='))?.split('=')[1]

// ── Load package.json ─────────────────────────────────────────────────────────
const rootPkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))

const ocVersion = rootPkg.dependencies.openclaw.replace(/^[^0-9]*/, '')
const appVersion = rootPkg.version
const electronVersion =
  electronVersionArg ||
  (rootPkg.devDependencies?.electron || '35.7.5').replace(/^[^0-9]*/, '')

// ── Release info ──────────────────────────────────────────────────────────────
// GitHub releases base URL (từ electron-builder.yml: owner=Mankhb2k, repo=openclaw-desktop)
const ghOwner = 'Mankhb2k'
const ghRepo = 'openclaw-desktop'
const releaseTag = releaseTagArg || `v${appVersion}`
const baseUrl = `https://github.com/${ghOwner}/${ghRepo}/releases/download/${releaseTag}`

// ── Root-runtime version ──────────────────────────────────────────────────────
const versionFile = path.join(RELEASE_DIR, 'root-runtime-version.txt')
const rootRuntimeVersion = fs.existsSync(versionFile)
  ? fs.readFileSync(versionFile, 'utf8').trim()
  : '1'

// ── File paths ────────────────────────────────────────────────────────────────
const rootRuntimeTar = path.join(RELEASE_DIR, `layer-root-runtime-v${rootRuntimeVersion}.tar.gz`)
const openclawTar = path.join(RELEASE_DIR, `layer-openclaw-v${ocVersion}.tar.gz`)

// ── Helpers ───────────────────────────────────────────────────────────────────
function sha256OfFile(filePath) {
  if (!fs.existsSync(filePath)) return null
  const h = crypto.createHash('sha256')
  h.update(fs.readFileSync(filePath))
  return h.digest('hex')
}

function compressedBytes(filePath) {
  return fs.existsSync(filePath) ? fs.statSync(filePath).size : 0
}

// Read sidecar .sha256 file if available (faster than hashing entire tar.gz again)
function sha256FromSidecar(filePath) {
  const sidecar = `${filePath}.sha256`
  if (fs.existsSync(sidecar)) {
    const line = fs.readFileSync(sidecar, 'utf8').trim()
    // Format: "<sha256>  <filename>"
    return line.split(/\s+/)[0] || null
  }
  return null
}

function getSha256(filePath) {
  return sha256FromSidecar(filePath) ?? sha256OfFile(filePath)
}

// ── Load existing manifest (để giữ changedFrom / releaseNotes) ────────────────
let existing = {}
if (fs.existsSync(MANIFEST_PATH)) {
  existing = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'))
}

// ── Build layer objects ────────────────────────────────────────────────────────
const prevRootVersion = existing.layers?.['root-runtime']?.version ?? null
const prevOcVersion = existing.layers?.openclaw?.version ?? null

const rootRuntimeLayer = {
  version: rootRuntimeVersion,
  sha256: getSha256(rootRuntimeTar) ?? existing.layers?.['root-runtime']?.sha256 ?? '',
  url: `${baseUrl}/layer-root-runtime-v${rootRuntimeVersion}.tar.gz`,
  compressedBytes: compressedBytes(rootRuntimeTar) || existing.layers?.['root-runtime']?.compressedBytes || 0,
  // uncompressedBytes không thể biết mà không extract — giữ từ existing hoặc 0
  uncompressedBytes: existing.layers?.['root-runtime']?.uncompressedBytes || 0,
  extractTo: 'node_modules',
  requiresHoist: false,
  changedFrom: prevRootVersion !== rootRuntimeVersion ? prevRootVersion : null,
}

const openclawLayer = {
  version: ocVersion,
  sha256: getSha256(openclawTar) ?? existing.layers?.openclaw?.sha256 ?? '',
  url: `${baseUrl}/layer-openclaw-v${ocVersion}.tar.gz`,
  compressedBytes: compressedBytes(openclawTar) || existing.layers?.openclaw?.compressedBytes || 0,
  uncompressedBytes: existing.layers?.openclaw?.uncompressedBytes || 0,
  extractTo: 'node_modules',
  requiresHoist: true,
  hoistScript: 'scripts/hoist-openclaw-ext-deps.mjs',
  changedFrom: prevOcVersion !== ocVersion ? prevOcVersion : null,
}

// ── Assemble manifest ─────────────────────────────────────────────────────────
const manifest = {
  schemaVersion: 2,
  generatedAt: new Date().toISOString(),
  electronVersion,
  platform: 'win32',
  arch: 'x64',
  layers: {
    'root-runtime': onlyOpenclaw ? (existing.layers?.['root-runtime'] ?? rootRuntimeLayer) : rootRuntimeLayer,
    openclaw: onlyRoot ? (existing.layers?.openclaw ?? openclawLayer) : openclawLayer,
  },
  extractOrder: ['root-runtime', 'openclaw'],
  minAppVersion: appVersion,
  releaseNotes: existing.releaseNotes ?? {
    vi: `Cập nhật openclaw lên ${ocVersion}`,
    en: `Update openclaw to ${ocVersion}`,
  },
}

// ── Write ─────────────────────────────────────────────────────────────────────
fs.mkdirSync(RELEASE_DIR, { recursive: true })
fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n')

// ── Report ────────────────────────────────────────────────────────────────────
console.log(`[generate-manifest] Written: ${path.relative(ROOT, MANIFEST_PATH)}`)
console.log(`[generate-manifest] Release tag:    ${releaseTag}`)
console.log(`[generate-manifest] Electron:       ${electronVersion}`)
console.log(`[generate-manifest] openclaw layer: v${ocVersion}  sha256: ${manifest.layers.openclaw.sha256 ? manifest.layers.openclaw.sha256.slice(0, 16) + '…' : '(missing)'}`)
console.log(`[generate-manifest] root-runtime:   v${rootRuntimeVersion}  sha256: ${manifest.layers['root-runtime'].sha256 ? manifest.layers['root-runtime'].sha256.slice(0, 16) + '…' : '(missing)'}`)

// Warn on missing sha256 / files
const warns = []
if (!manifest.layers.openclaw.sha256) {
  warns.push(`openclaw tar.gz not found at: ${path.relative(ROOT, openclawTar)}`)
  warns.push(`  → Run: npm run layer:pack-openclaw`)
}
if (!manifest.layers['root-runtime'].sha256) {
  warns.push(`root-runtime tar.gz not found at: ${path.relative(ROOT, rootRuntimeTar)}`)
  warns.push(`  → Run: npm run layer:pack-root`)
}
if (warns.length > 0) {
  console.warn(`\n[generate-manifest] WARN: sha256 fields are empty — upload will be incomplete.`)
  for (const w of warns) console.warn(`  ${w}`)
}
