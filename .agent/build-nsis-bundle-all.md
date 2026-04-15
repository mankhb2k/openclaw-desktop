# Hướng dẫn Build NSIS — OpenClaw Electron

> Tài liệu này mô tả toàn bộ luồng build đã được xác nhận hoạt động, các vấn đề đã gặp, và giải pháp cho từng vấn đề.
> Viết bằng tiếng Việt. Cập nhật: 2026-04-13

---

## 1. Kiến trúc runtime (cần hiểu trước khi build)

### Sơ đồ 3 process

```
OpenClaw.exe (Electron)
│
├── [Process 1] Electron main process  (app/main/main.ts → dist/main/main.js)
│     │  - Mở BrowserWindow load Control UI
│     │  - Spawn backend launcher với ELECTRON_RUN_AS_NODE=1
│     │  - Quản lý auto-updater, tray, window lifecycle
│     └─ spawn(electronExe, ['dist/backend/start.js'], { ELECTRON_RUN_AS_NODE: '1' })
│
└── [Process 2] Backend launcher       (app/backend/start.ts → dist/backend/start.js)
      │  - Chạy như Node.js thuần (không có Chromium) nhờ ELECTRON_RUN_AS_NODE=1
      │  - ensureDataLayout() → tạo %APPDATA%\openclaw-electron\logs\ etc.
      │  - ensureGatewayDesktopAuth() → ghi openclaw.json (auth token)
      │  - allocateGatewayPort(18789) → thử 40 port
      │  - Spawn openclaw gateway
      └─ spawn(electronExe, ['openclaw.mjs', 'gateway', 'run', '--port', PORT])
            │
            └── [Process 3] OpenClaw Gateway   (node_modules/openclaw/openclaw.mjs)
                  - HTTP server phục vụ Control UI
                  - Load extensions từ dist/extensions/
                  - WebSocket RPC với Electron main
                  - ready (5 plugins, ~25s startup)
```

### Các biến môi trường quan trọng

| Biến                                  | Set bởi           | Ý nghĩa                                                         |
| ------------------------------------- | ----------------- | --------------------------------------------------------------- |
| `OPENCLAW_APP_ROOT`                   | Electron main     | Đường dẫn tới thư mục app (`resources/app`)                     |
| `OPENCLAW_DESKTOP_DATA_ROOT`          | Electron main     | `%APPDATA%\openclaw-electron\` — nơi lưu config, log, workspace |
| `ELECTRON_RUN_AS_NODE`                | Electron main     | Bật chế độ Node.js thuần cho backend launcher                   |
| `OPENCLAW_ELECTRON_RUNNER`            | Electron main     | Path tới `OpenClaw.exe` thực (tránh ENOENT khi portable)        |
| `OPENCLAW_CLI_SCRIPT`                 | Electron main     | Override path tới `openclaw.mjs`                                |
| `OPENCLAW_GATEWAY_NODE`               | (optional)        | Path tới Node.js 22.12+ nếu cần dùng thay Electron              |
| `OPENCLAW_DIR` / `OPENCLAW_STATE_DIR` | backend/config.ts | Thư mục config openclaw                                         |
| `OPENCLAW_WORKSPACE`                  | backend/config.ts | Thư mục workspace                                               |

### Thư mục dữ liệu người dùng (KHÔNG vào bundle)

```
%APPDATA%\openclaw-electron\          ← app.getName() = "openclaw-electron"
├── workspace/                        ← workspace openclaw
├── openclaw/
│   └── openclaw.json                ← config gateway (auth token, control UI path...)
├── logs/
│   ├── launcher.log                 ← log của backend launcher (start.ts)
│   └── openclaw-gateway.log         ← log của gateway process
└── launcher-ready.json              ← signal: gateway đã sẵn sàng (bị xóa khi tắt)
```

> **Lưu ý:** Thư mục data KHÔNG phải `OpenClaw` mà là `openclaw-electron` vì
> `app.getName()` trả về `name` trong `package.json`, không phải `productName`
> trong `electron-builder.yml`. Đây là hành vi của Electron — `productName`
> chỉ ảnh hưởng tên EXE và shortcut, không ảnh hưởng `userData`.

---

## 2. Luồng build đầy đủ (đã xác nhận hoạt động)

### Bước 1 — Cài dependencies và hoist extension packages

```powershell
npm install
```

`postinstall` tự động chạy `scripts/hoist-openclaw-ext-deps.mjs`:

- Scan `node_modules/openclaw/dist/extensions/*/node_modules/`
- Copy mỗi package lên `node_modules/openclaw/node_modules/` nếu chưa có
- Kết quả: ~400 packages được hoist (Slack SDK, Telegram, Discord, Feishu, AWS SDK...)

**Tại sao cần hoist?** openclaw đóng gói extension deps bên trong tarball nhưng không khai báo trong `package.json` của nó. npm v7+ không hoist tự động → gateway crash `Cannot find module` khi load extension.

### Bước 2 — Kiểm tra version pin

```powershell
npm run verify:pin
```

Đảm bảo `node_modules/openclaw/package.json` version khớp với `openclaw-version.pin`. Nếu lệch → rebuild sai version.

### Bước 3 — Compile TypeScript

```powershell
npm run build:ts
```

Compile `app/**/*.ts` → `dist/`:

- `app/main/main.ts` → `dist/main/main.js`
- `app/main/preload-control-ui.ts` → `dist/main/preload-control-ui.js`
- `app/backend/start.ts` → `dist/backend/start.js`
- `app/backend/config.ts` → `dist/backend/config.js`

### Bước 4 — Build NSIS installer

```powershell
npm run dist:nsis
# hoặc chạy cả bước 3+4:
npm run dist:installer
```

Output: `release/OpenClaw-Desktop-Setup-<version>.exe` (~396MB với `asar: false`)

---

## 3. Cấu hình electron-builder.yml hiện tại (đã xác nhận)

```yaml
appId: dev.openclaw.desktop
productName: OpenClaw
executableName: OpenClaw
asar: false # BẮT BUỘC — xem VẤN ĐỀ 2 bên dưới

files:
  - dist/**/*
  - assets/icon.ico
  - package.json
  - node_modules/**/*
  - "!**/*.map"
  - "!node_modules/openclaw/docs/**"

  # Extension-level node_modules đã được hoist lên openclaw/node_modules/ bởi postinstall
  - "!node_modules/openclaw/dist/extensions/*/node_modules/**"

  # node-llama-cpp: chỉ cần engine JS, không cần prebuilt native model runners
  - "!node_modules/node-llama-cpp/llama/**"

  # pdfjs-dist: bỏ web viewer demo
  - "!node_modules/pdfjs-dist/web/**"
  - "!node_modules/pdfjs-dist/types/**"

  # playwright-core: browser drivers không bundle sẵn
  - "!node_modules/playwright-core/.local-browsers/**"
  - "!node_modules/playwright-core/lib/server/chromium/**"
  - "!node_modules/playwright-core/lib/server/firefox/**"
  - "!node_modules/playwright-core/lib/server/webkit/**"

  # TypeScript declarations không cần trong production
  - "!node_modules/**/*.d.ts"
  - "!node_modules/**/*.test.js"
  - "!node_modules/**/*.spec.js"
  - "!node_modules/**/test/**"
  - "!node_modules/**/tests/**"
  - "!node_modules/**/__tests__/**"

  # Upstream source và data không vào bundle
  - "!.openclaw-desktop-data/**"
  - "!.tmp-openclaw-upstream/**"
```

---

## 4. Các vấn đề đã gặp & giải pháp

---

### VẤN ĐỀ 1: `node-llama-cpp` thiếu khỏi node_modules

**Triệu chứng:** Gateway crash khi dùng tính năng local LLM. `npm install` không kéo package này.

**Nguyên nhân:** `node-llama-cpp` là `peerDependency` của openclaw, npm v7+ **không** tự install peerDependencies.

**Giải pháp:** Thêm vào `optionalDependencies` trong `package.json` (đã làm):

```json
"optionalDependencies": {
  "node-llama-cpp": "3.18.1"
}
```

Nếu không dùng tính năng local LLM thì openclaw degrade gracefully.

---

### VẤN ĐỀ 2: `asar: true` làm gateway crash `Unable to open bundled plugin public surface`

**Triệu chứng:** Gateway không start, log hiện:

```
Error: Unable to open bundled plugin public surface ollama/runtime-api.js
  at loadBundledPluginPublicSurfaceModuleSync (
    file:///C:/Users/Admin/AppData/Local/Programs/OpenClaw/resources/app.asar/
    node_modules/openclaw/dist/facade-runtime-Bv3MxT2V.js:313:24)
```

**Nguyên nhân gốc (2 lớp):**

**Lớp 1 — `O_NOFOLLOW` không được hỗ trợ trong ASAR virtual FS:**
File `node_modules/openclaw/dist/boundary-file-read-CdxVvait.js` gọi:

```js
fs.openSync(path, O_NOFOLLOW); // ← flag này
fs.realpathSync(path);
fs.lstatSync(path);
```

Electron's ASAR virtual FS **không implement `O_NOFOLLOW`** → `openSync` throw exception.

**Lớp 2 — `import.meta.url` trả về ASAR path kể cả khi `asarUnpack`:**
openclaw là ESM module. Khi file ở trong `asarUnpack`, Electron tạo entry trong `app.asar` nhưng `import.meta.url` vẫn trả về path ASAR ảo:

```
file:///path/resources/app.asar/node_modules/openclaw/dist/...
```

thay vì:

```
file:///path/resources/app.asar.unpacked/node_modules/openclaw/dist/...
```

→ `openBoundaryFileSync` gọi `fs.openSync(O_NOFOLLOW)` trên ASAR path ảo → crash.

**Giải pháp:** Dùng `asar: false` (bắt buộc với openclaw):

```yaml
asar: false
```

Không có workaround nào cho vấn đề này — đây là giới hạn của Electron ASAR với ESM + `O_NOFOLLOW`.

**Hậu quả:** Installer lớn hơn (~396MB) và cài đặt chậm hơn vì NSIS phải xử lý từng file riêng lẻ trong hàng chục nghìn file.

---

### VẤN ĐỀ 3: Build và cài đặt quá chậm

**Triệu chứng:** Build mất 10+ phút, cài đặt EXE mất 3-5 phút.

**Nguyên nhân:** `asar: false` → NSIS xử lý từng file riêng lẻ trong hàng chục nghìn file.
`node_modules/openclaw` = **255 MB** (extensions, mỗi extension có `node_modules` riêng).

**Phân bố kích thước (đo thực tế):**

| Package              | Kích thước |
| -------------------- | ---------- |
| `openclaw` (toàn bộ) | **255 MB** |
| `pdfjs-dist`         | 39 MB      |
| `node-llama-cpp`     | 32 MB      |
| `matrix-js-sdk`      | 11 MB      |
| `playwright-core`    | 10 MB      |
| `@aws-sdk` (tổng)    | 9 MB       |

**Giải pháp áp dụng — file exclusions trong `electron-builder.yml`:**

| Exclusion                                | Lý do                                   | Ước tính tiết kiệm |
| ---------------------------------------- | --------------------------------------- | ------------------ |
| `extensions/*/node_modules/**`           | Đã hoist lên `openclaw/node_modules/`   | ~150MB             |
| `node-llama-cpp/llama/**`                | Prebuilt model runners — user tự config | ~28MB              |
| `pdfjs-dist/web/**` + `types/**`         | Web viewer demo + TS types              | ~15MB              |
| `playwright-core/lib/server/chromium/**` | Browser driver                          | ~8MB               |
| `**/*.d.ts`                              | TypeScript declarations                 | ~5MB               |
| `**/*.test.js`, `**/tests/**`            | Test files                              | ~2MB               |

**Kết quả:** Installer giảm từ ~600MB+ xuống còn ~396MB.

> **Không thể dùng `asar: true`** để giảm thêm (xem VẤN ĐỀ 2).

---

### VẤN ĐỀ 4: Gateway crash `Cannot find module`

**Triệu chứng:** `openclaw-gateway.log` hiện:

```
Error: Cannot find module '@buape/carbon'
Error: Cannot find module '@larksuiteoapi/node-sdk'
Error: Cannot find module '@slack/web-api'
```

**Nguyên nhân:** openclaw load tất cả extension ngay khi khởi động (kể cả khi chưa cấu hình). Các SDK của extension không có trong `node_modules/openclaw/node_modules/` sau `npm install` sạch vì openclaw đóng gói chúng trong từng extension's `node_modules/` riêng mà không khai báo trong package.json chính.

**Giải pháp (2 tầng):**

1. **`postinstall` hoist script** — chạy tự động qua `npm install`:

   ```powershell
   npm install  # tự động hoist ~400 packages extension
   ```

2. **Khai báo explicit trong `dependencies`** — một số package bị npm deduplicate ra top-level với version ESM-only không `require()` được:
   ```json
   "@buape/carbon": "0.14.0",
   "@larksuiteoapi/node-sdk": "1.60.0",
   "@slack/web-api": "7.15.0",
   "grammy": "1.42.0",
   ...
   ```

---

### VẤN ĐỀ 5: Gateway crash `Node.js v22.12+ is required`

**Triệu chứng:** `launcher.log` hiện:

```
openclaw gateway exited code=1
```

`openclaw-gateway.log` hiện: `Node.js v22.12+ is required`

**Nguyên nhân:** openclaw dùng `--experimental-require-module` (chỉ có từ Node 22.12). Electron 35 ship Node 22.x — nếu dùng Electron cũ hơn (Node 20) → crash.

**Giải pháp:** Dùng `electron@35.x` trở lên (đã pin trong `devDependencies`):

```json
"electron": "35.7.5"
```

---

### VẤN ĐỀ 6: Portable EXE crash khi spawn gateway (ENOENT)

**Triệu chứng:** Bản portable (.exe tự giải nén vào `%TEMP%`) không start gateway, log crash ENOENT.

**Nguyên nhân:** Portable EXE tự giải nén vào `%TEMP%\...`. `process.execPath` trỏ tới path trong Temp → khi gateway cwd dùng `appRoot` (file .asar hoặc directory) → `spawn` lỗi ENOENT.

**Giải pháp đã implement:**

- `app/main/electron-runner.ts` → ưu tiên `app.getPath('exe')` thay `process.execPath` cho packaged apps
- `app/shared/spawn-cwd.ts` → nếu `appRoot` kết thúc bằng `.asar` thì dùng `path.dirname(appRoot)` làm cwd

---

### VẤN ĐỀ 7: App thoát ngay với exit code 9 khi chạy từ win-unpacked trước khi cài

**Triệu chứng:** Chạy `release/win-unpacked/OpenClaw.exe` → exit code 9 sau ~5 giây. Không có file log nào được tạo.

**Nguyên nhân:** Phiên bản đã cài (`app.asar`) và phiên bản `win-unpacked` (`app/` directory) cùng chia sẻ `app.getPath('userData')` → `requestSingleInstanceLock()` ở `main.ts:844` phát hiện lock đang được giữ bởi phiên bản đã cài → gọi `app.quit()`.

Hoặc: Electron phiên bản cũ đã cài giữ Named Pipe lock → phiên bản mới thấy lock → exit.

**Giải pháp:** Không test bằng `win-unpacked` trực tiếp khi đã có bản cài. Thay vào đó:

```powershell
# Uninstall bản cũ trước
# Hoặc dùng --user-data-dir khác nhau
OpenClaw.exe --user-data-dir="C:\tmp\oc-test"
```

**Cách đúng:** Cài NSIS installer mới đè lên bản cũ, rồi chạy bản đã cài.

---

### VẤN ĐỀ 8: Thư mục data là `openclaw-electron` thay vì `OpenClaw`

**Triệu chứng:** Log và config lưu vào `%APPDATA%\openclaw-electron\` thay vì `%APPDATA%\OpenClaw\`.

**Nguyên nhân:** Electron `app.getName()` trả về `name` trong `package.json` (`"openclaw-electron"`), không phải `productName` trong `electron-builder.yml` (`"OpenClaw"`). `productName` chỉ ảnh hưởng tên file EXE và shortcuts.

**Trạng thái:** Được xác nhận là hành vi mong muốn (data dir tách biệt khỏi tên hiển thị). Không cần fix. Log path đúng:

```
%APPDATA%\openclaw-electron\logs\launcher.log
%APPDATA%\openclaw-electron\logs\openclaw-gateway.log
```

---

## 5. Cấu trúc file trong bundle EXE (asar: false)

```
C:\Users\Admin\AppData\Local\Programs\OpenClaw\
├── OpenClaw.exe
├── elevate.exe
├── locales/
├── resources/
│   ├── app/                          ← toàn bộ source (asar: false)
│   │   ├── dist/
│   │   │   ├── main/
│   │   │   │   ├── main.js           ← Electron main process
│   │   │   │   └── preload-control-ui.js
│   │   │   └── backend/
│   │   │       ├── start.js          ← Backend launcher
│   │   │       └── config.js
│   │   ├── assets/
│   │   │   └── icon.ico
│   │   ├── node_modules/
│   │   │   ├── openclaw/             ← Gateway runtime
│   │   │   │   ├── openclaw.mjs
│   │   │   │   ├── dist/
│   │   │   │   │   ├── *.js          ← Compiled gateway code
│   │   │   │   │   └── extensions/   ← Extensions (node_modules đã bị exclude)
│   │   │   │   └── node_modules/     ← Extension deps (hoisted bởi postinstall)
│   │   │   └── ...                   ← Các packages khác
│   │   └── package.json
│   └── app-update.yml
└── Uninstall OpenClaw.exe
```

---

## 6. Smoke test đã xác nhận (2026-04-13)

### Kết quả kiểm tra

| Check                                                             | Kết quả  | Ghi chú                                                             |
| ----------------------------------------------------------------- | -------- | ------------------------------------------------------------------- |
| App launches                                                      | **PASS** | 6 OpenClaw.exe processes                                            |
| `launcher.log` — không có early crash                             | **PASS** | "Gateway is listening on 127.0.0.1:18789"                           |
| Gateway starts                                                    | **PASS** | `ready (5 plugins, 25.1s)`                                          |
| `openclaw-gateway.log` — không có `Cannot find module`            | **PASS** |                                                                     |
| `openclaw-gateway.log` — không có `Unable to open bundled plugin` | **PASS** |                                                                     |
| Port 18789 listening                                              | **PASS** | `TCP 127.0.0.1:18789 LISTENING` + 6 connections                     |
| Control UI signal                                                 | **PASS** | `browser control listening on http://127.0.0.1:18791/`              |
| WebSocket RPC                                                     | **PASS** | `[ws] webchat connected`, `skills.status`, `models.list` thành công |

### Log xác nhận (launcher.log)

```
[2026-04-12T19:36:27.179Z] [launcher] Starting OpenClaw gateway on port 18789 (node: Electron)
[2026-04-12T19:37:39.511Z] [launcher] Gateway is listening on 127.0.0.1:18789
[2026-04-12T19:37:39.512Z] [launcher] Wrote ...\launcher-ready.json (Control UI ready)
```

### Log xác nhận (openclaw-gateway.log)

```
[gateway] loading configuration…
[gateway] resolving authentication…
[gateway] starting...
[gateway] starting HTTP server...
[gateway] ready (5 plugins, 25.1s)
[gateway] starting channels and sidecars...
[browser] control listening on http://127.0.0.1:18791/ (auth=token)
[ws] webchat connected
```

---

## 7. Checklist kiểm tra sau build

### Kiểm tra file output

```
release/OpenClaw-Desktop-Setup-<version>.exe   ← NSIS installer (~396MB)
release/builder-debug.yml                     ← Debug config
release/builder-effective-config.yaml         ← Effective config (xuất hiện sau build)
```

### Kiểm tra `builder-effective-config.yaml`

Sau build, xác nhận:

- `asar: false`
- `files` có exclude `*.map`, `.tmp-openclaw-upstream`, `extensions/*/node_modules`

### Smoke test sau cài đặt

1. **Cài NSIS installer** đè lên bản cũ (quan trọng — xem VẤN ĐỀ 7)
2. **App mở được** → Control UI hiện trong cửa sổ
3. **`launcher.log`** không có `gateway exited code=1` lặp lại
4. **`openclaw-gateway.log`** không có `Cannot find module`
5. **`openclaw-gateway.log`** không có `Unable to open bundled plugin public surface`
6. **Port 18789** đang listen sau khi app mở
7. **`launcher-ready.json`** tồn tại trong `%APPDATA%\openclaw-electron\`

### Script kiểm tra modules bị thiếu (chạy trước build)

```js
// Paste vào Node.js REPL
const pkg = require("./package.json");
const fs = require("fs");
const all = { ...pkg.dependencies, ...pkg.optionalDependencies };
Object.keys(all).forEach((p) => {
  if (!fs.existsSync("node_modules/" + p)) console.log("MISSING:", p);
});
```

---

## 8. Troubleshooting nhanh

| Lỗi trong log                                  | Nguyên nhân                                   | Fix                                                                     |
| ---------------------------------------------- | --------------------------------------------- | ----------------------------------------------------------------------- |
| `Cannot find module 'X'`                       | Package chưa hoist hoặc thiếu trong deps      | Chạy lại `npm install`, kiểm tra `node_modules/openclaw/node_modules/X` |
| `Unable to open bundled plugin public surface` | ASAR block `O_NOFOLLOW`                       | Đảm bảo `asar: false` trong `electron-builder.yml`                      |
| `Node.js v22.12+ is required`                  | Electron Node version quá cũ                  | Dùng `electron@35+` hoặc set `OPENCLAW_GATEWAY_NODE`                    |
| `gateway exited code=1` ngay lập tức           | Xem `openclaw-gateway.log` để biết lý do thực | Thường là module missing hoặc Node version                              |
| Cửa sổ trắng                                   | Gateway chưa ready hoặc crash sớm             | Xem `launcher.log`                                                      |
| Spawn ENOENT (portable)                        | `cwd` trỏ vào file .asar thay vì directory    | Đã fix trong `spawn-cwd.ts`                                             |
| Exit code 9 ngay lập tức                       | Single instance lock từ bản đã cài            | Cài lại NSIS installer mới (đè bản cũ)                                  |
| Build quá chậm                                 | `asar: false` + node_modules quá lớn          | Đã tối ưu với exclusions — không thể dùng `asar: true`                  |

---

## 9. Commands tham khảo

```powershell
# Full build flow (khuyến nghị)
npm install                   # cài deps + hoist extension packages
npm run verify:pin            # kiểm tra openclaw version pin
npm run build:ts              # compile TypeScript
npm run dist:nsis             # build NSIS installer

# Build tất cả targets (NSIS + portable)
npm run dist:all

# Chỉ build portable
npm run dist:portable

# Dev mode (TypeScript watch + Electron)
npm run dev

# Build nhanh (bỏ qua bước 3)
npm run dist:nsis             # chỉ khi dist/ đã compile rồi

# Build từ đầu (bước 3+4)
npm run dist:installer
```

---

_Cập nhật: 2026-04-13 | openclaw@2026.4.5 | electron@35.7.5 | Installer size: ~396MB_
