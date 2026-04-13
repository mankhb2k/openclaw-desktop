#!/usr/bin/env node
/**
 * clone-upstream.mjs
 * Clone openclaw upstream into .tmp-openclaw-upstream at a requested tag.
 *
 * Usage:
 *   node scripts/clone-upstream.mjs v2026.4.5
 *   node scripts/clone-upstream.mjs 2026.4.5
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TARGET = path.join(ROOT, ".tmp-openclaw-upstream");
const REF_FILE = path.join(ROOT, "openclaw-src.ref.json");
const PIN_FILE = path.join(ROOT, "openclaw-version.pin");
const REPO_URL = "https://github.com/openclaw/openclaw.git";

function readText(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8").trim();
  } catch {
    return "";
  }
}

function resolveTag(rawTag) {
  if (rawTag && rawTag.trim()) {
    return rawTag.startsWith("v") ? rawTag : `v${rawTag}`;
  }

  try {
    const ref = JSON.parse(readText(REF_FILE));
    if (typeof ref.upstreamTag === "string" && ref.upstreamTag.trim()) {
      return ref.upstreamTag.trim();
    }
  } catch {
    // ignore
  }

  const pinned = readText(PIN_FILE);
  if (pinned) return `v${pinned}`;
  return "";
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    stdio: "inherit",
    shell: false,
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

const tag = resolveTag(process.argv[2] ?? "");
if (!tag) {
  console.error(
    "Missing tag. Use: node scripts/clone-upstream.mjs <tag>. Example: v2026.4.5"
  );
  process.exit(1);
}

if (fs.existsSync(TARGET)) {
  console.log(`[clone-upstream] removing existing: ${TARGET}`);
  fs.rmSync(TARGET, { recursive: true, force: true });
}

console.log(`[clone-upstream] cloning ${REPO_URL} at ${tag} ...`);
run("git", ["clone", "--depth", "1", "--branch", tag, REPO_URL, TARGET]);

const pkgPath = path.join(TARGET, "package.json");
const version = JSON.parse(fs.readFileSync(pkgPath, "utf8")).version;
const expectedVersion = tag.replace(/^v/, "");

if (version !== expectedVersion) {
  console.error(
    `[clone-upstream] version mismatch: tag ${tag} -> package.json version ${version}`
  );
  process.exit(2);
}

console.log(`[clone-upstream] done: ${TARGET}`);
console.log(`[clone-upstream] verified package version: ${version}`);
