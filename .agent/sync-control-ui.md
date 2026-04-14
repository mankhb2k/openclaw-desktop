# Sync Control UI với upstream openclaw

> Tài liệu quy trình đồng bộ `control-ui/` (fork của `openclaw/ui/`) khi upstream có thay đổi.
> Cập nhật: 2026-04-14

---

## 1. Tại sao `src/` và `apps/` tồn tại ở root

### Vấn đề gốc

Trong upstream openclaw, UI nằm ở `openclaw/ui/` và import các file shared từ cùng monorepo:

```
openclaw/                    ← monorepo root
  src/                       ← shared TypeScript source
    gateway/events.ts
    shared/operator-scope-compat.ts
    auto-reply/commands-registry.shared.ts
    ...
  apps/                      ← native apps (iOS, macOS)
    shared/OpenClawKit/.../tool-display.json
  ui/                        ← Control UI package
    src/ui/app-gateway.ts    → import '../../../src/gateway/events.js'
    src/ui/chat/slash-commands.ts → import '../../../../src/auto-reply/...'
```

Các import dùng relative path `../../../src/` từ `ui/src/ui/` leo lên 3 cấp → `openclaw/src/` — **hợp lệ trong monorepo**.

### Trong fork này

Fork đổi tên `ui/` → `control-ui/` và đặt vào `openclaw-desktop/control-ui/`. Kết quả:

```
openclaw-desktop/
  control-ui/                ← forked UI
    src/ui/app-gateway.ts    → import '../../../src/gateway/events.js'
                               → resolve: openclaw-desktop/src/  ← KHÔNG TỒN TẠI
```

Vite (rolldown) không tìm thấy file → build crash 23 lỗi.

### Giải pháp: Directory Junction

Tạo **Windows directory junction** (không cần admin) từ root fork → upstream source:

```
openclaw-desktop/src/   →  openclaw-desktop/.tmp-openclaw-upstream/src/
openclaw-desktop/apps/  →  openclaw-desktop/.tmp-openclaw-upstream/apps/
```

Junction là transparent với Vite — nó đọc file qua đường dẫn `src/` như thể directory thật. Không cần alias trong vite.config.ts, không cần copy file.

**`src/` cung cấp cho build:**
| Path import | File thực tế |
|---|---|
| `../../../src/gateway/events.js` | `upstream/src/gateway/events.ts` |
| `../../../src/shared/operator-scope-compat.js` | `upstream/src/shared/operator-scope-compat.ts` |
| `../../../src/shared/assistant-identity-values.js` | `upstream/src/shared/assistant-identity-values.ts` |
| `../../../../src/auto-reply/commands-registry.shared.js` | `upstream/src/auto-reply/commands-registry.shared.ts` |
| `../../../../src/gateway/control-ui-contract.js` | `upstream/src/gateway/control-ui-contract.ts` |
| _(và ~20 file khác)_ | |

**`apps/` cung cấp cho build:**
| Path import | File thực tế |
|---|---|
| `../../../apps/shared/OpenClawKit/.../tool-display.json` | `upstream/apps/shared/.../tool-display.json` |

**Không commit vào git** — cả hai là junction trỏ vào `.tmp-openclaw-upstream/` (temp dir, trong `.gitignore`).

---

## 2. Các bước sync control-ui với upstream

### Điều kiện tiên quyết

```bash
# Upstream phải được clone về trước
ls .tmp-openclaw-upstream/src/   # phải tồn tại
```

Nếu chưa có:
```bash
npm run clone:upstream
```

---

### Bước 1 — Copy source mới từ upstream `ui/` vào `control-ui/`

```bash
# Xem diff trước để biết upstream thay đổi gì
npm run compare:upstream
```

Sau đó dùng script sync (nếu có) hoặc copy thủ công từng file thay đổi:

```bash
# Copy toàn bộ (cẩn thận — sẽ overwrite local changes)
cp -r .tmp-openclaw-upstream/ui/src/  control-ui/src/
cp -r .tmp-openclaw-upstream/ui/public/  control-ui/public/
```

**Không copy:**
- `ui/vite.config.ts` → fork dùng config riêng (outDir khác, không cần alias)
- `ui/package.json` → fork có dep riêng
- `ui/tsconfig.json` → upstream không có file này; fork tự thêm để transpile decorators (xem lưu ý bên dưới)
- `ui/node_modules/` → không copy bao giờ

> **Lưu ý tsconfig.json:** Fork thêm `control-ui/tsconfig.json` với `experimentalDecorators: true` + `useDefineForClassFields: false`. Nếu thiếu file này, Vite 8/Rolldown emit TC39 decorator syntax nguyên xi (`@customElement` → `@ne(...)`) mà Electron/Chromium chưa enable mặc định → runtime error `Uncaught SyntaxError: Invalid or unexpected token` khi load UI.

---

### Bước 2 — Đảm bảo junction `src/` và `apps/` tồn tại

Junction phải được tạo lại sau mỗi lần xóa thư mục hoặc clone fresh.

```powershell
# Tạo junction src/ → upstream src/
powershell -Command "New-Item -ItemType Junction -Path 'src' -Target '.tmp-openclaw-upstream\src' -Force"

# Tạo junction apps/ → upstream apps/
powershell -Command "New-Item -ItemType Junction -Path 'apps' -Target '.tmp-openclaw-upstream\apps' -Force"
```

**Xác nhận:**
```bash
ls src/gateway/events.ts       # phải tồn tại
ls apps/shared/OpenClawKit/Sources/OpenClawKit/Resources/tool-display.json  # phải tồn tại
```

> **Lưu ý Windows:** Directory junction ≠ symlink. Junction không cần quyền admin nhưng cũng không được track bởi Git. `.gitignore` cần exclude `src/` và `apps/` để tránh git nhầm.

---

### Bước 3 — Cập nhật deps nếu upstream thêm package mới

```bash
# Xem upstream ui/package.json có deps mới không
diff <(node -e "console.log(Object.keys(require('./.tmp-openclaw-upstream/ui/package.json').dependencies || {}).join('\n'))") \
     <(node -e "console.log(Object.keys(require('./control-ui/package.json').dependencies || {}).join('\n'))")

# Nếu có package mới → thêm vào control-ui/package.json rồi:
npm run ui:install
```

---

### Bước 4 — Build và kiểm tra

```bash
npm run ui:build
# Output: vendor/control-ui/index.html + assets/
```

Nếu build thất bại với lỗi `UNRESOLVED_IMPORT`:
- Lỗi `../../../src/...` → junction `src/` bị thiếu (chạy lại Bước 2)
- Lỗi `../../../apps/...` → junction `apps/` bị thiếu (chạy lại Bước 2)
- Lỗi khác → upstream có import mới vào directory chưa được junction → xác định thư mục và tạo junction tương tự

Nếu build thành công nhưng UI crash runtime với `Uncaught SyntaxError: Invalid or unexpected token`:
- Kiểm tra `control-ui/tsconfig.json` còn tồn tại và có `"experimentalDecorators": true`
- Nếu mất → tạo lại (upstream sync có thể đã xóa nhầm)

---

## 3. Quy trình đầy đủ khi upstream bump version

```bash
# 1. Clone/update upstream
npm run clone:upstream          # clone fresh, hoặc git pull trong .tmp-openclaw-upstream

# 2. Xem thay đổi UI
npm run compare:upstream        # diff giữa fork và upstream

# 3. Merge thay đổi vào control-ui/
#    (manual review — không blindly overwrite để giữ customization)

# 4. Đảm bảo junctions
powershell -Command "New-Item -ItemType Junction -Path 'src' -Target '.tmp-openclaw-upstream\src' -Force"
powershell -Command "New-Item -ItemType Junction -Path 'apps' -Target '.tmp-openclaw-upstream\apps' -Force"

# 5. Install deps
npm run ui:install

# 6. Build
npm run ui:build                # → vendor/control-ui/

# 7. Test build output
npx serve vendor/control-ui -p 8080
# Mở browser: http://localhost:8080
# Nhập Gateway URL: ws://127.0.0.1:18789/
```

---

## 4. Tại sao không dùng Vite alias thay vì junction

Đã thử `resolve.alias` trong vite.config.ts:

```ts
resolve: {
  alias: {
    [path.resolve(here, '../src')]: path.resolve(here, '../.tmp-openclaw-upstream/src'),
  }
}
```

**Không hoạt động** với Vite 8 + rolldown vì:
- Rolldown so sánh alias key với **import specifier raw** (`../../../src/...`)
- Khi thư mục `src/` không tồn tại, rolldown fail ở bước resolve path trước khi kiểm tra alias
- Cần thư mục vật lý (hoặc junction) để file system resolution hoạt động

Directory junction là giải pháp tầng thấp nhất, không phụ thuộc vào config build tool.

---

## 5. Những gì cần thêm vào `.gitignore`

```gitignore
# Windows directory junctions trỏ vào .tmp-openclaw-upstream/
# (tạo bằng: powershell New-Item -ItemType Junction ...)
/src/
/apps/
```

---

## 6. Checklist trước mỗi lần commit control-ui

```markdown
- [ ] `control-ui/tsconfig.json` tồn tại và có `"experimentalDecorators": true`
- [ ] junction `src/` tồn tại và trỏ đúng vào `.tmp-openclaw-upstream/src/`
- [ ] junction `apps/` tồn tại và trỏ đúng vào `.tmp-openclaw-upstream/apps/`
- [ ] `npm run ui:build` → không có lỗi
- [ ] `vendor/control-ui/index.html` đã được tạo
- [ ] `vendor/control-ui/` KHÔNG commit vào git (`.gitignore` đã exclude)
- [ ] `control-ui/src/` thay đổi được review — không bao gồm local customization bị overwrite
```
