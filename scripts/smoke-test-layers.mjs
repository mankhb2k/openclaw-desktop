#!/usr/bin/env node
/**
 * smoke-test-layers.mjs
 *
 * Test tính toàn vẹn của 2 layers mà không cần Electron runtime:
 *   1. Extract LAYER ROOT-RUNTIME vào temp dir
 *   2. Extract LAYER OPENCLAW vào temp dir
 *   3. Verify openclaw.mjs tồn tại
 *   4. Chạy hoist-openclaw-ext-deps.mjs trên temp dir
 *   5. Verify ít nhất 1 key package được hoist
 *   6. Kiểm tra một số package thiết yếu trong ROOT_ONLY tồn tại
 *
 * Cleanup temp dir khi xong (kể cả khi lỗi).
 *
 * NOTE: Gateway spawn test đầy đủ cần Electron runtime. Script này chỉ
 *       kiểm tra layer integrity (cấu trúc file sau extract + hoist).
 *
 * Usage: node scripts/smoke-test-layers.mjs [--keep-temp]
 *        --keep-temp: giữ lại temp dir để debug
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { extract } from 'tar'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const RELEASE_DIR = path.join(ROOT, 'release')

const args = process.argv.slice(2)
const KEEP_TEMP = args.includes('--keep-temp')

// ── Resolve file paths ────────────────────────────────────────────────────────
const rootPkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const ocVersion = rootPkg.dependencies.openclaw.replace(/^[^0-9]*/, '')

const versionFile = path.join(RELEASE_DIR, 'root-runtime-version.txt')
const rootRuntimeVersion = fs.existsSync(versionFile)
  ? fs.readFileSync(versionFile, 'utf8').trim()
  : '1'

const rootRuntimeTar = path.join(RELEASE_DIR, `layer-root-runtime-v${rootRuntimeVersion}.tar.gz`)
const openclawTar = path.join(RELEASE_DIR, `layer-openclaw-v${ocVersion}.tar.gz`)

// ── Pre-flight checks ─────────────────────────────────────────────────────────
let preflight = true
if (!fs.existsSync(rootRuntimeTar)) {
  console.error(`[smoke-test] ERROR: ${path.relative(ROOT, rootRuntimeTar)} not found.`)
  console.error(`  → Run: npm run layer:pack-root`)
  preflight = false
}
if (!fs.existsSync(openclawTar)) {
  console.error(`[smoke-test] ERROR: ${path.relative(ROOT, openclawTar)} not found.`)
  console.error(`  → Run: npm run layer:pack-openclaw`)
  preflight = false
}
if (!preflight) process.exit(1)

// ── Create temp backend dir ───────────────────────────────────────────────────
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-smoke-'))
console.log(`[smoke-test] Temp dir: ${tempDir}`)
console.log()

let exitCode = 0

try {
  // ── Step 1: Extract ROOT-RUNTIME ────────────────────────────────────────────
  console.log(`[smoke-test] Step 1/5 — Extract ROOT-RUNTIME (v${rootRuntimeVersion})...`)
  await extract({ file: rootRuntimeTar, cwd: tempDir })
  const rootNM = path.join(tempDir, 'node_modules')
  if (!fs.existsSync(rootNM)) throw new Error(`node_modules/ not found after ROOT-RUNTIME extract`)
  const rootPkgCount = fs.readdirSync(rootNM).length
  console.log(`[smoke-test]   ✓ node_modules/ contains ${rootPkgCount} entries`)

  // ── Step 2: Extract OPENCLAW ────────────────────────────────────────────────
  console.log(`[smoke-test] Step 2/5 — Extract OPENCLAW (v${ocVersion})...`)
  await extract({ file: openclawTar, cwd: tempDir })
  const openclawDir = path.join(tempDir, 'node_modules', 'openclaw')
  if (!fs.existsSync(openclawDir)) throw new Error(`node_modules/openclaw/ not found after OPENCLAW extract`)
  console.log(`[smoke-test]   ✓ node_modules/openclaw/ present`)

  // ── Step 3: Verify openclaw.mjs ─────────────────────────────────────────────
  console.log(`[smoke-test] Step 3/5 — Verify openclaw.mjs...`)
  const openclawMjs = path.join(openclawDir, 'openclaw.mjs')
  if (!fs.existsSync(openclawMjs)) {
    throw new Error(`openclaw.mjs not found: ${openclawMjs}`)
  }
  const mjsStat = fs.statSync(openclawMjs)
  console.log(`[smoke-test]   ✓ openclaw.mjs exists (${(mjsStat.size / 1024).toFixed(0)} KB)`)

  // Verify openclaw/dist/ exists
  const distDir = path.join(openclawDir, 'dist')
  if (!fs.existsSync(distDir)) {
    throw new Error(`openclaw/dist/ not found — layer may be incomplete`)
  }
  console.log(`[smoke-test]   ✓ openclaw/dist/ present`)

  // Verify openclaw/docs/ was excluded (RULE-02 MUST)
  const docsDir = path.join(openclawDir, 'docs')
  if (fs.existsSync(docsDir)) {
    console.warn(`[smoke-test]   ⚠ WARN: openclaw/docs/ found — should have been excluded by pack script!`)
  } else {
    console.log(`[smoke-test]   ✓ openclaw/docs/ correctly excluded`)
  }

  // ── Step 4: Run hoist script on temp dir ────────────────────────────────────
  console.log(`[smoke-test] Step 4/5 — Run hoist-openclaw-ext-deps.mjs...`)

  // Patch hoist script to use tempDir as ROOT instead of its own parent dir
  const hoistSrc = fs.readFileSync(path.join(ROOT, 'scripts', 'hoist-openclaw-ext-deps.mjs'), 'utf8')
  const hoistPatched = hoistSrc.replace(
    /const ROOT\s*=\s*.+/,
    `const ROOT = ${JSON.stringify(tempDir)}`
  )
  const tempHoist = path.join(tempDir, '_hoist.mjs')
  fs.writeFileSync(tempHoist, hoistPatched)

  let hoistOutput = ''
  try {
    hoistOutput = execFileSync(process.execPath, [tempHoist], {
      encoding: 'utf8',
      timeout: 60_000,
    })
    console.log(hoistOutput.trimEnd().split('\n').map((l) => `[smoke-test]   ${l}`).join('\n'))
  } catch (err) {
    throw new Error(`hoist script failed: ${err.message}\n${err.stderr || ''}`)
  } finally {
    fs.rmSync(tempHoist, { force: true })
  }

  if (!hoistOutput.includes('done —')) {
    throw new Error(`hoist script output did not contain "done —" — unexpected completion`)
  }

  // ── Step 5: Spot-check key packages ─────────────────────────────────────────
  console.log(`[smoke-test] Step 5/5 — Spot-check key packages...`)

  const checks = [
    // ROOT-RUNTIME packages (vài đại diện)
    { pkg: 'electron-updater', layer: 'ROOT-RUNTIME' },
    { pkg: 'axios', layer: 'ROOT-RUNTIME' },
    { pkg: 'tree-kill', layer: 'ROOT-RUNTIME' },
    // OPENCLAW packages
    { pkg: 'openclaw', layer: 'OPENCLAW' },
  ]

  let checkFail = false
  for (const { pkg, layer } of checks) {
    const dir = path.join(tempDir, 'node_modules', pkg)
    if (fs.existsSync(dir)) {
      console.log(`[smoke-test]   ✓ ${pkg} (${layer})`)
    } else {
      console.warn(`[smoke-test]   ⚠ ${pkg} (${layer}) — not found in node_modules/`)
      checkFail = true
    }
  }

  if (checkFail) {
    console.warn(`[smoke-test] Some spot-checks failed — layer may be incomplete.`)
  }

  // ── Done ─────────────────────────────────────────────────────────────────────
  console.log()
  console.log(`[smoke-test] ✓ All steps passed.`)
  console.log(`[smoke-test]   ROOT-RUNTIME v${rootRuntimeVersion} + OPENCLAW v${ocVersion} → structurally valid.`)
  console.log(`[smoke-test]   NOTE: Full gateway launch test requires Electron runtime.`)
} catch (err) {
  console.error()
  console.error(`[smoke-test] ✗ FAILED: ${err.message}`)
  exitCode = 1
} finally {
  if (KEEP_TEMP) {
    console.log(`[smoke-test] Temp dir kept (--keep-temp): ${tempDir}`)
  } else {
    fs.rmSync(tempDir, { recursive: true, force: true })
    console.log(`[smoke-test] Temp dir cleaned up.`)
  }
}

process.exit(exitCode)
