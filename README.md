# 🤖 TechBot — Trợ lý AI Tài liệu Kỹ thuật

Chatbot AI hỗ trợ phân tích tài liệu kỹ thuật, bản vẽ CAD, Excel vật tư.

**Stack:** HTML + CSS + JS · Vercel Serverless Functions · Groq API · Gemini API

---

## 📁 Cấu trúc thư mục

```
techbot/
├── index.html        ← Toàn bộ giao diện chatbot
├── api/
│   └── chat.js       ← Backend serverless: gọi Groq / Gemini
├── vercel.json       ← Cấu hình routing Vercel
├── package.json      ← Metadata project
├── .gitignore        ← Bảo vệ API key khỏi GitHub
├── .env.example      ← Mẫu biến môi trường (an toàn để commit)
└── README.md         ← File này
```

---

## ✅ BƯỚC 1 — Lấy API Key (miễn phí)

### Groq API — BẮT BUỘC
1. Truy cập: https://console.groq.com/keys
2. Đăng ký bằng Google (miễn phí)
3. Nhấn **"Create API Key"** → đặt tên bất kỳ
4. Copy key có dạng: `gsk_xxxxxxxxxxxxxxxxxxxx`

### Gemini API — TÙY CHỌN (phân tích ảnh, PDF)
1. Truy cập: https://aistudio.google.com/app/apikey
2. Nhấn **"Create API key"**
3. Copy key có dạng: `AIzaSyxxxxxxxxxxxxxxxxx`

---

## ✅ BƯỚC 2 — Đưa lên GitHub

### 2.1 Tạo repository mới trên GitHub
1. Vào https://github.com → đăng nhập
2. Nhấn nút **"+"** góc trên phải → **"New repository"**
3. Đặt tên: `techbot`
4. Để **Public** (hoặc Private tùy bạn)
5. **KHÔNG** tick "Add a README" (đã có sẵn)
6. Nhấn **"Create repository"**

### 2.2 Push code từ máy lên GitHub

Mở **Terminal** (Windows: Git Bash hoặc CMD), vào thư mục project:

```bash
# Di chuyển vào thư mục techbot
cd đường/dẫn/đến/techbot

# Khởi tạo git
git init

# Thêm tất cả file (file .env.local sẽ bị bỏ qua tự động)
git add .

# Commit đầu tiên
git commit -m "feat: khởi tạo TechBot chatbot"

# Kết nối với GitHub (thay TÊN_BẠN bằng username GitHub của bạn)
git remote add origin https://github.com/TÊN_BẠN/techbot.git

# Đặt nhánh chính là main
git branch -M main

# Push lên GitHub
git push -u origin main
```

> 💡 **Lưu ý:** File `.env.local` (chứa API key thật) đã có trong `.gitignore` — sẽ KHÔNG bao giờ bị push lên GitHub. An toàn 100%.

---

## ✅ BƯỚC 3 — Deploy lên Vercel

### 3.1 Kết nối Vercel với GitHub
1. Vào https://vercel.com
2. Nhấn **"Sign Up"** → chọn **"Continue with GitHub"**
3. Cấp quyền cho Vercel truy cập GitHub

### 3.2 Import project
1. Nhấn **"Add New..."** → **"Project"**
2. Tìm repo `techbot` trong danh sách → nhấn **"Import"**
3. Vercel tự nhận `vercel.json` — giữ nguyên mọi cài đặt
4. Nhấn **"Deploy"**
5. Chờ ~30 giây → ✅ Deploy thành công!

URL của bạn sẽ là: `https://techbot-xxx.vercel.app`

### 3.3 Thêm API Keys vào Vercel ← QUAN TRỌNG

> API keys phải được thêm vào Vercel, không viết trong code!

1. Vào **Vercel Dashboard** → chọn project `techbot`
2. Nhấn tab **"Settings"** → **"Environment Variables"**
3. Thêm lần lượt từng biến:

| Name | Value | Environment |
|------|-------|-------------|
| `GROQ_API_KEY` | `gsk_xxxx...` (key của bạn) | ✅ All |
| `GEMINI_API_KEY` | `AIza...` (nếu có) | ✅ All |

4. Nhấn **"Save"** sau mỗi biến
5. Vào tab **"Deployments"** → nhấn **"..."** → **"Redeploy"**

✅ **Xong!** Chatbot đã hoạt động với AI thật.

---

## 🔄 Cập nhật code sau này

Mỗi lần bạn chỉnh sửa `index.html` hoặc `api/chat.js`:

```bash
git add .
git commit -m "fix: mô tả thay đổi của bạn"
git push
```

Vercel tự động detect thay đổi và redeploy trong ~30 giây. Không cần làm gì thêm!

---

## 🧪 Test trên máy Local (không bắt buộc)

```bash
# 1. Tạo file .env.local từ mẫu
cp .env.example .env.local
# Mở .env.local → điền API keys thật vào

# 2. Cài Vercel CLI
npm install -g vercel

# 3. Chạy giả lập môi trường Vercel
vercel dev

# 4. Mở trình duyệt: http://localhost:3000
```

---

## ❓ Xử lý lỗi thường gặp

| Lỗi hiển thị | Nguyên nhân | Cách sửa |
|---|---|---|
| `GROQ_API_KEY chưa được cấu hình` | Chưa set env var trên Vercel | Xem Bước 3.3 rồi Redeploy |
| `HTTP 401` | API key sai hoặc hết hạn | Tạo key mới trên Groq |
| `HTTP 429` | Vượt giới hạn miễn phí | Groq free: 30 req/phút, chờ 1 phút |
| Trang trắng sau deploy | Vercel chưa nhận `vercel.json` | Kiểm tra file `vercel.json` có trong repo |
| CORS error khi mở file HTML trực tiếp | Không qua server | Phải dùng `vercel dev` hoặc deploy |

---

## 📦 Bước tiếp theo — Đóng gói .exe (Windows App)

Sau khi web chạy ổn trên Vercel, có thể đóng gói thành app desktop bằng Electron.  
Hỏi TechBot để được hướng dẫn chi tiết!
