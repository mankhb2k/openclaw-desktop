#!/usr/bin/env node
/**
 * verify-pin.mjs
 * So sánh 3 nguồn sự thật:
 *   1. openclaw-version.pin          ← ý định fork (nguồn chủ)
 *   2. node_modules/openclaw/package.json .version  ← thực tế installed
 *   3. openclaw-src.ref.json .npmVersion            ← lần sync-src cuối
 *
 * Exit 0 nếu tất cả khớp, exit 1 nếu có drift.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function readFile(p) {
  return fs.existsSync(p) ? fs.readFileSync(p, "utf8").trim() : null;
}

const PIN_FILE   = path.join(ROOT, "openclaw-version.pin");
const NM_PKG     = path.join(ROOT, "node_modules", "openclaw", "package.json");
const REF_FILE   = path.join(ROOT, "openclaw-src.ref.json");

const pinVersion = readFile(PIN_FILE);
const nmVersion  = fs.existsSync(NM_PKG)
  ? JSON.parse(fs.readFileSync(NM_PKG, "utf8")).version
  : null;
const refVersion = fs.existsSync(REF_FILE)
  ? JSON.parse(fs.readFileSync(REF_FILE, "utf8")).npmVersion
  : null;

console.log("╔══════════════════════════════════════════╗");
console.log("║        openclaw version pin check        ║");
console.log("╠══════════════════════════════════════════╣");
console.log(`║  pin file        : ${(pinVersion  ?? "(missing)").padEnd(20)} ║`);
console.log(`║  node_modules    : ${(nmVersion   ?? "(missing)").padEnd(20)} ║`);
console.log(`║  openclaw-src ref: ${(refVersion  ?? "(missing)").padEnd(20)} ║`);
console.log("╚══════════════════════════════════════════╝");

const issues = [];

if (!pinVersion) {
  issues.push("❌  openclaw-version.pin thiếu — chạy: node scripts/pin-version.mjs");
}
if (!nmVersion) {
  issues.push("❌  node_modules/openclaw chưa cài — chạy: npm install");
}
if (pinVersion && nmVersion && pinVersion !== nmVersion) {
  issues.push(
    `⚠️   pin (${pinVersion}) ≠ node_modules (${nmVersion}) — chạy: npm install openclaw@${pinVersion}`
  );
}
if (refVersion && nmVersion && refVersion !== nmVersion) {
  issues.push(
    `⚠️   ref.json (${refVersion}) ≠ node_modules (${nmVersion}) — chạy: node scripts/sync-src.mjs`
  );
}
if (!refVersion) {
  issues.push("ℹ️   openclaw-src.ref.json chưa có — chạy: node scripts/pin-version.mjs");
}

if (issues.length === 0) {
  console.log("✅  Tất cả khớp — an toàn build.\n");
  process.exit(0);
} else {
  issues.forEach((msg) => console.warn(msg));
  console.warn("\n🔴  Có drift — xem hướng dẫn bên trên.\n");
  process.exit(1);
}
