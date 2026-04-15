# OpenClaw Web — Kế hoạch SaaS

> Mô hình chạy OpenClaw trên web, không cần tải về. Người dùng đăng nhập,
> kết nối kênh nhắn tin, AI hoạt động ngay — toàn bộ chạy trên hạ tầng cloud.

---

## 1. Vấn đề cần giải quyết

OpenClaw Desktop yêu cầu:
- Tải `.exe` (~20 MB) + tải backend layer (~17 MB)
- Máy tính phải luôn bật để bot hoạt động
- Không truy cập được từ điện thoại hay thiết bị khác

**OpenClaw Web** giải quyết cả ba điểm trên — mở trình duyệt là dùng được.

---

## 2. Kiến trúc tổng quan

```
┌─────────────────────────────────────────────────────────────────┐
│  Người dùng  →  Browser (Next.js SPA)                           │
│               ↕ HTTPS / WebSocket (WSS)                         │
├─────────────────────────────────────────────────────────────────┤
│  API Gateway  (Nginx / Cloudflare)                              │
│               ↓                                                 │
│  Control Plane  (Node.js / Fastify)                             │
│  - Auth (Lucia / Better-auth)                                   │
│  - Billing (Stripe)                                             │
│  - User provisioning                                            │
│  - Health-check & proxy routing                                 │
├─────────────────────────────────────────────────────────────────┤
│  Gateway Pool  (nhiều OpenClaw Gateway instances)               │
│  - Mỗi user có 1 process / container riêng                      │
│  - Start on-demand, sleep khi không dùng                        │
│  - Kết nối: Telegram, WhatsApp, Discord, Zalo…                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## 3. Mô hình tính toán: Shared VPS vs. Per-user Container

### Phương án A — Shared VPS (nhiều user chung 1 server)

```
VPS 8 vCPU / 16 GB RAM
├── User A  →  Process PID 1001  (openclaw gateway)
├── User B  →  Process PID 1045  (openclaw gateway)
├── User C  →  Process PID 1089  (openclaw gateway)
└── ...     →  ~20–40 gateways cùng lúc (tùy RAM)
```

**Ưu điểm:**
- Chi phí thấp nhất (~$40–80/tháng cho 1 VPS hỗ trợ 20–40 user)
- Đơn giản khi bắt đầu, triển khai nhanh

**Nhược điểm:**
- Process của user A bị crash có thể ảnh hưởng server chung
- Một user "noisy" dùng nhiều CPU làm chậm user khác
- Scaling phức tạp hơn (phải tự cân bằng tải thủ công)
- Dữ liệu các user cùng máy — rủi ro nếu có lỗ hổng bảo mật

**Phù hợp:** Giai đoạn MVP, 0–100 user đầu tiên.

---

### Phương án B — Isolated Container per User (khuyến nghị)

```
Kubernetes Cluster / Docker Swarm
├── Namespace: user-abc123
│   └── Pod: openclaw-gateway (256 MB RAM, 0.25 vCPU)
│       ├── Volume: /data/user-abc123/   (SQLite + config)
│       └── ENV: USER_ID=abc123, API_KEY=...
│
├── Namespace: user-def456
│   └── Pod: openclaw-gateway (256 MB RAM, 0.25 vCPU)
│
└── ... (auto-scale khi cần)
```

**Ưu điểm:**
- Hoàn toàn cô lập — user A không thể ảnh hưởng user B
- Scale tự động (thêm node khi cần)
- Dễ migration dữ liệu, backup per-user
- Dễ enforce resource limit (CPU/RAM) per user/tier
- Compliant hơn (GDPR, SOC2)

**Nhược điểm:**
- Chi phí cao hơn (~$0.5–2/user/tháng tùy tier)
- Cần thêm expertise về Kubernetes / Docker

**Phù hợp:** Từ 100+ user trở lên, hoặc khi cần bán gói có SLA.

---

### Phương án C — Hybrid (thực tế nhất)

```
Tier Free  →  Shared VPS  (resource-limited, sleep after 10 min idle)
Tier Pro   →  Dedicated Container  (always-on, no throttle)
Tier Team  →  Dedicated VPS region  (chọn datacenter, custom domain)
```

Đây là cách Render, Railway, Fly.io đang làm — hiệu quả về chi phí mà vẫn có
upsell path tự nhiên.

---

## 4. Stack kỹ thuật

| Layer | Công nghệ | Lý do chọn |
|-------|-----------|------------|
| **Frontend** | Next.js 15 + Tailwind | App directory, SSR, React Server Components |
| **Auth** | Better-Auth | Hỗ trợ OAuth (Google, GitHub), magic link, session |
| **Control API** | Fastify (Node.js) | Nhẹ, type-safe với JSON Schema, ecosystem tốt |
| **Gateway runner** | OpenClaw (hiện tại) | Không cần viết lại, chỉ cần wrapper |
| **Database (meta)** | PostgreSQL | User accounts, billing, config |
| **Database (user)** | SQLite per user | Portable, không cần PG license, dễ export |
| **File storage** | S3 / R2 | Attachments, backups, layer artifacts |
| **Queue** | BullMQ + Redis | Job scheduling, webhook retry |
| **Proxy** | Nginx + socket.io-proxy | Route WebSocket đến đúng container |
| **Infra** | Hetzner VPS / Fly.io | Giá rẻ, EU datacenter, tốt cho privacy |
| **CI/CD** | GitHub Actions | Đã dùng trong project hiện tại |

---

## 5. Luồng User — Từ đăng ký đến bot hoạt động

```
1. User vào openclaw.web → "Đăng ký"
      ↓
2. Chọn login: Google / Email magic-link / GitHub
      ↓
3. Control Plane tạo user record + provisioning request
      ↓
4. Worker spawn container: openclaw-gateway --user-id=abc123
      ↓  (~10–30 giây)
5. Gateway ready → User thấy Dashboard
      ↓
6. User kết nối kênh: click "Thêm Telegram" → nhập bot token
      ↓
7. Control Plane lưu token (encrypted) → gửi vào gateway qua IPC / REST
      ↓
8. Gateway kết nối Telegram WebSocket → bot sống
      ↓
9. User chat với bot → AI trả lời
      ↓
10. User đóng tab → gateway tiếp tục chạy (always-on hoặc sleep tùy tier)
```

---

## 6. Lưu trữ dữ liệu — Người dùng tự biết dữ liệu ở đâu

### Nguyên tắc thiết kế

- Mỗi user có **1 thư mục riêng biệt** trên storage
- Tất cả dữ liệu user là file có thể **export / download** bất kỳ lúc nào
- Dashboard hiển thị rõ: "Dữ liệu của bạn lưu tại region: EU-Frankfurt"
- Xóa account = xóa toàn bộ dữ liệu trong 30 ngày

### Cấu trúc thư mục per user

```
/data/users/abc123/
├── openclaw.db          ← SQLite: messages, tasks, memory, config
├── config.json          ← Channels config (token encrypted at rest)
├── logs/
│   ├── gateway.log      ← Truncate sau 7 ngày
│   └── audit.log        ← Login, config changes (90 ngày)
├── attachments/         ← Files user gửi/nhận (limit tùy tier)
└── backups/
    └── 2026-04-16.tar.gz
```

### Encryption

```
config.json tokens  →  AES-256-GCM (key per user, stored in KMS)
openclaw.db         →  SQLite encryption extension (SQLCipher) hoặc
                        để plain + encrypt ở volume level (LUKS)
attachments         →  Server-side encryption trên S3/R2
```

### Quyền truy cập dữ liệu — cam kết với người dùng

| Hành động | Có xảy ra không |
|-----------|----------------|
| Staff đọc message chat của bạn | Không — chỉ có bạn và bot |
| AI provider nhận message | Có (OpenAI/Anthropic/...) — hiển thị rõ trong UI |
| Dữ liệu bán cho bên thứ 3 | Không bao giờ |
| Export toàn bộ dữ liệu | Có, bất kỳ lúc nào (1 click) |
| Xóa toàn bộ dữ liệu | Có, ngay lập tức |

---

## 7. Channels — Cái nào chạy được trên Web, cái nào không

### Chạy được 100% trên Web (cloud-side)

| Channel | Lý do |
|---------|-------|
| Telegram | Bot Token API — hoàn toàn cloud, không cần local |
| Discord | Bot API + Gateway — cloud-native |
| WhatsApp | Baileys QR pairing — QR hiện trong browser, sau đó cloud |
| Zalo Bot | Webhook-based — cloud |
| Zalo Personal | QR login — QR hiện trong browser |
| Slack | OAuth app — cloud |
| Google Chat | Webhook — cloud |
| Matrix | Federation protocol — cloud |
| Mattermost | Bot API — cloud |
| IRC | TCP connection — cloud |
| LINE | Bot API — cloud |
| Twitch | IRC over WebSocket — cloud |
| WebChat | Built-in — cloud |

### Cần thiết bị local (KHÔNG thể SaaS hoàn toàn)

| Channel | Lý do |
|---------|-------|
| iMessage (BlueBubbles) | Yêu cầu macOS server chạy local |
| WeChat | Yêu cầu Windows client |
| Signal | signal-cli cần phone number pairing — có thể cloud nhưng số điện thoại phải được pair lần đầu |

> **Giải pháp hybrid:** Cho phép user "kết nối local agent" — install bridge nhỏ
> trên máy Mac/Win, bridge forward vào cloud gateway. Đây là cách Beeper làm.

---

## 8. Roadmap triển khai — 4 giai đoạn

### Giai đoạn 1 — MVP (tuần 1–6)

**Mục tiêu:** 10–20 beta users, shared VPS, tính năng cốt lõi

- [ ] Next.js frontend: đăng ký, đăng nhập, dashboard cơ bản
- [ ] Control API: provision user → spawn gateway process
- [ ] Process manager: PM2 hoặc systemd user units
- [ ] SQLite per user trong `/data/users/{id}/`
- [ ] Channel setup UI: Telegram (đơn giản nhất)
- [ ] Proxy WebSocket từ browser đến đúng gateway
- [ ] Log viewer cơ bản trong dashboard

**Stack tối giản:** 1 VPS Hetzner CX31 (2 vCPU, 8 GB, $15/tháng)

---

### Giai đoạn 2 — Closed Beta (tuần 7–14)

**Mục tiêu:** 50–100 users, thêm kênh, thêm ổn định

- [ ] Thêm channels: WhatsApp, Discord, Zalo
- [ ] Sleep/wake container (free tier ngủ sau 10 phút idle)
- [ ] Backup tự động hàng ngày
- [ ] Export data (zip download)
- [ ] Billing tích hợp Stripe (Free / Pro $9/tháng)
- [ ] Email notification khi gateway crash
- [ ] Status page (uptime.openclaw.ai)

---

### Giai đoạn 3 — Public Launch (tuần 15–24)

**Mục tiêu:** 500+ users, container isolation, multi-region

- [ ] Migration sang Docker Compose per user
- [ ] Health-check auto-restart
- [ ] Multi-region: chọn EU / SEA (Singapore) / US
- [ ] Audit log đầy đủ
- [ ] 2FA (TOTP)
- [ ] Team plan: nhiều user cùng 1 gateway
- [ ] Mobile PWA (add to home screen)

---

### Giai đoạn 4 — Scale (tháng 7+)

- [ ] Kubernetes (K3s) nếu > 1000 users
- [ ] Per-user resource metrics trong dashboard
- [ ] Plugin marketplace từ ClawHub
- [ ] API public (OAuth2) để third-party integrate
- [ ] Self-hosted option: `docker-compose up` cho enterprise

---

## 9. Chi phí ước tính

### Free Tier

| Thành phần | Chi phí |
|------------|---------|
| Gateway ngủ sau 10 phút idle | ~0 CPU khi ngủ |
| Storage: 500 MB | ~$0.01/tháng |
| **Tổng hỗ trợ tối đa** | ~$0.20/user/tháng |

### Pro Tier ($9/tháng)

| Thành phần | Chi phí thực |
|------------|-------------|
| Container always-on (256 MB RAM) | ~$1.5/tháng |
| Storage: 5 GB | ~$0.12/tháng |
| Bandwidth + overhead | ~$0.5/tháng |
| **Margin** | ~$6.88/user/tháng |

### Break-even

- **1 VPS Hetzner CPX41** ($48/tháng, 8 vCPU / 16 GB RAM) = hỗ trợ ~60 always-on Pro users
- Cần 6 Pro users để hòa vốn 1 VPS
- Tại 100 Pro users = ~$900 MRR với chi phí server ~$100 → **margin ~89%**

---

## 10. Vấn đề kỹ thuật cần giải quyết

### 10.1 WebSocket routing

Browser cần WebSocket persistent đến đúng gateway của user đó:

```
Browser  →  wss://app.openclaw.ai/ws/abc123
            ↓ (Nginx upstream_hash by $uri)
Control API  →  proxy to  gateway-abc123:3000
```

Dùng `proxy_pass` với `sticky session` trong Nginx, hoặc dùng
`socket.io` với Redis adapter nếu multi-node.

### 10.2 Token security

API key / bot token của user KHÔNG được lưu plaintext:

```typescript
// Control Plane
const encrypted = await kms.encrypt(userToken, { keyId: `user/${userId}` });
await db.updateChannelConfig(userId, { tokenEnc: encrypted });

// Gateway retrieval
const token = await kms.decrypt(encryptedToken, { keyId: `user/${userId}` });
```

Dùng AWS KMS, Cloudflare KV encryption, hoặc HashiCorp Vault (self-hosted).

### 10.3 WhatsApp QR pairing trong browser

Baileys tạo QR code → cần hiển thị cho user trong trình duyệt:

```
Gateway  →  emit('whatsapp:qr', { qr: base64 })
            ↓ WebSocket
Browser  →  render QR image  →  user scan bằng phone
            ↓ pairing success
Gateway  →  emit('whatsapp:ready')
Browser  →  hiện "WhatsApp đã kết nối ✓"
```

Sau khi pair, session lưu vào `/data/users/{id}/whatsapp-session/` — không cần
scan lại lần sau.

### 10.4 Process lifecycle

```
User login → gateway chưa chạy?
  → Start container (cold start ~5–15s)
  → Health check: GET /health → 200
  → Ready

User không dùng 10 phút (free tier)?
  → Send SIGTERM → graceful shutdown
  → Snapshot state to disk
  → Container removed (tiết kiệm RAM)

User gửi message mới?
  → Wake gateway (cold start lại)
  → Load state from disk
  → Process message
```

---

## 11. Khác biệt với Desktop version

| | Desktop | Web SaaS |
|---|---------|----------|
| Cài đặt | Tải .exe, setup screen | Mở browser, đăng ký |
| Uptime | Phụ thuộc máy user bật | 24/7 trên cloud |
| Data | Local `%AppData%` | Cloud + có thể export |
| Privacy | Cao nhất (local) | Tốt (encrypted) nhưng trust cloud provider |
| iMessage | ✅ | ❌ (cần local bridge) |
| Multi-device | ❌ | ✅ (dùng từ bất kỳ thiết bị) |
| Tự host | ✅ | Có (self-hosted docker option) |
| Chi phí user | Miễn phí (tự host) | Free / $9/tháng |

---

## 12. Kết luận — Nên bắt đầu từ đâu

**Tuần 1–2 (proof of concept):**

1. Tạo 1 VPS Hetzner, cài Docker + Nginx
2. Viết Control API đơn giản: `POST /provision` → spawn `openclaw` process
3. Cắm Next.js dashboard với auth (Better-Auth + email magic link)
4. Test với 3–5 user thật

**Câu hỏi cần quyết định sớm:**
- Region: EU (Frankfurt) hay SEA (Singapore) cho user Việt Nam?
- Tier free có không? Hay chỉ trial 14 ngày?
- Self-hosted tier cho enterprise ngay từ đầu hay để sau?

**Ưu tiên tuyệt đối:** WebSocket proxy + WhatsApp QR trong browser — đây là 2
điểm kỹ thuật khó nhất, giải quyết được là còn lại dễ.
