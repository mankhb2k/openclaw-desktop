#!/usr/bin/env node
/**
 * pin-version.mjs
 * Ghi openclaw-version.pin và openclaw-src.ref.json từ node_modules/openclaw đã cài.
 * Chạy sau `npm install`:  node scripts/pin-version.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NM_PKG = path.join(ROOT, "node_modules", "openclaw", "package.json");

if (!fs.existsSync(NM_PKG)) {
  console.error("❌  node_modules/openclaw chưa cài. Chạy: npm install");
  process.exit(1);
}

const { version } = JSON.parse(fs.readFileSync(NM_PKG, "utf8"));

// 1. openclaw-version.pin — nguồn sự thật duy nhất
fs.writeFileSync(path.join(ROOT, "openclaw-version.pin"), version + "\n", "utf8");
console.log(`✅  openclaw-version.pin → ${version}`);

// 2. openclaw-src.ref.json — audit trail
const ref = {
  npmVersion: version,
  upstreamTag: `v${version}`,
  syncedAt: new Date().toISOString(),
};
fs.writeFileSync(
  path.join(ROOT, "openclaw-src.ref.json"),
  JSON.stringify(ref, null, 2) + "\n",
  "utf8"
);
console.log(`✅  openclaw-src.ref.json → ${JSON.stringify(ref)}`);
