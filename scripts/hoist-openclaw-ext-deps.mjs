#!/usr/bin/env node
/**
 * hoist-openclaw-ext-deps.mjs
 *
 * openclaw ships extension-specific node_modules inside dist/extensions/<ext>/node_modules/.
 * npm v7+ no longer hoists these packages up to openclaw/node_modules/ automatically
 * (behavior changed vs older npm versions). Without hoisting, dist/*.js files that import
 * these packages (e.g. @slack/web-api, grammy, @buape/carbon) fail with "Cannot find module".
 *
 * This script mirrors the old npm behavior: copy any package found in
 *   node_modules/openclaw/dist/extensions/<ext>/node_modules/<pkg>
 * into
 *   node_modules/openclaw/node_modules/<pkg>
 * if it is not already present there (does NOT overwrite existing versions).
 *
 * Run: node scripts/hoist-openclaw-ext-deps.mjs
 * Called automatically by the "postinstall" npm script.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT   = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OC_DIST_EXT = path.join(ROOT, "node_modules", "openclaw", "dist", "extensions");
const OC_NM       = path.join(ROOT, "node_modules", "openclaw", "node_modules");

if (!fs.existsSync(OC_DIST_EXT)) {
  console.log("[hoist-openclaw-ext-deps] dist/extensions not found — skipping.");
  process.exit(0);
}

fs.mkdirSync(OC_NM, { recursive: true });

let copied = 0;
let skipped = 0;

/** Recursively list top-level package names (and scoped) under a node_modules dir. */
function listTopLevelPackages(nmDir) {
  const pkgs = [];
  if (!fs.existsSync(nmDir)) return pkgs;
  for (const entry of fs.readdirSync(nmDir)) {
    if (entry.startsWith(".")) continue;
    const full = path.join(nmDir, entry);
    if (!fs.statSync(full).isDirectory()) continue;
    if (entry.startsWith("@")) {
      // Scoped: @scope/name
      for (const sub of fs.readdirSync(full)) {
        if (sub.startsWith(".")) continue;
        const subFull = path.join(full, sub);
        if (fs.statSync(subFull).isDirectory()) {
          pkgs.push({ rel: `${entry}/${sub}`, src: subFull });
        }
      }
    } else {
      pkgs.push({ rel: entry, src: full });
    }
  }
  return pkgs;
}

/** Recursively copy src → dest, skipping existing files. */
function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isSymbolicLink()) {
      if (!fs.existsSync(d)) {
        try { fs.symlinkSync(fs.readlinkSync(s), d); } catch { /* ignore */ }
      }
    } else if (entry.isDirectory()) {
      copyDir(s, d);
    } else {
      if (!fs.existsSync(d)) {
        try { fs.copyFileSync(s, d); } catch { /* ignore */ }
      }
    }
  }
}

for (const ext of fs.readdirSync(OC_DIST_EXT)) {
  const extNM = path.join(OC_DIST_EXT, ext, "node_modules");
  for (const { rel, src } of listTopLevelPackages(extNM)) {
    const dest = path.join(OC_NM, rel);
    if (fs.existsSync(dest)) {
      skipped++;
      continue;
    }
    // Create scope dir if needed
    if (rel.includes("/")) {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
    }
    copyDir(src, dest);
    copied++;
    console.log(`[hoist] ${rel} ← dist/extensions/${ext}/node_modules/`);
  }
}

console.log(`[hoist-openclaw-ext-deps] done — copied ${copied}, skipped ${skipped} (already present).`);
