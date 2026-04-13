# Scripts — openclaw-electron

> Tài liệu tất cả lệnh npm script và utility scripts trong project.

---

### `clone:upstream`

```
npm run clone:upstream -- <tag>
```

**Khi nào chạy:** Thủ công bởi maintainer khi cần tải/mở gói mã nguồn upstream (ví dụ: trước khi chạy `compare:upstream` hoặc để xem diff của một tag mới).

**Làm gì:** Tải và unpack mã nguồn openclaw cho tag được chỉ định vào thư mục tạm `.tmp-openclaw-upstream/`.

**Tại sao cần:** Cung cấp một bản sao sạch của upstream để so sánh với `node_modules/openclaw/` — giúp phát hiện breaking changes trước khi nâng version hoặc merge thay đổi.

**Cách dùng:**

- `npm run clone:upstream -- v2026.4.5` — truyền tag có tiền tố `v`.
- `npm run clone:upstream -- 2026.4.5` — truyền tag không có `v` (script sẽ tự thêm `v` nếu cần).

**Fallback:** Nếu không truyền tag, script sẽ lần lượt dùng `openclaw-src.ref.json` (`upstreamTag`) rồi `openclaw-version.pin` để xác định tag mặc định.

**Output ví dụ:**

```
.tmp-openclaw-upstream/ (unpacked source)
Downloaded: openclaw-v2026.4.5.tgz
```

## npm scripts (`package.json`)

Chạy bằng `npm run <script>`.

---

### `postinstall`

```
node scripts/hoist-openclaw-ext-deps.mjs
```

**Khi nào chạy:** Tự động sau mỗi `npm install` — không gọi trực tiếp.

**Làm gì:** Hoist tất cả package từ `node_modules/openclaw/dist/extensions/*/node_modules/`
lên `node_modules/openclaw/node_modules/`. Giải quyết vấn đề npm v7+ không còn tự hoist
các package bundled trong tarball openclaw.

**Tại sao cần:** openclaw ship ~400 extension deps (Slack, Discord, Feishu, Telegram, AWS…)
bên trong tarball nhưng không khai báo trong `dependencies` của chính nó. npm v7+ prune chúng
→ gateway crash `Cannot find module`. Script này mirror lại behavior cũ của npm.

**Output ví dụ:**

```
[hoist] @slack/web-api ← dist/extensions/slack/node_modules/
[hoist] @buape/carbon ← dist/extensions/discord/node_modules/
[hoist-openclaw-ext-deps] done — copied 412, skipped 0 (already present).
```

---

### `verify:pin`

```
node scripts/verify-pin.mjs
```

**Làm gì:** Kiểm tra version openclaw khớp giữa 3 nguồn:

1. `openclaw-version.pin` (file pin cố định)
2. `package.json` dependencies
3. `node_modules/openclaw/package.json` (installed version)

**Dùng khi:** Trước khi build để chắc chắn đang dùng đúng version openclaw đã pin.
CI có thể gọi script này để fail build nếu version bị drift.

---

### `pin:write`

```
node scripts/pin-version.mjs
```

**Làm gì:** Ghi snapshot version hiện tại:

- `openclaw-version.pin` — version string (ví dụ: `2026.4.5`)
- `openclaw-src.ref.json` — metadata: version, install date, npm registry checksum

**Dùng khi:** Sau khi nâng version openclaw, gọi để cập nhật file pin trước khi commit.

---

### `sync:src`

```
node scripts/sync-src.mjs
```

**Làm gì:** (Planned) Sync source files từ openclaw-app upstream vào fork.

**Trạng thái:** Script `scripts/sync-src.mjs` chưa được tạo. Placeholder cho workflow
đồng bộ code từ repo gốc.

---

### `compare:upstream`

```
node scripts/compare-upstream.mjs
```

**Làm gì:** So sánh nội dung `.tmp-openclaw-upstream/` với `node_modules/openclaw/` để
phát hiện diff giữa upstream mới nhất và version đang dùng.

**Dùng khi:** Trước khi nâng version openclaw — xem có breaking changes nào ảnh hưởng
đến fork không.

---

### `build:ts`

```
tsc -p tsconfig.json
```

**Làm gì:** Compile toàn bộ TypeScript source (`app/**/*.ts`) → JavaScript (`dist/`).

**Output:**

```
dist/
├── backend/
│   ├── config.js
│   ├── ports.js
│   ├── process-registry.js
│   └── start.js
├── main/
│   ├── app-icon.js
│   ├── electron-runner.js
│   ├── main.js
│   └── preload-control-ui.js
└── shared/
    ├── paths.js
    └── spawn-cwd.js
```

**Dùng khi:** Trước khi build production (`dist:nsis`, `dist:portable`). Phải chạy
thành công (0 errors) trước khi electron-builder đóng gói.

---

### `build:ts:watch`

```
tsc -p tsconfig.json -w
```

**Làm gì:** Compile TypeScript ở watch mode — tự recompile khi file thay đổi.

**Dùng khi:** Dev độc lập (không cần Electron reload). Ít dùng hơn `dev`.

---

### `dev`

```
concurrently -k "tsc -p tsconfig.json -w" "wait-on dist/main/main.js && electron ."
```

**Làm gì:** Chạy song song:

1. `tsc -w` — watch và recompile TypeScript
2. `wait-on dist/main/main.js` — chờ file compile xong lần đầu
3. `electron .` — khởi động Electron app

**Flag `-k`:** Kill cả hai process khi Ctrl+C (hoặc khi một process thoát).

**Dùng khi:** Development — sửa TypeScript và thấy thay đổi ngay.

**Lưu ý:** Electron không tự reload khi TypeScript recompile (chỉ compile JS được update).
Cần restart Electron thủ công sau khi `tsc -w` recompile xong.

---

### `dist:nsis`

```
cross-env CSC_IDENTITY_AUTO_DISCOVERY=false electron-builder --win nsis
```

**Làm gì:** Build NSIS installer cho Windows x64.

**Output:** `release/OpenClaw-Desktop-Setup-1.0.0.exe`

**`CSC_IDENTITY_AUTO_DISCOVERY=false`:** Tắt tự động tìm Authenticode certificate.
Không có flag này thì build sẽ fail trên máy không có cert ký code.

**Điều kiện:** `dist/` phải tồn tại (đã chạy `build:ts` trước).

---

### `dist:portable`

```
cross-env CSC_IDENTITY_AUTO_DISCOVERY=false electron-builder --win portable
```

**Làm gì:** Build portable executable cho Windows x64 (không cần cài đặt).

**Output:** `release/OpenClaw-Portable-1.0.0.exe`

**Khác NSIS:** Portable không hỗ trợ auto-update NSIS (`phase: 'unsupported'`).
Người dùng tải file mới thủ công.

---

### `dist:all`

```
cross-env CSC_IDENTITY_AUTO_DISCOVERY=false electron-builder --win
```

**Làm gì:** Build cả NSIS installer lẫn portable exe trong một lần chạy.

**Output:**

```
release/
├── OpenClaw-Desktop-Setup-1.0.0.exe   ← NSIS installer
└── OpenClaw-Portable-1.0.0.exe       ← Portable exe
```

**Dùng khi:** Release chính thức — muốn tạo cả hai artifact cùng lúc.

---

## Utility scripts (`scripts/`)

Gọi trực tiếp bằng `node scripts/<file>` hoặc qua npm script tương ứng.

---

### `scripts/hoist-openclaw-ext-deps.mjs`

**Mục đích:** Giải quyết vấn đề npm v7+ không hoist extension deps của openclaw.

**Cơ chế:**

1. Scan `node_modules/openclaw/dist/extensions/` — tìm tất cả subdirectory
2. Trong mỗi extension dir, liệt kê tất cả package trong `node_modules/` (bao gồm scoped `@scope/name`)
3. Copy từng package sang `node_modules/openclaw/node_modules/<pkg>` nếu chưa tồn tại ở đó
4. Không overwrite — skip nếu đã có (an toàn để chạy nhiều lần)

**Xử lý scoped packages:** `@slack/web-api` → tạo `@slack/` dir trước rồi copy `web-api/`

**Không làm:** Không symlink (Windows compatibility), không overwrite versions.

**Gọi bởi:** `postinstall` npm hook sau mỗi `npm install`.

---

### `scripts/verify-pin.mjs`

**Mục đích:** Đảm bảo version openclaw nhất quán giữa `openclaw-version.pin`,
`package.json`, và installed package.

**Exit code:**

- `0` — tất cả 3 nguồn khớp nhau
- `1` — có drift giữa các nguồn (print diff và fail)

**Dùng trong CI:** Thêm vào pipeline để detect vô tình nâng version.

---

### `scripts/pin-version.mjs`

**Mục đích:** Snapshot version openclaw hiện tại vào các file pin.

**Ghi:**

- `openclaw-version.pin` — version string thuần (ví dụ: `2026.4.5`)
- `openclaw-src.ref.json` — JSON với `version`, `pinnedAt`, `integrity`

**Workflow nâng version:**

```bash
npm install openclaw@<new-version>
npm run pin:write
git add openclaw-version.pin openclaw-src.ref.json package.json package-lock.json
git commit -m "chore: pin openclaw to <new-version>"
```

---

### `scripts/compare-upstream.mjs`

**Mục đích:** Diff nội dung openclaw upstream mới nhất với version đang dùng.

**Yêu cầu:** Thư mục `.tmp-openclaw-upstream/` phải tồn tại (unpack tarball upstream vào đó trước).

**Workflow:**

```bash
# Unpack upstream tarball vào .tmp-openclaw-upstream/
npm pack openclaw@latest --dry-run  # hoặc tải tarball về rồi unpack
node scripts/compare-upstream.mjs   # xem diff
```

---

## Thứ tự thực hiện điển hình

### Lần đầu setup

```bash
npm install          # cài deps + chạy postinstall (hoist)
npm run verify:pin   # kiểm tra version pin
npm run build:ts     # compile TypeScript
```

### Build release

```bash
npm run build:ts     # compile trước
npm run dist:all     # build NSIS + portable
```

### Development

```bash
npm run dev          # tsc watch + electron
```

### Nâng version openclaw

```bash
npm install openclaw@<new>
npm run pin:write
npm run verify:pin
npm run build:ts && npm run dist:all
```

---

_Cập nhật: 2026-04-12 | Fork openclaw-electron pin v2026.4.5_
