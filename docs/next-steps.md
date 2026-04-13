# Next Steps — 2-Layer Build Pipeline

> Trạng thái: 2026-04-13
> Nhánh: `build-2-layer`

---

## ✅ Đã xong

- [x] Phase 1: Scripts pack/check/manifest/smoke (`scripts/`)
- [x] Phase 2: Runtime split mode + layer updater (`app/main/`)
- [x] Upload 2 tar.gz lên GitHub Release `mankhb2k/openclaw-desktop@v1.0.0`
- [x] Rename app → **OpenClaw Desktop** (package.json + electron-builder.yml)

---

## 🔲 Việc cần làm tiếp theo

### Bước 1 — Generate + push backend-manifest.json *(~5 phút)*

```bash
# Sinh manifest với URL trỏ đúng vào release v1.0.0
npm run layer:manifest -- --release-tag=v1.0.0
```

Sau đó commit file `release/backend-manifest.json` vào **repo này** (`openclaw-desktop`)
nhánh `main`, thư mục `release/`:

```bash
git add release/backend-manifest.json
git commit -m "feat: add backend-manifest.json for 2-layer v1.0.0"
git push origin main   # hoặc merge PR build-2-layer → main trước
```

> App fetch manifest từ:
> `https://raw.githubusercontent.com/mankhb2k/openclaw-desktop/main/release/backend-manifest.json`

---

### Bước 2 — Build EXE mới với tên OpenClaw Desktop *(~10 phút)*

```bash
npm run dist:installer
# Output: release/Openclaw-Desktop-Setup-1.0.0.exe
```

---

### Bước 3 — Test split mode (local, không cần download) *(~5 phút)*

```bash
# Extract layers thẳng vào %APPDATA%\OpenClaw Desktop\backend\
npm run layer:install-local
```

Cài EXE vừa build → khởi động → kiểm tra log:
```
[main] Split mode: using backend from C:\Users\...\AppData\Roaming\OpenClaw Desktop\backend
```

---

### Bước 4 — Test download pipeline (full E2E) *(~15 phút)*

1. Cài EXE sạch (chưa có `backend\` trong userData)
2. Khởi động app → gateway lên bình thường (bundled mode)
3. Sau 10 giây → app tự fetch manifest → download 2 layers
4. Kiểm tra IPC event `backend:layer-update-state` trong DevTools
5. Verify `%APPDATA%\OpenClaw Desktop\backend\node_modules\openclaw\openclaw.mjs` tồn tại
6. Restart app → log hiện split mode

---

### Bước 5 — Loại openclaw khỏi EXE (giảm từ ~414 MB → ~120 MB) *(sau khi Bước 4 pass)*

Thêm vào `electron-builder.yml`:

```yaml
files:
  # ... existing rules ...

  # Loại LAYER OPENCLAW (download riêng)
  - "!node_modules/openclaw/**"

  # Loại LAYER ROOT-RUNTIME (download riêng)
  # Giữ lại NATIVE packages (chúng cần Electron ABI)
  - "!node_modules/electron-updater/**"
  - "!node_modules/axios/**"
  - "!node_modules/tree-kill/**"
  - "!node_modules/@shikijs/**"
  - "!node_modules/shiki/**"
  # ... (toàn bộ ROOT_ONLY list từ check-layer-overlap output)
```

> ⚠️ Chỉ làm bước này sau khi download pipeline đã test xong.
> Nếu loại sớm mà manifest chưa có → app không load được gateway.

---

### Bước 6 — CI/CD workflow (tùy chọn)

Tạo GitHub Actions workflow tự động chạy khi push tag mới:
1. `npm run layer:check`
2. `npm run layer:pack-openclaw` + `npm run layer:pack-root`
3. Upload 2 tar.gz lên GitHub Release
4. Generate + commit `backend-manifest.json` vào `openclaw-1click`
5. `npm run dist:installer` → upload EXE

---

## Thứ tự ưu tiên

```
Bước 1 (manifest) → Bước 2 (build EXE) → Bước 3 (test local) → Bước 4 (test E2E)
                                                                         ↓
                                                               Bước 5 (shrink EXE)
```
