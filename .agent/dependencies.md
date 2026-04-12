# Dependencies — openclaw-electron

> Danh sách và chức năng từng dependency của fork Electron.
> Phân loại: **runtime** (vào bundle .exe) vs **devDependencies** (chỉ dùng lúc build).

---

## Runtime dependencies

Được đóng gói vào NSIS .exe cùng `node_modules/`.

### `openclaw@2026.4.5`

**Vai trò:** Gateway backend chính — toàn bộ business logic của OpenClaw.

- **Entrypoint:** `node_modules/openclaw/openclaw.mjs` → `dist/entry.js`
- **Cách dùng:** Backend launcher spawn bằng `ELECTRON_RUN_AS_NODE=1`:
  ```
  spawn(electronExe, [openclaw.mjs, 'gateway', 'run', '--port', PORT])
  ```
- **Cung cấp:** HTTP server, WebSocket RPC, Control UI web, quản lý channels, AI sessions.
- **Pin:** `openclaw-version.pin` giữ version cố định. Không nâng tự động.

---

### `@buape/carbon@0.14.0`

**Vai trò:** Discord Bot SDK — externalized dependency của openclaw gateway.

- **Tại sao cần khai báo ở fork?** openclaw ship extension Discord trong `dist/` nhưng
  không khai báo `@buape/carbon` trong `package.json` của chính nó. npm v7+ prune các
  package không được khai báo → gateway crash `Cannot find module '@buape/carbon'`.
- **Cơ chế:** `postinstall` script (`hoist-openclaw-ext-deps.mjs`) copy package này từ
  `node_modules/openclaw/dist/extensions/discord/node_modules/` lên
  `node_modules/openclaw/node_modules/` để `dist/*.js` có thể resolve.
- **Không dùng trực tiếp bởi fork:** Chỉ cần vì openclaw dist file import nó statically
  tại load time (bất kể Discord có được configure hay không).

---

### `@larksuiteoapi/node-sdk@1.60.0`

**Vai trò:** Feishu/Lark Bot SDK — externalized dependency của openclaw gateway.

- **Lý do tương tự `@buape/carbon`:** openclaw dist load extension Feishu (`probe-*.js`)
  tĩnh ngay khi gateway khởi động. Nếu thiếu → `Cannot find module '@larksuiteoapi/node-sdk'`
  và gateway không start được dù Feishu chưa được cấu hình.
- **Version:** 1.60.0 — khớp với version trong `openclaw-app` reference.

---

### `electron-updater@^6.x`

**Vai trò:** Auto-update NSIS installer qua GitHub Releases.

- **Cách dùng:** `import { autoUpdater } from 'electron-updater'` trong `app/main/main.ts`.
- **Flow:**
  1. `autoUpdater.checkForUpdates()` → fetch `latest.yml` từ GitHub Releases.
  2. `autoUpdater.downloadUpdate()` → tải `.exe` installer mới về background.
  3. `autoUpdater.quitAndInstall()` → thoát app, chạy installer, khởi động lại.
- **Giới hạn:** Chỉ hoạt động khi `app.isPackaged = true` (bản NSIS cài).
  Bản portable không có NSIS path → `desktopUpdateState.phase = 'unsupported'`.
- **Config:** `electron-builder.yml` → `publish.provider: github` để updater biết feed URL.

---

### `axios@^1.x`

**Vai trò:** HTTP client — fetch `update-notice.json` từ GitHub.

- **Cách dùng:** Trong `main.ts`:
  ```ts
  const res = await axios.get(UPDATE_NOTICE_URL, { timeout: 8000 });
  ```
- **Mục đích:** Lấy thông báo update tự do (announcement title/description) độc lập với
  NSIS binary update — cho phép hiển thị tin nhắn thông báo mà không cần cài bản mới.
- **Tại sao không dùng `fetch` native?** Electron main process đôi khi cần proxy config;
  axios xử lý proxy, timeout, và retry tốt hơn `fetch` built-in ở Node.

---

### `tree-kill@^1.x`

**Vai trò:** Kill toàn bộ process tree khi Electron thoát.

- **Cách dùng:**
  ```ts
  import treeKill from "tree-kill";
  treeKill(backendLauncher.pid, "SIGTERM", callback);
  ```
- **Vấn đề giải quyết:** `process.kill(pid)` chỉ kill process cha. Gateway spawn
  thêm các child processes (worker threads, sub-agents). `tree-kill` đệ quy kill
  tất cả process con trên Windows (dùng `taskkill /T /F`) và Unix (`SIGTERM` cây).
- **Quan trọng trên Windows:** Không có `tree-kill` thì gateway và các worker còn
  sống sau khi Electron thoát → port bị giữ, lần mở tiếp sẽ lỗi `EADDRINUSE`.

---

## Dev dependencies

Chỉ dùng lúc build/compile — không vào bundle production.

---

### `electron@35.x`

**Vai trò:** Chromium + Node.js runtime — nền tảng của ứng dụng desktop.

- **Cung cấp:** `BrowserWindow`, `app`, `ipcMain`, `contextBridge`, `autoUpdater`...
- **Node.js version bên trong:** Electron 35 ship Node 22.x (khớp yêu cầu openclaw ≥ Node 22.12).
- **Quan trọng:** Phiên bản Electron phải ship Node ≥ 22.12 vì openclaw gateway yêu
  cầu minimum Node 22.12 (dùng `--experimental-require-module`). Nếu dùng Electron
  cũ hơn (Node 20) → gateway crash với lỗi `Node.js v22.12+ is required`.
- **Không vào bundle .exe:** electron-builder tự bundle Electron binary vào installer.

---

### `electron-builder@^25.x`

**Vai trò:** Đóng gói Electron app thành Windows installer/portable.

- **Cách dùng:** `npx electron-builder --win nsis`
- **Đọc config từ:** `electron-builder.yml`
- **Output:**
  - `nsis` → `release/OpenClaw-Setup-x.x.x.exe` (NSIS installer)
  - `portable` → `release/OpenClaw-Portable-x.x.x.exe`
- **Xử lý:**
  - Copy `dist/`, `node_modules/`, `package.json` vào bundle
  - Copy `resources/` vào `process.resourcesPath/resources/` (extraResources)
  - Patch `OpenClaw.exe` metadata (icon, description, publisher) qua `rcedit`
  - Tạo NSIS script → compile installer `.exe`
  - (Tuỳ chọn) Ký code với Authenticode nếu có `CSC_LINK` + `CSC_KEY_PASSWORD`

---

### `typescript@^5.7`

**Vai trò:** Compile TypeScript source (`app/**/*.ts`) → JavaScript (`dist/`).

- **Config:** `tsconfig.json` → `outDir: dist`, `rootDir: app`, `module: Node16`
- **Output:**
  - `app/main/main.ts` → `dist/main/main.js`
  - `app/main/preload.ts` → `dist/main/preload.js`
  - `app/backend/start.ts` → `dist/backend/start.js`
  - `app/backend/config.ts` → `dist/backend/config.js`
  - ...
- **Tại sao `module: Node16`?** openclaw dùng ESM native (`.mjs`, `import`). Electron
  main process cũng chạy Node 22 → `Node16` moduleResolution đúng với ESM + CJS interop.

---

### `concurrently@^9.x`

**Vai trò:** Chạy nhiều lệnh song song trong terminal — dùng cho dev mode.

- **Cách dùng:**
  ```json
  "dev:watch": "concurrently -k \"tsc -p tsconfig.json -w\" \"wait-on dist/main/main.js && electron .\""
  ```
- **Lợi ích:** Khi sửa TypeScript, `tsc -w` recompile → Electron tự reload mà không cần
  chạy 2 terminal riêng.
- **`-k` flag:** Kill tất cả processes khi một process thoát (Ctrl+C thoát cả hai).

---

### `cross-env@^7.x`

**Vai trò:** Set environment variables cross-platform (Windows `cmd` vs Unix `sh`).

- **Cách dùng:**
  ```json
  "dist:nsis": "cross-env CSC_IDENTITY_AUTO_DISCOVERY=false electron-builder --win nsis"
  ```
- **Vấn đề giải quyết:** Trên Windows, không thể dùng `CSC_IDENTITY_AUTO_DISCOVERY=false npm run ...`
  (bash syntax). `cross-env` normalize syntax cho cả Windows và Unix.
- **`CSC_IDENTITY_AUTO_DISCOVERY=false`:** Tắt tự động tìm code-signing certificate
  (tránh lỗi khi build trên máy không có cert Authenticode).

---

### `@types/node@^22.x`

**Vai trò:** TypeScript type definitions cho Node.js built-in APIs.

- **Cung cấp:** Types cho `fs`, `path`, `child_process`, `crypto`, `net`... trong `app/backend/`.
- **Version phải khớp:** `^22.x` để align với Node 22 mà Electron 35 ship.

---

### `wait-on@^8.x` _(optional, dùng trong dev:watch)_

**Vai trò:** Chờ file/port xuất hiện trước khi chạy lệnh tiếp theo.

- **Cách dùng:**
  ```
  wait-on dist/main/main.js && electron .
  ```
- **Vấn đề giải quyết:** `tsc` compile không đồng bộ — `electron .` chạy ngay thì
  `dist/main/main.js` chưa có → crash. `wait-on` poll file system cho đến khi file xuất hiện.

---

## Tóm tắt phân loại

```
dependencies (vào .exe bundle)
├── openclaw@2026.4.5          ← gateway runtime (pinned)
├── @buape/carbon@0.14.0       ← Discord SDK (externalized dep của openclaw)
├── @larksuiteoapi/node-sdk    ← Feishu/Lark SDK (externalized dep của openclaw)
├── electron-updater           ← NSIS auto-update
├── axios                      ← fetch update-notice
└── tree-kill                  ← clean shutdown process tree

devDependencies (chỉ build)
├── electron             ← Chromium+Node runtime (bundled bởi electron-builder)
├── electron-builder     ← packager → .exe
├── typescript           ← compile app/ → dist/
├── concurrently         ← dev:watch multi-process
├── cross-env            ← cross-platform env vars
├── wait-on              ← dev:watch wait for compile
└── @types/node          ← TS types cho Node APIs
```

---

## Version compatibility matrix

| Package                   | Version  | Node yêu cầu    | Ghi chú                                           |
| ------------------------- | -------- | --------------- | ------------------------------------------------- |
| `openclaw`                | 2026.4.5 | ≥ 22.12         | `--experimental-require-module`                   |
| `@buape/carbon`           | 0.14.0   | ≥ 18            | externalized dep của openclaw (Discord extension) |
| `@larksuiteoapi/node-sdk` | 1.60.0   | ≥ 18            | externalized dep của openclaw (Feishu extension)  |
| `electron`                | 35.x     | ships Node 22.x | phải ≥ Node 22.12 cho gateway                     |
| `electron-builder`        | ^25.1    | ≥ 18            | NSIS builder trên Windows                         |
| `electron-updater`        | ^6.x     | ≥ 16            | cần `publish.provider` trong builder config       |
| `typescript`              | ^5.7     | ≥ 18            | `module: Node16`                                  |

---

### Lưu ý về "externalized deps" của openclaw

openclaw đóng gói extension code trong `dist/extensions/<tên>/` và ship kèm
`node_modules/` riêng của từng extension bên trong tarball npm. Tuy nhiên, openclaw
**không khai báo** các package này trong `package.json` của chính nó (`dependencies`).

**Hệ quả với npm v7+:** npm prune tất cả package trong `openclaw/node_modules/` không
có trong dependency graph → gateway crash lúc startup với `Cannot find module`.

**Giải pháp của fork này (2 tầng):**

1. **`postinstall` → `hoist-openclaw-ext-deps.mjs`:** Copy tất cả package từ
   `dist/extensions/*/node_modules/` lên `openclaw/node_modules/` sau mỗi `npm install`.
   Xử lý ~400 packages (AWS SDK, Slack, Telegram, Discord, Feishu...).

2. **Khai báo explicit trong `dependencies`:** `@buape/carbon` và `@larksuiteoapi/node-sdk`
   cần thêm riêng vì chúng bị npm deduplicate ra top-level (không còn trong extension
   node_modules nữa) nhưng top-level version lại là ESM-only và không thể `require()`.

---

## _Cập nhật: 2026-04-12 | Fork openclaw-electron pin v2026.4.5_

---

## Cập nhật 2026-04-13: 52 dependencies thiếu từ upstream

So sánh `package.json` electron wrapper vs upstream `openclaw@2026.4.5` phát hiện 52 packages chưa được khai báo.

**Kết quả kiểm tra thực tế:**
- 51/52 đã có trong `node_modules` qua transitive deps của `openclaw`
- **1 package thực sự thiếu khỏi `node_modules`:** `node-llama-cpp` (peerDependency)

Tất cả 52 đã được thêm vào `package.json` để tránh bị electron-builder prune và đảm bảo tracking rõ ràng.

### Thêm vào `dependencies`

| Package | Version | Mục đích |
|---|---|---|
| `@agentclientprotocol/sdk` | `0.18.0` | ACP agent protocol client |
| `@anthropic-ai/vertex-sdk` | `^0.14.4` | Vertex AI (Google) provider |
| `@aws-sdk/client-bedrock` | `3.1023.0` | AWS Bedrock LLM API |
| `@aws-sdk/client-bedrock-runtime` | `3.1023.0` | AWS Bedrock runtime invoke |
| `@aws-sdk/credential-provider-node` | `3.972.29` | AWS credentials từ env/file |
| `@clack/prompts` | `^1.2.0` | CLI interactive prompts |
| `@line/bot-sdk` | `^10.6.0` | LINE Messaging channel |
| `@mariozechner/pi-agent-core` | `0.65.0` | Pi agent integration |
| `@mariozechner/pi-ai` | `0.65.0` | Pi AI connector |
| `@mariozechner/pi-coding-agent` | `0.65.0` | Pi coding agent |
| `@mariozechner/pi-tui` | `0.65.0` | Pi TUI interface |
| `@modelcontextprotocol/sdk` | `1.29.0` | MCP server/client SDK |
| `@mozilla/readability` | `^0.6.0` | Web page reader (browser tool) |
| `@sinclair/typebox` | `0.34.49` | Runtime type validation |
| `ajv` | `^8.18.0` | JSON schema validator |
| `chalk` | `^5.6.2` | Terminal color output |
| `chokidar` | `^5.0.0` | File watcher |
| `cli-highlight` | `^2.1.11` | Syntax highlight terminal |
| `commander` | `^14.0.3` | CLI argument parsing |
| `croner` | `^10.0.1` | Cron scheduler |
| `dotenv` | `^17.4.0` | `.env` file loading |
| `express` | `^5.2.1` | HTTP server (webhook endpoints) |
| `file-type` | `22.0.0` | Detect file MIME type |
| `gaxios` | `7.1.4` | Google API HTTP client |
| `hono` | `4.12.10` | Lightweight web framework |
| `ipaddr.js` | `^2.3.0` | IP parsing (SSRF guard) |
| `jiti` | `^2.6.1` | TypeScript/ESM runtime loader |
| `json5` | `^2.2.3` | JSON với comments |
| `jszip` | `^3.10.1` | ZIP file handling |
| `linkedom` | `^0.18.12` | DOM parser (headless) |
| `long` | `^5.3.2` | 64-bit integer (Matrix protocol) |
| `markdown-it` | `^14.1.1` | Markdown parser |
| `matrix-js-sdk` | `41.3.0-rc.0` | Matrix chat protocol client |
| `osc-progress` | `^0.3.0` | Progress bar |
| `pdfjs-dist` | `^5.6.205` | PDF rendering |
| `qrcode-terminal` | `^0.12.0` | QR code terminal (WeChat login) |
| `tar` | `7.5.13` | Tar archive |
| `tslog` | `^4.10.2` | Structured logger |
| `undici` | `^8.0.1` | HTTP/2 client (Node.js native) |
| `uuid` | `^13.0.0` | UUID generation |
| `ws` | `^8.20.0` | WebSocket client/server |
| `yaml` | `^2.8.3` | YAML parser |
| `zod` | `^4.3.6` | Runtime schema validation |

### Thêm vào `optionalDependencies`

Native modules hoặc packages rất nặng — đặt optional để không block `npm install` nếu compile fail:

| Package | Version | Lưu ý |
|---|---|---|
| `@homebridge/ciao` | `^1.3.6` | Native mDNS/Bonjour |
| `@lydell/node-pty` | `1.2.0-beta.3` | **Native C++** PTY — cần `electron-rebuild` nếu dùng terminal |
| `@matrix-org/matrix-sdk-crypto-wasm` | `18.0.0` | WASM binary E2EE cho Matrix |
| `@napi-rs/canvas` | `^0.1.89` | **Native N-API** Canvas — peerDep của openclaw |
| `node-edge-tts` | `^1.2.10` | Microsoft Edge TTS API |
| `node-llama-cpp` | `3.18.1` | **Native C++** LLaMA — **package duy nhất thực sự thiếu khỏi node_modules**; peerDep của openclaw |
| `playwright-core` | `1.59.1` | Browser automation ~80MB — cần `playwright install` riêng |
| `sharp` | `^0.34.5` | **Native libvips** image processing |
| `sqlite-vec` | `0.1.9` | **Native** SQLite vector extension |

### Lưu ý build

- **`node-llama-cpp`** và **`@lydell/node-pty`** cần rebuild cho Electron nếu dùng:
  ```bash
  npx electron-rebuild -f -w node-llama-cpp
  npx electron-rebuild -f -w @lydell/node-pty
  ```
- **`playwright-core`** không bundle browser — cần `npx playwright install chromium` sau deploy.
- **`opusscript` version conflict:** `opusscript@0.1.1` trong deps vs `^0.0.8` từ `prism-media` của `@discordjs/voice` — không ảnh hưởng nếu không dùng Discord voice.
- Upstream có 2 optionalDeps chưa add: `@matrix-org/matrix-sdk-crypto-nodejs` (Linux-only) và `openshell` (package nội bộ).

---

## Cập nhật 2026-04-13: Chiến lược ASAR để tăng tốc build/install

### Vấn đề gốc (asar: false)
`asar: false` buộc NSIS xử lý hàng chục nghìn file riêng lẻ → build 10+ phút, install 3-5 phút.

**Phân bố kích thước node_modules:**
| Package | Size |
|---|---|
| `openclaw` | **255 MB** (98 extensions + mỗi extension có node_modules riêng) |
| `pdfjs-dist` | 39 MB |
| `node-llama-cpp` | 32 MB |
| `matrix-js-sdk` | 11 MB |
| `playwright-core` | 10 MB |

### Tại sao không thể `asar: true` thẳng

`openclaw/dist/boundary-file-read-CdxVvait.js` gọi `fs.openSync(path, O_NOFOLLOW)` + `fs.realpathSync` để load extension plugins. Electron's ASAR virtual FS không implement `O_NOFOLLOW` → crash ngay khi gateway khởi động.

### Giải pháp: `asar: true` + `asarUnpack`

```yaml
asar: true
asarUnpack:
  - "node_modules/openclaw/**"   # real FS cho boundary checks
  - "node_modules/**/*.node"     # native binaries không chạy được từ ASAR
```

- Toàn bộ node_modules khác → packed vào `app.asar` (1 file duy nhất)
- openclaw → `app.asar.unpacked/node_modules/openclaw/` (real FS)
- `import.meta.url` trong openclaw resolve đúng vì ASAR tạo symlink → unpacked path

### Các exclusion để giảm kích thước

| Pattern | Lý do |
|---|---|
| `openclaw/dist/extensions/*/node_modules/**` | Đã được hoist lên `openclaw/node_modules/` bởi postinstall — không ship 2 bản |
| `node-llama-cpp/llama/**` | Chỉ cần JS engine, không cần prebuilt model runners |
| `pdfjs-dist/web/**`, `pdfjs-dist/types/**` | Web viewer demo + TS types không cần trong Electron |
| `playwright-core/lib/server/chromium\|firefox\|webkit/**` | Browser drivers không được bundle |
| `**/*.d.ts`, `**/*.test.js`, `**/tests/**` | TypeScript declarations + test files |

---

## _Cập nhật: 2026-04-13 | Thêm 52 deps thiếu từ upstream openclaw@2026.4.5_
