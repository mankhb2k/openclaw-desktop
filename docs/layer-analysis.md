# Phân Tích Layer Strategy — openclaw-desktop

> Phiên bản phân tích: 2026-04-13  
> Dựa trên: `openclaw@2026.4.5`, `electron@35.7.5`, `node_modules` thực tế đo trên máy build

---

## Mục lục

1. [Số liệu thực tế](#1-số-liệu-thực-tế)
2. [Cấu trúc node_modules thực tế](#2-cấu-trúc-node_modules-thực-tế)
3. [Phân loại toàn bộ packages](#3-phân-loại-toàn-bộ-packages)
4. [Kết luận kiến trúc layer](#4-kết-luận-kiến-trúc-layer)
5. [Đề xuất 2-layer strategy](#5-đề-xuất-2-layer-strategy)
6. [Quy tắc bắt buộc để maintain](#6-quy-tắc-bắt-buộc-để-maintain)
7. [CI/CD checklist trước mỗi release](#7-cicd-checklist-trước-mỗi-release)
8. [backend-manifest.json schema](#8-backend-manifestjson-schema)

---

## 1. Số liệu thực tế

```
node_modules/ tổng cộng (đã đo):     2705 MB
  ├─ Trong đó là devDependencies:     ~515 MB   (không ship, chỉ dùng để build)
  │    electron, app-builder-bin, app-builder-lib, 7zip-bin, typescript...
  ├─ @node-llama-cpp prebuilds:        711 MB   (binary assets, bị loại bởi exclusion)
  └─ Còn lại cần ship:               ~1100 MB   (ước tính sau exclusions)
       ├─ openclaw/                    954 MB
       ├─ native modules (root):        ~90 MB
       └─ root-runtime packages:        ~90 MB
```

**Kích thước sau khi nén tar.gz (ước tính):**

| Layer | Uncompressed | Compressed (~60%) | Ghi chú |
|---|---|---|---|
| NATIVE (trong EXE) | ~90 MB | — | Pre-built binaries, nén kém |
| ROOT-RUNTIME | ~90 MB | ~35 MB | Pure JS, nén tốt |
| OPENCLAW | ~954 MB | ~350–400 MB | JS + binaries trộn lẫn |
| **Tổng download** | **~1044 MB** | **~385–435 MB** | Lần đầu cài |

---

## 2. Cấu trúc node_modules thực tế

### openclaw là package nguyên khối chiếm 85% dung lượng

```
node_modules/openclaw/                           954 MB TỔNG
├── openclaw.mjs                                (entry point)
├── dist/                                       161 MB
│   ├── index.js + bundle code
│   └── extensions/                            (code các extension)
│       ├── amazon-bedrock/node_modules/         7 MB
│       ├── amazon-bedrock-mantle/node_modules/  6 MB
│       ├── diffs/node_modules/                 27 MB  ← lớn nhất
│       ├── discord/node_modules/               24 MB
│       ├── feishu/node_modules/                17 MB
│       ├── slack/node_modules/                  9 MB
│       └── telegram/node_modules/               3 MB
│
└── node_modules/                               778 MB  ← KHÔNG thể tách
    ├── @lancedb/                               137 MB  (vector DB)
    ├── koffi/                                   40 MB  (FFI)
    ├── @jimp/ + jimp/                          ~70 MB  (image processing)
    ├── @napi-rs/                                43 MB
    ├── pdfjs-dist/                              39 MB
    ├── @mariozechner/                           32 MB
    ├── @lydell/                                 30 MB  (bản copy trong openclaw)
    ├── @opentelemetry/                          25 MB
    ├── @larksuiteoapi/                          24 MB
    ├── typescript/                              23 MB  (dùng cho jiti runtime)
    ├── @matrix-org/                             21 MB
    ├── @img/                                    19 MB
    ├── @google/                                 14 MB
    ├── web-streams-polyfill/                     9 MB
    ├── openai/                                   7 MB
    ├── react-dom/                                7 MB
    └── ...nhiều packages nhỏ hơn
```

### Root node_modules sau khi loại bỏ devDeps và openclaw

```
node_modules/ (root, không tính openclaw, devDeps, @node-llama-cpp)
├── NATIVE BINARIES (phải bundle trong EXE):
│   ├── @lydell/         30 MB   ← node-pty, cần pre-build Electron ABI
│   ├── @napi-rs/        37 MB   ← canvas, cần pre-build Electron ABI
│   ├── @matrix-org/     21 MB   ← matrix-sdk-crypto-wasm
│   ├── node-llama-cpp   32 MB   ← optional, cần pre-build (hoặc bỏ)
│   ├── sharp             1 MB   ← native binding
│   └── sqlite-vec       <1 MB   ← native binding
│
└── ROOT-RUNTIME (download layer riêng):            ~90 MB
    ├── @shikijs/ + shiki                 11 MB
    ├── @larksuiteoapi                    27 MB   ← bản root, khác với trong openclaw
    ├── @aws-sdk/* (các packages bổ sung)  9 MB
    ├── @slack/                            4 MB
    ├── grammy + @grammyjs/                2 MB
    ├── discord-api-types                  3 MB
    ├── @buape/carbon                      7 MB
    ├── @pierre/                           6 MB
    ├── electron-updater                   1 MB
    ├── axios, tree-kill                   2 MB
    └── ...90+ packages nhỏ (type defs, utilities)
```

---

## 3. Phân loại toàn bộ packages

### 3.1 NATIVE — Phải bundle trong EXE shell (không download)

Pre-built binaries cho **Electron 35.7.5 / win32-x64 cụ thể**.  
Sai Electron version → crash ngay khi load.

| Package | Root size | Lý do native |
|---|---|---|
| `@lydell/node-pty` | 30 MB | C++ binding, terminal emulation |
| `@napi-rs/canvas` | 37 MB | C++ binding, canvas rendering |
| `@matrix-org/matrix-sdk-crypto-wasm` | 21 MB | WASM binary |
| `node-llama-cpp` | 32 MB | C++ binding, local LLM (optional) |
| `sharp` | 1 MB | C++ binding, image processing |
| `sqlite-vec` | <1 MB | C++ binding, vector search |
| `@homebridge/ciao` | <1 MB | Native network binding |
| `@snazzah/davey-linux-x64-gnu` | — | Linux only, skip trên Windows |

> **Lưu ý**: `@napi-rs/canvas` và `@lydell/node-pty` tồn tại ở **cả root lẫn bên trong `openclaw/node_modules/`**. Bản trong root là phiên bản đã pre-build cho Electron. Bản trong openclaw/node_modules là để openclaw tự dùng. Đây là 2 bản khác nhau — không được xóa bản nào.

---

### 3.2 OPENCLAW — Layer download lớn nhất, thay đổi mỗi release

**Toàn bộ `node_modules/openclaw/` là 1 atomic unit.**

Không thể tách `openclaw/dist/` khỏi `openclaw/node_modules/` vì:
- `openclaw/dist/extensions/*.js` import trực tiếp từ `openclaw/node_modules/`
- Script `hoist-openclaw-ext-deps.mjs` copy packages từ `openclaw/dist/extensions/*/node_modules/` vào `openclaw/node_modules/`
- Nếu split, import paths bị vỡ

```
Layer OPENCLAW bao gồm:
  node_modules/openclaw/          954 MB uncompressed
                                  ~380 MB compressed
  
Thay đổi khi: openclaw bump version (mỗi release của upstream)
Không thay đổi khi: chỉ thay đổi Electron shell code
```

---

### 3.3 ROOT-RUNTIME — Layer nhỏ, thay đổi ít

Packages khai báo trong **root `package.json`** nhưng **không phải** openclaw direct deps và **không phải** native binaries.

Đây là 2 nhóm chính:

**Nhóm A — Extension SDKs được hoist thủ công:**  
Các packages này xuất hiện trong root vì `hoist-openclaw-ext-deps.mjs` cần chúng ở top level, hoặc vì root `package.json` khai báo explicit để pin version.

```
@slack/bolt, @slack/oauth, @slack/socket-mode, @slack/web-api
grammy, @grammyjs/runner, @grammyjs/transformer-throttler, @grammyjs/types
@larksuiteoapi/node-sdk
@buape/carbon
discord-api-types
@line/bot-sdk (bản root)
```

**Nhóm B — Packages hỗ trợ Electron shell và renderer:**

```
electron-updater       ← dùng trong app/main/main.ts
axios                  ← dùng trong app/main/main.ts (fetch update notice)
tree-kill              ← dùng trong app/main/main.ts (kill backend process)
```

**Nhóm C — Utilities và type definitions:**

```
@shikijs/*, shiki           ← syntax highlighting
@aws-sdk/* (bổ sung)        ← credential providers không có trong openclaw deps
@aws/bedrock-token-generator
@types/*                    ← TypeScript declarations
@pierre/diffs, @pierre/theme
bottleneck, dequal, grammy helpers
micromark-util-*, unist-util-*, vfile*, hast-util-*  ← markdown pipeline
mpg123-decoder, opusscript, silk-wasm               ← audio codecs
...và ~60 packages nhỏ khác
```

---

### 3.4 Packages bị trùng giữa root và openclaw deps (WITH_OC)

Đây là **47 packages** khai báo ở cả root `package.json` lẫn `openclaw/package.json`:

```
@agentclientprotocol/sdk    @anthropic-ai/vertex-sdk
@aws-sdk/client-bedrock     @aws-sdk/client-bedrock-runtime
@aws-sdk/credential-provider-node
@clack/prompts              @mariozechner/pi-{agent-core,ai,coding-agent,tui}
@modelcontextprotocol/sdk   @mozilla/readability
@sinclair/typebox           ajv, chalk, chokidar, cli-highlight
commander, croner, dotenv   express, file-type, gaxios
hono, ipaddr.js, jiti       json5, jszip, linkedom, long
markdown-it, matrix-js-sdk  osc-progress, pdfjs-dist
playwright-core             qrcode-terminal, tar, tslog
undici, uuid, ws, yaml, zod
```

**Tại sao trùng?** Khi chạy `npm install`, npm hoist các packages này lên root `node_modules/` để cả Electron shell và openclaw gateway có thể resolve. Root `package.json` khai báo explicit để pin version khớp với openclaw.

**Hệ quả cho layer strategy:**  
Các packages này **đi cùng với LAYER OPENCLAW** — khi openclaw update version của chúng, root `package.json` cũng phải update theo. Chúng **không được** đưa vào ROOT-RUNTIME layer.

---

## 4. Kết luận kiến trúc layer

### Tại sao không làm được 3+ layers như Docker?

Docker có layer cache hiệu quả vì mỗi layer được build độc lập bằng Dockerfile instructions. Với npm packages, `openclaw` tự bundle toàn bộ deps của mình vào `openclaw/node_modules/`. Ta **không kiểm soát** được nội dung bên trong đó mà không fork openclaw.

```
Docker image:                          Backend bundle:
  Layer: ubuntu base    (stable)         Tương đương: không có
  Layer: node:22        (stable)         Tương đương: không có  
  Layer: base-deps      (stable)    ←→   KHÔNG THỂ TÁCH khỏi openclaw
  Layer: openclaw       (changes)        Layer OPENCLAW (toàn bộ 954 MB)
```

### Điều gì thực sự có thể tách ra?

```
Có thể tách:  ✓ Native binaries → bundle vào EXE (không bao giờ download)
              ✓ Root-runtime (~90 MB) → layer riêng, update hiếm
              ✗ Bên trong openclaw/ → không thể tách

Kết quả thực tế:
  Update openclaw mới nhất = vẫn phải tải ~380 MB
  Tiết kiệm so với full-bundle tar.gz = chỉ ~35 MB (root-runtime layer)
```

---

## 5. Đề xuất 2-layer strategy

Dựa trên phân tích thực tế, **2 layers** là đủ và tối ưu cho repo này:

```
┌────────────────────────────────────────────────────────────────────┐
│  LAYER NATIVE — Bundled trong EXE (không bao giờ download)         │
│  Kích thước đóng góp vào EXE: ~90 MB                               │
├────────────────────────────────────────────────────────────────────┤
│  @lydell/node-pty              30 MB   pre-built Electron 35 ABI  │
│  @napi-rs/canvas               37 MB   pre-built Electron 35 ABI  │
│  @matrix-org/matrix-sdk-..     21 MB   WASM binary                │
│  node-llama-cpp                32 MB   optional, hoặc loại hẳn    │
│  sharp                          1 MB   pre-built                   │
│  sqlite-vec                    <1 MB   pre-built                   │
│                                                                     │
│  Thay đổi khi: Electron version bump                               │
│  Không bao giờ: update riêng mà không build EXE mới               │
└────────────────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────────────┐
│  LAYER ROOT-RUNTIME — Download 1 lần (~35 MB nén)                  │
│  Kích thước uncompressed: ~90 MB                                   │
├────────────────────────────────────────────────────────────────────┤
│  Tất cả ROOT_ONLY packages (xem mục 3.3)                           │
│  electron-updater, axios, tree-kill (Electron-specific)            │
│  KHÔNG bao gồm: openclaw/, native binaries, devDependencies        │
│  KHÔNG bao gồm: WITH_OC packages (chúng nằm trong OPENCLAW layer) │
│                                                                     │
│  Thay đổi khi: root package.json có package mới không liên quan    │
│                đến openclaw (rất hiếm, vài tháng 1 lần)           │
└────────────────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────────────┐
│  LAYER OPENCLAW — Download lần đầu + mỗi khi openclaw release      │
│  Kích thước: ~954 MB uncompressed / ~380 MB compressed             │
├────────────────────────────────────────────────────────────────────┤
│  node_modules/openclaw/ (toàn bộ, nguyên khối)                     │
│  Bao gồm: dist/, node_modules/, openclaw.mjs, docs/, assets/       │
│                                                                     │
│  Thay đổi khi: openclaw bump version                               │
│  Sau khi extract: BẮT BUỘC chạy hoist-openclaw-ext-deps.mjs       │
└────────────────────────────────────────────────────────────────────┘
```

### Thứ tự extract bắt buộc

```
1. Extract LAYER ROOT-RUNTIME
       → dataRoot/backend/node_modules/  (merge, không xóa)

2. Extract LAYER OPENCLAW
       → dataRoot/backend/node_modules/openclaw/  (thay thế hoàn toàn)

3. Chạy hoist-openclaw-ext-deps.mjs
       → copy packages từ openclaw/dist/extensions/*/node_modules/
         vào openclaw/node_modules/ (nếu chưa có)

4. Khởi động gateway với:
       OPENCLAW_APP_ROOT = dataRoot/backend/
```

### Lợi ích thực tế của 2-layer

| Tình huống | Full single bundle | 2-layer |
|---|---|---|
| Cài lần đầu | Tải 1 file ~415 MB | Tải 2 file ~380+35 = 415 MB (như nhau) |
| Update chỉ openclaw | Tải ~415 MB | Tải ~380 MB (tiết kiệm 35 MB) |
| Update chỉ root deps | Tải ~415 MB | Tải ~35 MB (**tiết kiệm 380 MB**) |
| Electron version bump | Build EXE mới | Build EXE mới (như nhau) |

> **Nhận xét thực tế**: Lợi ích chính là khi có hotfix root deps mà không cần update openclaw. Trường hợp này hiếm nhưng khi xảy ra sẽ tiết kiệm đáng kể cho user.

---

## 6. Quy tắc bắt buộc để maintain

### RULE-01 — Native layer gắn chặt với Electron version

```
TRIGGER: electron version thay đổi trong package.json

BẮT BUỘC:
  □ Rebuild toàn bộ native modules trên CI với đúng Electron ABI mới
  □ Tăng version của EXE shell (không chỉ backend layers)
  □ Cập nhật electronVersion trong backend-manifest.json
  □ Test smoke: spawn gateway sau khi install EXE mới

CẤM:
  □ Không được release chỉ LAYER OPENCLAW khi Electron đã đổi version
  □ Không được copy native binaries từ build khác Electron version
```

---

### RULE-02 — Layer OPENCLAW là atomic unit, không được tách

```
TRIGGER: muốn tối ưu dung lượng LAYER OPENCLAW

BẮT BUỘC:
  □ Giữ nguyên cấu trúc thư mục openclaw/ khi đóng gói
  □ Không xóa openclaw/node_modules/ để "tiết kiệm" (sẽ vỡ import)
  □ Không xóa openclaw/docs/ nếu openclaw.mjs reference tới docs/

ĐƯỢC PHÉP loại bỏ theo electron-builder.yml đang có:
  □ openclaw/dist/extensions/*/node_modules/ (đã hoist lên openclaw/node_modules/)
  □ openclaw/docs/ (nếu verify không cần thiết tại runtime)
  □ Các file *.map, *.d.ts, test/ bên trong openclaw/
```

---

### RULE-03 — hoist script phải chạy sau mỗi lần extract LAYER OPENCLAW

```
TRIGGER: extract LAYER OPENCLAW hoàn tất

BẮT BUỘC (theo thứ tự):
  1. Verify openclaw/openclaw.mjs tồn tại sau extract
  2. Chạy: node scripts/hoist-openclaw-ext-deps.mjs
  3. Verify ít nhất 1 package đã được hoist (log "copied X")
  4. Chỉ sau đó mới khởi động gateway

TẠI SAO: extensions trong openclaw/dist/extensions/*/node_modules/
          (@slack/web-api, grammy, discord-api-types...) phải được copy
          vào openclaw/node_modules/ thì gateway mới resolve được.
          Thiếu bước này → "Cannot find module '@slack/web-api'" crash.
```

---

### RULE-04 — WITH_OC packages không được vào LAYER ROOT-RUNTIME

```
47 packages được khai báo ở cả root package.json lẫn openclaw/package.json:
  matrix-js-sdk, pdfjs-dist, ws, hono, express, zod, yaml...

Những packages này:
  ✓ Được npm hoist lên root node_modules/ tự động khi npm install
  ✓ Nằm trong LAYER OPENCLAW (đi kèm với openclaw/)
  ✗ KHÔNG được thêm vào tar.gz của LAYER ROOT-RUNTIME
  
Lý do: nếu LAYER ROOT-RUNTIME chứa ws@8.x nhưng LAYER OPENCLAW
        mang theo ws@9.x → khi extract OPENCLAW sau, ws@9.x đè lên.
        Nhưng nếu thứ tự ngược lại → ws@8.x đè ws@9.x → gateway lỗi.

Kiểm tra trước mỗi release:
  node scripts/check-layer-overlap.mjs
```

---

### RULE-05 — Semantic version cho từng layer độc lập

```
backend-manifest.json phải track version RIÊNG cho từng layer:

  layers.root-runtime.version  → string bất kỳ, tăng khi nội dung thay đổi
  layers.openclaw.version      → phải KHỚP với openclaw npm version

Quy tắc tăng version:
  - root-runtime: dùng số nguyên đơn giản "1", "2", "3"...
                  tăng mỗi khi có package mới/update trong ROOT_ONLY group
  - openclaw:     luôn bằng đúng openclaw@version trong package.json
                  VD: "2026.4.5" → "2026.4.6"

KHÔNG được:
  - Dùng cùng 1 version string khi nội dung đã thay đổi
  - Tăng version mà không rebuild và upload lại tar.gz
```

---

### RULE-06 — Atomic extract, không partial state

```
Quy trình update LAYER OPENCLAW (thứ tự bắt buộc):

  1. Tải vào: dataRoot/backend-dl/layer-openclaw-vX.tar.gz.partial
  2. Verify SHA-256 (từ manifest)
  3. Extract vào: dataRoot/backend-new/node_modules/openclaw/
  4. Chạy hoist script trong dataRoot/backend-new/
  5. Smoke test: node -e "require('./node_modules/openclaw')" (nếu được)
  6. Dừng gateway cũ (treeKill)
  7. Rename: backend/ → backend-old/
  8. Rename: backend-new/ → backend/
  9. Khởi động gateway mới
  10. Nếu gateway ready trong 30s: xóa backend-old/
      Nếu không ready: rollback (xem RULE-07)

CẤM:
  □ Extract thẳng vào backend/ đang chạy
  □ Xóa backend-old/ trước khi gateway mới confirmed ready
```

---

### RULE-07 — Rollback tự động khi gateway không khởi động được

```
Điều kiện trigger rollback:
  - Gateway không listen trên port sau 30 giây
  - Gateway process exit với code !== 0 trong 10 giây đầu

Quy trình rollback:
  1. treeKill(gateway.pid)
  2. Rename: backend/ → backend-broken-{timestamp}/
  3. Rename: backend-old/ → backend/
  4. Khởi động lại gateway từ backend-old
  5. Ghi log lỗi vào dataRoot/logs/update-failure.log
  6. Gửi IPC 'backend:update-failed' với thông tin version + error

Sau rollback:
  - Xóa backend-broken-{timestamp}/ sau 24h (dọn dẹp)
  - Hiện thông báo cho user với link báo bug
  - Không tự động retry update (chờ user trigger)
```

---

### RULE-08 — Không dùng npmjs.com làm download source

```
Tất cả tar.gz layers PHẢI được host trên GitHub Releases của repo:
  github.com/Mankhb2k/openclaw-1click/releases/

Lý do:
  - npmjs.com có rate limit và downtime
  - npm tarball format có thể thay đổi
  - Cần đảm bảo availability cho user không có npm cache
  - SHA-256 verify phải match với artifact do CI tạo ra, không phải npm registry

KHÔNG được:
  - Tải thẳng từ registry.npmjs.org
  - Hardcode URL cdn.jsdelivr.net hoặc unpkg.com
```

---

## 7. CI/CD checklist trước mỗi release

### Khi chỉ update openclaw version

```bash
# 1. Cập nhật package.json
npm install openclaw@2026.x.y

# 2. Kiểm tra packages bị overlap giữa layers
node scripts/check-layer-overlap.mjs
# Expected output: "No overlap found between ROOT-RUNTIME and OPENCLAW layers"

# 3. Build layer OPENCLAW (loại bỏ exclusions như electron-builder.yml)
node scripts/pack-layer-openclaw.mjs
# Output: release/layer-openclaw-v2026.x.y.tar.gz

# 4. Generate manifest mới (chỉ update openclaw version, giữ root-runtime version)
node scripts/generate-backend-manifest.mjs --openclaw-only

# 5. Smoke test layers
node scripts/smoke-test-layers.mjs
# Expected: gateway starts trong < 15 giây

# 6. Upload lên GitHub Release
# Upload: layer-openclaw-v2026.x.y.tar.gz + backend-manifest.json
```

### Khi update root packages (hiếm)

```bash
# 1. Cập nhật package.json, chạy npm install
# 2. Kiểm tra overlap
node scripts/check-layer-overlap.mjs

# 3. Build LAYER ROOT-RUNTIME
node scripts/pack-layer-root-runtime.mjs
# Output: release/layer-root-runtime-v{N+1}.tar.gz

# 4. Generate manifest mới (tăng root-runtime version)
node scripts/generate-backend-manifest.mjs --root-only

# 5. Upload layer-root-runtime-v{N+1}.tar.gz + backend-manifest.json
```

### Khi Electron version thay đổi

```bash
# 1. Cập nhật electron version trong package.json
# 2. npm install để lấy native modules mới

# 3. BẮT BUỘC rebuild EXE với native modules mới
npm run dist:nsis

# 4. BẮT BUỘC rebuild CẢ 2 layers (native ABI thay đổi)
node scripts/pack-layer-openclaw.mjs
node scripts/pack-layer-root-runtime.mjs

# 5. Cập nhật electronVersion trong manifest
node scripts/generate-backend-manifest.mjs --all --electron-version=36.x.y

# 6. Upload TẤT CẢ: EXE + blockmap + latest.yml + cả 2 layers + manifest
```

---

## 8. backend-manifest.json schema

```json
{
  "schemaVersion": 2,
  "generatedAt": "2026-04-13T00:00:00.000Z",

  "electronVersion": "35.7.5",
  "platform": "win32",
  "arch": "x64",

  "layers": {
    "root-runtime": {
      "version": "1",
      "sha256": "<sha256-of-tar.gz>",
      "url": "https://github.com/Mankhb2k/openclaw-1click/releases/download/v1.0.0/layer-root-runtime-v1.tar.gz",
      "compressedBytes": 36700160,
      "uncompressedBytes": 94371840,
      "extractTo": "node_modules",
      "requiresHoist": false,
      "changedFrom": null
    },
    "openclaw": {
      "version": "2026.4.5",
      "sha256": "<sha256-of-tar.gz>",
      "url": "https://github.com/Mankhb2k/openclaw-1click/releases/download/v1.0.0/layer-openclaw-v2026.4.5.tar.gz",
      "compressedBytes": 398458880,
      "uncompressedBytes": 999292928,
      "extractTo": "node_modules",
      "requiresHoist": true,
      "hoistScript": "scripts/hoist-openclaw-ext-deps.mjs",
      "changedFrom": "2026.4.4"
    }
  },

  "extractOrder": ["root-runtime", "openclaw"],

  "minAppVersion": "1.0.0",
  "releaseNotes": {
    "vi": "Cập nhật openclaw lên 2026.4.5",
    "en": "Update openclaw to 2026.4.5"
  }
}
```

### Giải thích các fields quan trọng

| Field | Mục đích |
|---|---|
| `schemaVersion` | Versioning của manifest format, để Electron biết cách parse |
| `electronVersion` | Lock với Electron version — nếu không khớp, từ chối update |
| `extractOrder` | Thứ tự extract bắt buộc (root-runtime trước, openclaw sau) |
| `requiresHoist` | Nếu `true`, Electron phải chạy hoist script sau extract |
| `changedFrom` | Version trước đó — dùng để log và hiển thị changelog |
| `minAppVersion` | Version EXE tối thiểu cần để dùng layers này |

---

## Tóm tắt cuối cùng

```
THỰC TẾ DỰ ÁN NÀY:
  ✓ 2 layers là đủ và tối ưu
  ✓ Layer strategy không giúp nhiều vì openclaw chiếm 85% dung lượng
  ✓ Lợi ích thực sự: native modules trong EXE (không re-download),
                     và root-runtime layer update cực hiếm (~35 MB)
  ✓ Mỗi lần openclaw release → user vẫn phải tải ~380 MB
  
KHÔNG NÊN LÀM:
  ✗ Cố tách openclaw/dist/ khỏi openclaw/node_modules/ → sẽ vỡ
  ✗ Làm 3+ layers → overhead không tương xứng với lợi ích
  ✗ Bỏ qua hoist script → extension integrations crash
  ✗ Dùng npm install trên máy user → cần build tools, chậm, unreliable

ĐIỀU KIỆN ĐỂ LAYER STRATEGY HOẠT ĐỘNG HOÀN HẢO:
  □ CI tự động hóa hoàn toàn: build → pack → sha256 → upload → manifest
  □ Smoke test tự động sau mỗi pack
  □ Không bao giờ upload manifest trước khi tar.gz đã có trên Release
  □ Giữ backend-old/ cho đến khi gateway mới confirmed healthy
```
