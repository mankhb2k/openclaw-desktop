#!/usr/bin/env node
/**
 * check-layer-overlap.mjs
 *
 * Kiểm tra RULE-04: không có package nào nằm ở cả LAYER ROOT-RUNTIME lẫn LAYER OPENCLAW.
 *
 * Exit 0 — không có overlap (an toàn để release)
 * Exit 1 — có overlap (phải fix trước khi release)
 *
 * Cũng kiểm tra thêm:
 *   - Các NATIVE packages không nằm trong ROOT-RUNTIME hay OPENCLAW layers
 *   - openclaw bản thân không bị include trong ROOT-RUNTIME
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const NM = path.join(ROOT, 'node_modules')

const rootPkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const ocPkgPath = path.join(NM, 'openclaw', 'package.json')

if (!fs.existsSync(ocPkgPath)) {
  console.error(`[check-overlap] ERROR: ${ocPkgPath} not found. Run "npm install" first.`)
  process.exit(1)
}
const ocPkg = JSON.parse(fs.readFileSync(ocPkgPath, 'utf8'))

// ── Classification (phải khớp với pack-layer-root-runtime.mjs) ───────────────
const rootDeps = new Set(Object.keys(rootPkg.dependencies || {}))
const ocDeps = new Set(Object.keys(ocPkg.dependencies || {}))
const NATIVE = new Set(Object.keys(rootPkg.optionalDependencies || {}))

const WITH_OC = new Set([...rootDeps, ...NATIVE].filter((p) => ocDeps.has(p)))
const ROOT_ONLY = new Set(
  [...rootDeps].filter((p) => p !== 'openclaw' && !WITH_OC.has(p) && !NATIVE.has(p))
)

// OPENCLAW layer bao gồm: openclaw package + WITH_OC packages (chúng được npm hoist tự động)
const OPENCLAW_LAYER = new Set(['openclaw', ...WITH_OC])

// ── Checks ───────────────────────────────────────────────────────────────────
let ok = true

console.log(`[check-overlap] Checking layer separation...`)
console.log(`  LAYER ROOT-RUNTIME: ${ROOT_ONLY.size} packages`)
console.log(`  LAYER OPENCLAW:     ${OPENCLAW_LAYER.size} packages (openclaw + ${WITH_OC.size} WITH_OC)`)
console.log(`  NATIVE (EXE only):  ${NATIVE.size} packages`)
console.log()

// Check 1: ROOT_ONLY ∩ OPENCLAW_LAYER = ∅
const rootVsOpenclaw = [...ROOT_ONLY].filter((p) => OPENCLAW_LAYER.has(p))
if (rootVsOpenclaw.length > 0) {
  console.error(`[check-overlap] ✗ FAIL: ${rootVsOpenclaw.length} package(s) in BOTH ROOT-RUNTIME and OPENCLAW layers:`)
  for (const p of rootVsOpenclaw) console.error(`    ${p}`)
  console.error(`  Fix: these belong to OPENCLAW layer (they are in openclaw's deps).`)
  console.error(`  Remove them from ROOT-RUNTIME by ensuring they are NOT in rootDeps without being in ocDeps.`)
  ok = false
} else {
  console.log(`[check-overlap] ✓ ROOT-RUNTIME ∩ OPENCLAW = ∅ (no overlap)`)
}

// Check 2: ROOT_ONLY ∩ NATIVE = ∅
const rootVsNative = [...ROOT_ONLY].filter((p) => NATIVE.has(p))
if (rootVsNative.length > 0) {
  console.error(`[check-overlap] ✗ FAIL: ${rootVsNative.length} NATIVE package(s) leaked into ROOT-RUNTIME:`)
  for (const p of rootVsNative) console.error(`    ${p}`)
  ok = false
} else {
  console.log(`[check-overlap] ✓ ROOT-RUNTIME ∩ NATIVE = ∅ (no native binaries in download layer)`)
}

// Check 3: openclaw itself không trong ROOT_ONLY
if (ROOT_ONLY.has('openclaw')) {
  console.error(`[check-overlap] ✗ FAIL: "openclaw" is in ROOT_ONLY — this should never happen.`)
  ok = false
} else {
  console.log(`[check-overlap] ✓ "openclaw" is not in ROOT-RUNTIME layer`)
}

// Check 4: Warn about packages in root deps NOT in any layer (potential oversight)
const unclassified = [...rootDeps].filter(
  (p) => !ROOT_ONLY.has(p) && !OPENCLAW_LAYER.has(p) && !NATIVE.has(p) && p !== 'openclaw'
)
if (unclassified.length > 0) {
  console.warn(`\n[check-overlap] ⚠ WARN: ${unclassified.length} package(s) unclassified (not in any layer):`)
  for (const p of unclassified) console.warn(`    ${p}`)
  console.warn(`  These packages are in root deps but classification is unclear.`)
}

// ── Summary ──────────────────────────────────────────────────────────────────
console.log()
if (ok) {
  console.log(`[check-overlap] ✓ All checks passed. Safe to release.`)
  process.exit(0)
} else {
  console.error(`[check-overlap] ✗ Checks FAILED. Fix overlap before releasing.`)
  process.exit(1)
}
