#!/usr/bin/env node
/**
 * install-layers-local.mjs
 *
 * DEV TOOL — Extract 2 layers trực tiếp vào userData/backend/ để test split mode
 * mà KHÔNG cần upload lên GitHub hoặc download.
 *
 * Dùng khi: muốn test nhanh split mode trên máy local trước khi release.
 *
 * Usage:
 *   node scripts/install-layers-local.mjs
 *   node scripts/install-layers-local.mjs --data-root="C:\custom\path"
 *   node scripts/install-layers-local.mjs --dry-run   (chỉ in paths, không extract)
 *
 * Default userData (Windows packaged):  %APPDATA%\OpenClaw
 * Default userData (dev mode):          .openclaw-desktop-data/
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { extract } from 'tar'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const RELEASE_DIR = path.join(ROOT, 'release')

const args = process.argv.slice(2)
const DRY_RUN = args.includes('--dry-run')
const dataRootArg = args.find((a) => a.startsWith('--data-root='))?.split('=').slice(1).join('=')

// ── Resolve dataRoot ──────────────────────────────────────────────────────────
function resolveDataRoot() {
  if (dataRootArg) return path.resolve(dataRootArg)
  // Windows: %APPDATA%\OpenClaw (packaged app userData)
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA
    if (appData) return path.join(appData, 'OpenClaw')
  }
  // macOS: ~/Library/Application Support/OpenClaw
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'OpenClaw')
  }
  // Linux / fallback: dev data dir
  return path.join(ROOT, '.openclaw-desktop-data')
}

const dataRoot = resolveDataRoot()
const backendDir = path.join(dataRoot, 'backend')

// ── Resolve layer files ───────────────────────────────────────────────────────
const rootPkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const ocVersion = rootPkg.dependencies.openclaw.replace(/^[^0-9]*/, '')

const versionFile = path.join(RELEASE_DIR, 'root-runtime-version.txt')
const rootRuntimeVersion = fs.existsSync(versionFile)
  ? fs.readFileSync(versionFile, 'utf8').trim()
  : '1'

const rootRuntimeTar = path.join(RELEASE_DIR, `layer-root-runtime-v${rootRuntimeVersion}.tar.gz`)
const openclawTar = path.join(RELEASE_DIR, `layer-openclaw-v${ocVersion}.tar.gz`)

// ── Pre-flight ────────────────────────────────────────────────────────────────
console.log(`[install-local] dataRoot:     ${dataRoot}`)
console.log(`[install-local] backendDir:   ${backendDir}`)
console.log(`[install-local] root-runtime: ${path.relative(ROOT, rootRuntimeTar)}`)
console.log(`[install-local] openclaw:     ${path.relative(ROOT, openclawTar)}`)
console.log()

let ok = true
if (!fs.existsSync(rootRuntimeTar)) {
  console.error(`[install-local] ERROR: ${rootRuntimeTar} not found`)
  console.error(`  → Run: npm run layer:pack-root`)
  ok = false
}
if (!fs.existsSync(openclawTar)) {
  console.error(`[install-local] ERROR: ${openclawTar} not found`)
  console.error(`  → Run: npm run layer:pack-openclaw`)
  ok = false
}
if (!ok) process.exit(1)

if (DRY_RUN) {
  console.log(`[install-local] --dry-run: would extract to ${backendDir}`)
  process.exit(0)
}

// ── Backup existing backend/ → backend-old/ ───────────────────────────────────
const backendOldDir = path.join(dataRoot, 'backend-old')
if (fs.existsSync(backendDir)) {
  if (fs.existsSync(backendOldDir)) {
    fs.rmSync(backendOldDir, { recursive: true, force: true })
  }
  fs.renameSync(backendDir, backendOldDir)
  console.log(`[install-local] Backed up existing backend/ → backend-old/`)
}

fs.mkdirSync(backendDir, { recursive: true })

// ── Step 1: Extract ROOT-RUNTIME ──────────────────────────────────────────────
console.log(`[install-local] Step 1/3 — Extracting ROOT-RUNTIME v${rootRuntimeVersion}...`)
await extract({ file: rootRuntimeTar, cwd: backendDir })
console.log(`[install-local]   Done.`)

// ── Step 2: Extract OPENCLAW ──────────────────────────────────────────────────
console.log(`[install-local] Step 2/3 — Extracting OPENCLAW v${ocVersion}...`)
await extract({ file: openclawTar, cwd: backendDir })
console.log(`[install-local]   Done.`)

// ── Step 3: Run hoist ─────────────────────────────────────────────────────────
console.log(`[install-local] Step 3/3 — Running hoist script...`)
const hoistSrc = fs.readFileSync(path.join(ROOT, 'scripts', 'hoist-openclaw-ext-deps.mjs'), 'utf8')
const hoistPatched = hoistSrc.replace(
  /const ROOT\s*=\s*.+/,
  `const ROOT = ${JSON.stringify(backendDir)}`
)
const tempHoist = path.join(backendDir, '_hoist-run.mjs')
fs.writeFileSync(tempHoist, hoistPatched)
try {
  const out = execFileSync(process.execPath, [tempHoist], { encoding: 'utf8', timeout: 60_000 })
  console.log(out.trim().split('\n').map((l) => `[install-local]   ${l}`).join('\n'))
} finally {
  fs.rmSync(tempHoist, { force: true })
}

// ── Write backend-version.json ────────────────────────────────────────────────
const electronVersion = process.versions.node // best we can do outside Electron context
const versions = {
  'root-runtime': rootRuntimeVersion,
  openclaw: ocVersion,
  electronVersion: rootPkg.devDependencies?.electron?.replace(/^[^0-9]*/, '') ?? '35.7.5',
}
const versionJsonPath = path.join(dataRoot, 'backend-version.json')
fs.writeFileSync(versionJsonPath, JSON.stringify(versions, null, 2) + '\n')

// ── Verify ────────────────────────────────────────────────────────────────────
const openclawMjs = path.join(backendDir, 'node_modules', 'openclaw', 'openclaw.mjs')
const splitReady = fs.existsSync(openclawMjs)

console.log()
if (splitReady) {
  console.log(`[install-local] ✓ Split mode ready!`)
  console.log(`[install-local]   openclaw.mjs: ${openclawMjs}`)
  console.log(`[install-local]   backend-version.json: ${JSON.stringify(versions)}`)
  console.log()
  console.log(`[install-local] → Khởi động app để test split mode.`)
  console.log(`[install-local]   App sẽ log: "[main] Split mode: using backend from ${backendDir}"`)
} else {
  console.error(`[install-local] ✗ openclaw.mjs NOT found — split mode will NOT activate.`)
  console.error(`[install-local]   Check: ${openclawMjs}`)
  process.exit(1)
}
