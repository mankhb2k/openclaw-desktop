#!/usr/bin/env node
/**
 * compare-upstream.mjs
 * So sánh .tmp-openclaw-upstream/ với node_modules/openclaw/
 * Báo cáo: file chỉ có ở upstream, chỉ ở node_modules, và file cùng tên nhưng khác nội dung.
 *
 * Chạy: node scripts/compare-upstream.mjs
 * Output: compare-upstream.report.md
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const ROOT     = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const UPSTREAM = path.join(ROOT, ".tmp-openclaw-upstream");
const NM       = path.join(ROOT, "node_modules", "openclaw");
const OUT      = path.join(ROOT, "compare-upstream.report.md");

// Thư mục / file bỏ qua (binary, generated, git nội bộ)
const IGNORE_DIRS  = new Set(["node_modules", ".git", "dist", "__pycache__"]);
const IGNORE_EXTS  = new Set([".png", ".jpg", ".jpeg", ".gif", ".ico", ".woff", ".woff2", ".ttf", ".otf", ".eot", ".map"]);

function sha256(filePath) {
  try {
    const buf = fs.readFileSync(filePath);
    return crypto.createHash("sha256").update(buf).digest("hex");
  } catch {
    return null;
  }
}

function walk(dir, base = dir, acc = new Map()) {
  if (!fs.existsSync(dir)) return acc;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (IGNORE_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    const rel  = path.relative(base, full).replace(/\\/g, "/");
    if (entry.isDirectory()) {
      walk(full, base, acc);
    } else {
      const ext = path.extname(entry.name).toLowerCase();
      if (!IGNORE_EXTS.has(ext)) {
        acc.set(rel, sha256(full));
      }
    }
  }
  return acc;
}

console.log("🔍  Đang quét upstream...");
const upstreamFiles = walk(UPSTREAM);
console.log("🔍  Đang quét node_modules/openclaw...");
const nmFiles       = walk(NM);

const onlyUpstream = [];
const onlyNM       = [];
const differ       = [];
const same         = [];

for (const [rel, hash] of upstreamFiles) {
  if (!nmFiles.has(rel)) {
    onlyUpstream.push(rel);
  } else if (nmFiles.get(rel) !== hash) {
    differ.push(rel);
  } else {
    same.push(rel);
  }
}
for (const rel of nmFiles.keys()) {
  if (!upstreamFiles.has(rel)) onlyNM.push(rel);
}

const upVer = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(UPSTREAM, "package.json"), "utf8")).version; } catch { return "?"; }
})();
const nmVer = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(NM, "package.json"), "utf8")).version; } catch { return "?"; }
})();

const now = new Date().toISOString();

let md = `# So sánh upstream vs node_modules/openclaw

**Ngày tạo:** ${now}
**Upstream (.tmp-openclaw-upstream):** v${upVer} — ${upstreamFiles.size} files
**node_modules/openclaw:** v${nmVer} — ${nmFiles.size} files

---

## Tóm tắt

| Nhóm | Số file |
|---|---|
| Chỉ có ở upstream (không pack lên npm) | ${onlyUpstream.length} |
| Chỉ có ở node_modules (generated/dist) | ${onlyNM.length} |
| Cùng tên, **khác nội dung** | ${differ.length} |
| Giống hệt | ${same.length} |

`;

if (differ.length > 0) {
  md += `## File cùng tên nhưng khác nội dung (${differ.length})\n\n`;
  differ.sort().forEach((f) => { md += `- \`${f}\`\n`; });
  md += "\n";
}

if (onlyUpstream.length > 0) {
  md += `## Chỉ có ở upstream — không được pack vào npm (${onlyUpstream.length})\n\n`;
  onlyUpstream.sort().forEach((f) => { md += `- \`${f}\`\n`; });
  md += "\n";
}

if (onlyNM.length > 0) {
  md += `## Chỉ có ở node_modules — generated/dist (${onlyNM.length})\n\n`;
  onlyNM.sort().forEach((f) => { md += `- \`${f}\`\n`; });
  md += "\n";
}

fs.writeFileSync(OUT, md, "utf8");
console.log(`✅  Báo cáo → ${OUT}`);
console.log(`   Khác nội dung: ${differ.length} | Chỉ upstream: ${onlyUpstream.length} | Chỉ npm: ${onlyNM.length} | Giống: ${same.length}`);
