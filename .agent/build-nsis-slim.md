# Build NSIS Slim Exe — Flow, Triển khai & Troubleshooting

> Tài liệu này ghi lại kiến trúc 2-layer, quy trình build/deploy đúng, danh sách deps
> bắt buộc, và toàn bộ lỗi thực tế gặp phải trong quá trình test cùng cách khắc phục.

---

## 1. Kiến trúc tổng quan — 2-Layer Pipeline

```
┌──────────────────────────────────────────────────────────┐
│  Openclaw-Desktop-Setup-1.0.0.exe  (~20 MB)              │
│  ● Electron shell + main process code                    │
│  ● KHÔNG chứa openclaw hay extension deps                │
│  ● Chứa: axios, tar, tree-kill, electron-updater         │
└──────────────┬───────────────────────────────────────────┘
               │  Lần đầu chạy: isSplitModeReady() = false
               ▼
┌──────────────────────────────────────────────────────────┐
│  Setup Screen (resources/setup.html)                     │
│  User bấm "Tải backend"                                   │
└──────────────┬───────────────────────────────────────────┘
               │
               ▼
  GitHub Releases (mankhb2k/openclaw-desktop)
  ┌─────────────────────────────────────────┐
  │  release/backend-manifest.json          │  ← raw.githubusercontent.com
  └─────────────────────────────────────────┘
               │  fetch + parse + diffLayers()
               ▼
  Layer 1: layer-root-runtime-v1.tar.gz (~300 KB compressed)
  Layer 2: layer-openclaw-v2026.4.5.tar.gz (~16 MB compressed)
               │
               ▼  verify SHA-256 → extract → hoist → atomicSwap
  %AppData%\OpenClaw Desktop\
  └── backend\
      └── node_modules\
          ├── axios\
          ├── electron-updater\
          ├── tree-kill\
          └── openclaw\          ← entry point: openclaw.mjs
               │
               ▼
  startBackendLauncher() → gateway starts → Control UI loads
```

### Luồng startup đầy đủ

```
app.whenReady()
  └─ createWindow()
       ├─ isSplitModeReady(dataRoot)?
       │    YES → ensureBackendAndGetUrl() → loadURL(controlUiUrl)
       │    NO  → runSetupFlow(dataRoot)
       │              └─ BrowserWindow(setup.html + setup-preload.js)
       │                   └─ user clicks "Tải backend"
       │                        └─ IPC: setup:start-download
       │                             └─ performInitialDownload()
       │                                  ├─ updateBackendLayers()  [layer-updater.ts]
       │                                  │    ├─ fetchBackendManifest()
       │                                  │    ├─ diffLayers()
       │                                  │    ├─ downloadLayer() x2
       │                                  │    ├─ verifySha256() x2
       │                                  │    ├─ extractLayer() x2
       │                                  │    ├─ runHoistScript()
       │                                  │    ├─ smokeCheck()
       │                                  │    └─ atomicSwap() → backend-new/ → backend/
       │                                  └─ ensureBackendAndGetUrl()
       │                                       └─ startBackendLauncher()
       │                                            └─ waitForLauncherReady(90s)
       │                                                 └─ loadURL(controlUiUrl)
       └─ (sau setup) scheduleBackendLayerCheck() [packaged only]
```

---

## 2. isSplitModeReady()

```typescript
// app/main/layer-updater.ts
export function isSplitModeReady(dataRoot: string): boolean {
  const openclawMjs = path.join(
    getBackendDir(dataRoot),   // dataRoot/backend/
    'node_modules', 'openclaw', 'openclaw.mjs'
  );
  return fs.existsSync(openclawMjs);
}
```

**dataRoot theo môi trường:**
- Dev (`app.isPackaged = false`): `<projectRoot>/.openclaw-desktop-data/`
- Packaged: `%AppData%\OpenClaw Desktop\` (Windows)

**splitReady trong startBackendLauncher:**
```typescript
const splitReady = app.isPackaged && isSplitModeReady(dataRoot);
const appRoot = splitReady
  ? path.join(dataRoot, 'backend')   // dùng downloaded openclaw
  : getProjectRoot();                 // fallback: project root (dev only)
```
> ⚠️ `splitReady` chỉ true khi `app.isPackaged = true`. Dev mode luôn dùng project root.

---

## 3. Manifest & Layers

### backend-manifest.json (release/backend-manifest.json, nhánh main)

```json
{
  "schemaVersion": 2,
  "electronVersion": "41.2.0",
  "platform": "win32",
  "arch": "x64",
  "layers": {
    "root-runtime": {
      "version": "1",
      "sha256": "7472ebfe86a6feed260ad8354c1827e3197f54f3efd7d115a35ec0eef96a1946",
      "url": "https://github.com/Mankhb2k/openclaw-desktop/releases/download/v1.0.0/layer-root-runtime-v1.tar.gz",
      "compressedBytes": 298470,
      "extractTo": "node_modules",
      "requiresHoist": false
    },
    "openclaw": {
      "version": "2026.4.5",
      "sha256": "3876a65aed1a3bff0b0cfd0582fbc18a85f717d50615d75263e54231cbe6f0a4",
      "url": "https://github.com/Mankhb2k/openclaw-desktop/releases/download/v1.0.0/layer-openclaw-v2026.4.5.tar.gz",
      "compressedBytes": 16862721,
      "extractTo": "node_modules",
      "requiresHoist": true,
      "hoistScript": "scripts/hoist-openclaw-ext-deps.mjs"
    }
  },
  "extractOrder": ["root-runtime", "openclaw"],
  "minAppVersion": "1.0.0"
}
```

**URL manifest** (fetch tại runtime):
```
https://raw.githubusercontent.com/mankhb2k/openclaw-desktop/main/release/backend-manifest.json
```

**backend-version.json** (lưu tại dataRoot sau khi cài xong):
```json
{
  "root-runtime": "1",
  "openclaw": "2026.4.5",
  "electronVersion": "41.2.0"
}
```

---

## 4. Dependencies bắt buộc

### Electron version
| npm package | Electron runtime | Node.js embedded | V8 |
|-------------|-----------------|------------------|----|
| `electron@41.2.0` | 41.2.0 | **24.14.0** | 14.6.202.31 |

> ⚠️ `electron.exe --version` khi có `ELECTRON_RUN_AS_NODE=1` trong env trả về **Node version** (24.14.0),
> KHÔNG phải Electron version. Dùng `process.versions.electron` để lấy đúng.

### tar — PHẢI dùng v6, KHÔNG được dùng v7+

| Version | `"type"` | Tương thích | Lý do |
|---------|----------|-------------|-------|
| `tar@6.x` | CJS (không có) | ✅ OK | CommonJS, `require('tar')` hoạt động bình thường |
| `tar@7.x` | `"module"` (ESM-only) | ❌ FAIL | Node.js 24 load ESM qua `import()` → `SyntaxError: Unexpected token ')'` |

```json
// package.json — đúng
"tar": "^6.2.1",
"@types/tar": "^6.1.13"
```

### axios — v1.13+ có dual CJS/ESM

`axios@1.x` có `"type": "module"` nhưng vẫn export CJS qua `exports.default.require`.
Node.js 24 resolve đúng via `"require"` export condition → `require('axios')` hoạt động.

### Tất cả dependencies trong exe

```json
"dependencies": {
  "axios":            "^1.13.6",   // HTTP client cho manifest fetch + layer download
  "electron-updater": "^6.8.3",   // Auto-update exe
  "tar":              "^6.2.1",   // Extract .tar.gz layers — PHẢI v6 (CJS)
  "tree-kill":        "^1.2.2"    // Kill backend process tree khi đóng app
}
```
> `openclaw` đã bị xóa khỏi `dependencies`/`optionalDependencies` — download dưới dạng layer.

---

## 5. Quy trình build + deploy đúng

### Bước 1: Chuẩn bị layers và đẩy lên GitHub Releases

```bash
# 1a. Tạo layer-root-runtime-v1.tar.gz
node scripts/pack-root-runtime.mjs

# 1b. Tạo layer-openclaw-v<version>.tar.gz
node scripts/pack-openclaw-layer.mjs

# 1c. Upload lên GitHub Releases (tag v1.0.0)
gh release upload v1.0.0 \
  layer-root-runtime-v1.tar.gz \
  layer-openclaw-v2026.4.5.tar.gz

# 1d. Verify sha256 của file đã upload khớp với file local
certutil -hashfile layer-root-runtime-v1.tar.gz SHA256
certutil -hashfile layer-openclaw-v2026.4.5.tar.gz SHA256
```

### Bước 2: Generate và commit manifest

```bash
node scripts/generate-backend-manifest.mjs
# → cập nhật release/backend-manifest.json với sha256 đúng

git add release/backend-manifest.json
git commit -m "chore: update backend-manifest.json for vX.X.X"
git push origin main
```

> ⚠️ **QUAN TRỌNG**: Manifest phải được push lên **nhánh `main`** TRƯỚC khi release exe.
> App fetch manifest từ `raw.githubusercontent.com/.../main/release/backend-manifest.json`.
> GitHub CDN có thể cache — nếu cần test ngay, đợi ~1 phút sau khi push.

### Bước 3: Build TypeScript

```bash
npm run build:ts
# Nếu lỗi @types/tar missing: npm install --save-dev @types/tar
```

### Bước 4: Build exe

```bash
npx electron-builder --win --x64
# Output: release/Openclaw-Desktop-Setup-1.0.0.exe
```

> ⚠️ Không cần admin để build. Nhưng cần admin để **cài vào Program Files**.
> Cài vào `C:\Users\<user>\AppData\Local\Programs\` không cần admin.

### Bước 5: Test first-run (packaged exe)

```bash
# Xóa backend cũ nếu có
rm -rf "$APPDATA\OpenClaw Desktop\backend"
rm "$APPDATA\OpenClaw Desktop\backend-version.json"

# Chạy installer → mở app → setup screen hiện → bấm "Tải backend"
```

### Test dev mode (không cần build exe)

```bash
# Đảm bảo backend chưa được cài
rm -rf .openclaw-desktop-data/backend
rm -rf .openclaw-desktop-data/backend-dl

# Chạy app với setup screen
FORCE_SETUP_SCREEN=1 node scripts/start-electron.mjs
```

> **Lưu ý**: `start-electron.mjs` bắt buộc phải dùng — xóa `ELECTRON_RUN_AS_NODE=1`
> trước khi spawn Electron. Nếu dùng `npx electron .` trực tiếp → crash vì `app` undefined.

---

## 6. Hoist Script — cơ chế và giới hạn

`hoist-openclaw-ext-deps.mjs` copy package từ:
```
node_modules/openclaw/dist/extensions/<ext>/node_modules/<pkg>
```
lên:
```
node_modules/openclaw/node_modules/<pkg>
```

**Khi nào cần:** Khi các extension của openclaw ship deps riêng trong `dist/extensions/*/node_modules/`.
**Phiên bản openclaw hiện tại (2026.4.5):** Extensions không có nested `node_modules` → hoist là no-op.

**Trong layer-updater.ts**, hoist được skip nếu `openclaw.mjs` không có trong `backend-new/`:
```typescript
if (fs.existsSync(openclawMjsInNew)) {
  await runHoistScript(backendNewDir, projectRoot);
}
```

---

## 7. Tất cả lỗi gặp phải và cách khắc phục

### Lỗi 1: `SyntaxError: Unexpected token ')'` khi app khởi động

**Triệu chứng:** Dialog "A JavaScript error occurred in the main process" ngay khi mở app.

**Stack trace:**
```
SyntaxError: Unexpected token ')'
  at compileSourceTextModule (node:internal/modules/esm/utils:319:16)
  at ModuleLoader.moduleStrategyTranslators:99:18
  ...
```

**Nguyên nhân:** `tar@7` là ESM-only (`"type": "module"`). Khi Electron 41 / Node.js 24
load `require('tar')` từ CJS context, Node.js 24 thử load package qua ESM loader
→ parse fail → `SyntaxError: Unexpected token ')'`.

**Fix:**
```bash
npm install tar@6
npm install --save-dev @types/tar
npm run build:ts
```

---

### Lỗi 2: `SyntaxError: Unexpected token ')'` trong `_hoist-run.mjs`

**Triệu chứng:** Download bắt đầu, fail ở bước hoisting. Log khi chạy thủ công:
```
file:///.../backend-new/_hoist-run.mjs:23
const ROOT = "D:\\...\\backend-new"), "..");
                                    ^
SyntaxError: Unexpected token ')'
```

**Nguyên nhân:** Regex trong `runHoistScript()` (layer-updater.ts) dùng `[^)]+`
chỉ match đến dấu `)` đầu tiên trong nested parens:

Original line: `const ROOT   = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");`

Regex `/const ROOT\s*=\s*path\.resolve\([^)]+\)/` match đến `)` của `fileURLToPath(...)`,
bỏ lại `, "..")` — tạo ra syntax không hợp lệ:
```javascript
const ROOT = "D:\\...\\backend-new"), "..");
```

**Fix** — `app/main/layer-updater.ts`, function `runHoistScript()`:
```typescript
// WRONG:
const hoistPatched = hoistSrc.replace(
  /const ROOT\s*=\s*path\.resolve\([^)]+\)/,
  `const ROOT = ${JSON.stringify(backendDir)}`,
);

// CORRECT — replace toàn bộ dòng bằng multiline regex:
const hoistPatched = hoistSrc.replace(
  /^const ROOT\s*=.*$/m,
  `const ROOT = ${JSON.stringify(backendDir)};`,
);
```

---

### Lỗi 3: Button "Tải backend" bấm không có phản hồi

**Triệu chứng:** Bấm nút → không có gì xảy ra, không log, không error.

**Nguyên nhân:** CSP (Content Security Policy) trong `setup.html` block inline script:
```html
<!-- SAI — default-src 'self' block inline <script> và onclick= -->
<meta http-equiv="Content-Security-Policy" content="default-src 'self'">
<script>/* inline JS bị block */</script>
<button onclick="startDownload()">Tải backend</button>
```

**Fix:**
1. Tách JS ra file riêng: `resources/setup-renderer.js`
2. Cập nhật CSP:
```html
<meta http-equiv="Content-Security-Policy"
      content="default-src 'self'; style-src 'unsafe-inline'; script-src 'self'">
```
3. Dùng `addEventListener` thay vì `onclick=`:
```javascript
// resources/setup-renderer.js
btnDownload.addEventListener('click', startDownload);
btnRetry.addEventListener('click', resetUI);
```

---

### Lỗi 4: Retry không hoạt động — "Thử lại" bấm xong không download được

**Triệu chứng:** Fail lần 1 → bấm "Thử lại" → UI reset → bấm "Tải backend" → không phản hồi.

**Nguyên nhân:** `ipcMain.once("setup:start-download", ...)` bị consume sau lần đầu:
```typescript
// WRONG:
ipcMain.once("setup:start-download", () => { ... });
```

**Fix:**
```typescript
// CORRECT:
let downloading = false;
ipcMain.on("setup:start-download", () => {
  if (downloading) return;
  downloading = true;
  void performInitialDownload(dataRoot).finally(() => {
    downloading = false;
  });
});
```

---

### Lỗi 5: SHA-256 mismatch

**Triệu chứng:**
```
[layer-updater] Update failed: SHA-256 mismatch for layer-root-runtime-v1.tar.gz
  expected: 9d33e70f...
  actual:   7472ebfe...
```

**Nguyên nhân 1:** Tar file bị recreate nhưng manifest chưa regenerate → sha256 cũ.

**Nguyên nhân 2:** Electron process đang dùng manifest fetch từ trước khi push commit
(process chạy từ trước) → cần restart hoàn toàn.

**Fix:**
```bash
# 1. Verify sha256 của file trên GitHub:
curl -sL <layer-url> | certutil -hashfile /stdin SHA256

# 2. Regenerate manifest và push:
node scripts/generate-backend-manifest.mjs
git add release/backend-manifest.json && git push origin main

# 3. Kill tất cả Electron process, restart app:
taskkill /F /IM electron.exe
FORCE_SETUP_SCREEN=1 node scripts/start-electron.mjs
```

---

### Lỗi 6: `ELECTRON_RUN_AS_NODE=1` — `app` là undefined

**Triệu chứng:** Crash ngay khi start:
```
TypeError: Cannot read properties of undefined (reading 'isPackaged')
```

**Nguyên nhân:** Claude Code inject `ELECTRON_RUN_AS_NODE=1` → Electron chạy như Node.js
runtime, không expose `app`/`BrowserWindow`.

**Fix:** Luôn dùng `scripts/start-electron.mjs`:
```javascript
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE   // bắt buộc xóa
const child = spawn(electronBin, ['.'], { stdio: 'inherit', env })
```

```bash
# ĐÚNG:
FORCE_SETUP_SCREEN=1 node scripts/start-electron.mjs

# SAI:
npx electron .
```

---

### Lỗi 7: Setup screen không hiện trong dev mode dù set FORCE_SETUP_SCREEN=1

**Nguyên nhân:** Code cũ chỉ check `app.isPackaged`:
```typescript
if (app.isPackaged && !isSplitModeReady(dataRoot)) { ... }
```

**Fix** — `app/main/main.ts`:
```typescript
const forceSetup = process.env.FORCE_SETUP_SCREEN === '1';
if ((app.isPackaged || forceSetup) && !isSplitModeReady(dataRoot)) {
  await runSetupFlow(dataRoot);
  return;
}
```

---

### Lỗi 8: NSIS installer "Error opening file for writing: uninstallerIcon.ico"

**Nguyên nhân:** Cài vào `C:\Program Files` yêu cầu admin rights.

**Fix:**
- Cài vào `C:\Users\<user>\AppData\Local\Programs\` (không cần admin)
- HOẶC: Right-click installer → "Run as administrator"

---

### Lỗi 9: "Backend launcher did not become ready in time"

**Triệu chứng:** Setup xong (hoặc skip download vì up-to-date), sau ~90 giây báo lỗi.

**Nguyên nhân A (debug):** `backend/` bị rename thành `backend.bak/` trong lúc debug.
`backend-version.json` vẫn đúng → `diffLayers()` trả về `[]` → không download
→ thẳng vào `ensureBackendAndGetUrl()` → `isSplitModeReady = false` (backend/ không tồn tại)
→ backend dùng project root (packaged: asar không có openclaw) → gateway fail.

**Fix:**
```bash
mv "$APPDATA\OpenClaw Desktop\backend.bak" "$APPDATA\OpenClaw Desktop\backend"
# Cập nhật electronVersion trong backend-version.json nếu cần
```

**Nguyên nhân B:** Gateway crash (lỗi code openclaw). Xem:
`%AppData%\OpenClaw Desktop\openclaw-gateway.log`

---

### Lỗi 10: Electron binary cũ bị cache — nhầm version

**Triệu chứng:** `electron.exe --version` trả về `v24.14.0`, nhầm tưởng là Electron 24.

**Thực tế:** Khi `ELECTRON_RUN_AS_NODE=1` trong env, `electron.exe --version` in **Node.js version**.
Electron 41 embed Node.js 24, nên `v24.14.0` là đúng (Node version, không phải Electron version).

**Kiểm tra đúng:**
```bash
# Dùng ELECTRON_RUN_AS_NODE để lấy cả hai:
ELECTRON_RUN_AS_NODE=1 electron.exe -e \
  "console.log('electron:', process.versions.electron, 'node:', process.versions.node)"
# → electron: 41.2.0 node: 24.14.0
```

**Nếu binary thực sự bị corrupt (zip cache lỗi):**
```bash
rm "$LOCALAPPDATA\electron\Cache\electron-v41.2.0-win32-x64.zip"
rm node_modules/electron/dist/version
node node_modules/electron/install.js
```

---

### Lỗi 11: asar: false → exe quá lớn

**Trước:** `asar: false` cần thiết vì openclaw dùng `O_NOFOLLOW` + `import.meta.url` (ESM).

**Sau (2-layer):** openclaw không vào bundle → tất cả package còn lại là CJS → ASAR-safe.

**Fix** — `electron-builder.yml`:
```yaml
asar: true  # thay cho asar: false
```

---

## 8. Checklist trước khi release

- [ ] `tar@6.x` trong dependencies (KHÔNG phải v7+)
- [ ] `@types/tar@^6` trong devDependencies
- [ ] `npm run build:ts` thành công (0 errors)
- [ ] `release/backend-manifest.json` có sha256 đúng với files trên GitHub Releases
- [ ] Manifest đã push lên **nhánh `main`** TRƯỚC khi release exe
- [ ] GitHub Release có đủ 2 assets: `layer-root-runtime-*.tar.gz` + `layer-openclaw-*.tar.gz`
- [ ] `electron-builder.yml` có `asar: true`
- [ ] `"!node_modules/openclaw/**"` trong files exclusions
- [ ] `openDevTools({ mode: 'detach' })` đã XÓA khỏi `runSetupFlow()` trong main.ts
- [ ] Test first-run: xóa `backend/` và `backend-version.json`, chạy exe mới

---

## 9. Files quan trọng

| File | Mục đích |
|------|----------|
| `app/main/main.ts` | Main process: setup flow, gateway launcher, IPC handlers |
| `app/main/layer-updater.ts` | Download + verify + extract + hoist + atomicSwap |
| `app/main/backend-manifest.ts` | Types, fetchBackendManifest, diffLayers |
| `app/main/setup-preload.ts` | Bridge IPC giữa renderer và main cho setup window |
| `resources/setup.html` | Setup screen UI |
| `resources/setup-renderer.js` | Setup screen JS (tách riêng để pass CSP) |
| `release/backend-manifest.json` | Manifest commit vào repo, fetch tại runtime |
| `scripts/generate-backend-manifest.mjs` | Tính sha256 và ghi manifest |
| `scripts/hoist-openclaw-ext-deps.mjs` | Copy ext deps lên openclaw/node_modules |
| `scripts/start-electron.mjs` | Dev launcher (xóa ELECTRON_RUN_AS_NODE trước spawn) |
| `electron-builder.yml` | Build config: asar, files exclusions, NSIS settings |
