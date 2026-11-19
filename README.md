# Cờ Vua 3D Online

Game cờ vua 3D trực tuyến 2 người chơi chạy trực tiếp trên trình duyệt, sử dụng mô hình 3D `chess_set.glb`, **Three.js (`0.160.0`)**, **Node.js (ESM) + Express + Socket.IO** và **chess.js** làm bộ luật authoritative phía server.

---

## Tính năng chính

- **Đấu online qua link phòng**: truy cập `/new` để tạo phòng ngẫu nhiên và tự chuyển tới `/room/:id`. Người 1 cầm quân Trắng, người 2 cầm quân Đen, người thứ 3 trở đi vào vai **Khán giả** (tối đa 20 khán giả/phòng).
- **Authoritative server**: toàn bộ nước đi và đồng hồ được kiểm tra & quyết định trên server bằng `chess.js` và `server/clock.js`; lưu trạng thái phòng trong bộ nhớ `Map` (không cần database).
- **Reconnect / Reload giữ ghế**: định danh `playerId` lưu trong `localStorage`, tải lại trang hoặc rớt mạng tạm thời vẫn quay lại đúng ghế và nhận đầy đủ FEN, lịch sử nước đi, đồng hồ và đoạn chat.
- **Đầy đủ luật cờ vua**: nhập thành, bắt tốt qua đường (*en passant*), phong cấp (hộp chọn Hậu/Xe/Tượng/Mã), chiếu, chiếu hết, stalemate, thiếu quân chiếu hết, lặp lại thế cờ 3 lần và luật 50 nước.
- **Đồ họa 3D & tương tác mượt**:
  - Chuẩn hóa tự động lưới 8×8 từ `public/models/chess_set.glb` (mỗi ô `1×1`, pivot đặt ở đáy quân, chia sẻ `BufferGeometry` & `Material` qua `clone()`).
  - Hỗ trợ cả chuột & cảm ứng (**chạm-chạm** và **kéo-thả**), tô sáng ô chọn / nước đi hợp lệ / ô bắt quân / nước đi cuối / ô Vua bị chiếu.
  - Camera tự xoay đúng phía quân (Đen tự lật góc nhìn), `OrbitControls` giới hạn zoom và góc không chui xuống dưới bàn.
  - Animation đường cong (Mã nhảy cao hơn), quân bị bắt thu nhỏ & mờ dần, nhập thành chạy đồng thời cả Vua & Xe, sóng sáng khi chiếu/chiếu hết.
- **Đồng hồ cờ, Đầu hàng, Xin hòa, Tái đấu**:
  - 5 chế độ chọn khi tạo phòng: `3+2`, `5+0`, `10+0`, `15+10`, và `Không giới hạn`.
  - Hết giờ xử thua, trừ khi đối thủ không đủ quân chiếu hết thì xử hòa.
  - Đầu hàng có hộp xác nhận; Xin hòa gửi lời mời cho đối thủ chấp nhận hoặc từ chối; Tái đấu đổi màu Trắng ↔ Đen.
- **Chat realtime & Âm thanh Web Audio API**:
  - Chat giữa 2 người chơi (giới hạn 200 ký tự, chống spam rate limit, escape HTML chống XSS).
  - Âm thanh tổng hợp hoàn toàn bằng Web Audio API (không cần file âm thanh ngoài), chỉ khởi tạo `AudioContext` sau tương tác đầu tiên, có nút bật/tắt âm.

---

## Công nghệ sử dụng

- **Server**: Node.js (ESM) + Express + Socket.IO + `chess.js`
- **Client**: Three.js (`0.160.0` pinned) + `GLTFLoader` + `OrbitControls` + `RoomEnvironment` + `socket.io-client` + `chess.js`
- **Bundler**: **Vite** (đóng gói gọn các thư viện từ `node_modules` không phụ thuộc CDN ngoài, đồng bộ phiên bản giữa client/server, hỗ trợ HMR ở dev thông qua Express middleware trên cùng 1 cổng, và build tĩnh `dist/` cho production).

---

## Cấu trúc thư mục

```text
web-game-chess/
├── index.html                  # Trang entry của client
├── vite.config.js              # Cấu hình Vite (tách chunk vendor)
├── package.json                # Dependencies & npm scripts
├── public/
│   └── models/
│       ├── chess_set.glb       # Mô hình gốc 145 MB (giữ ở local, đã đưa vào .gitignore)
│       └── chess_set_opt.glb   # Bản tối ưu 6.03 MB dùng để chạy & deploy web
├── render.yaml                 # Cấu hình Render Blueprint (deploy 1 bước)
├── scripts/
│   ├── inspect-glb.mjs         # Script kiểm tra cấu trúc GLB (Bước 0)
│   └── optimize-glb.mjs        # Script nén/tối ưu model từ 145 MB -> 6.03 MB
├── server/
│   ├── index.js                # Express + Socket.IO + rate limit + phục vụ Vite/dist
│   ├── roomManager.js          # Quản lý phòng trong Map, luật cờ, chat, reconnect
│   └── clock.js                # Đồng hồ authoritative, kiểm tra đủ quân chiếu hết
└── client/
    ├── main.js                 # Điều phối ứng dụng (Lobby / Online / Local)
    ├── scene.js                # Scene 3D, ánh sáng, môi trường, camera, OrbitControls
    ├── pieces.js               # Tải/chuẩn hóa GLB, quản lý 32 quân, animation & highlight
    ├── input.js                # Raycaster chuột & cảm ứng (chạm-chạm & kéo-thả)
    ├── ui.js                   # Panel bên cạnh, đồng hồ nội suy, phong cấp, chat, modal
    ├── audio.js                # Tổng hợp âm thanh Web Audio API
    ├── net.js                  # Kết nối Socket.IO & định danh localStorage
    └── styles.css              # Giao diện tối & responsive mobile
```

---

## Cài đặt & chạy Local

### Yêu cầu
- **Node.js 18+** (khuyến nghị Node.js LTS 20/22/26).

### 1. Cài đặt thư viện
```bash
npm install
```

### 2. Chạy chế độ phát triển (Dev)
```bash
npm run dev
```
Máy chủ chạy tại **`http://localhost:3000`** (Express + Socket.IO tích hợp sẵn Vite middleware trên cùng 1 cổng).

### 3. Chạy chế độ Production trên máy cá nhân
```bash
npm run build
npm start
```

### 4. Kiểm tra lại cấu trúc file model GLB (tùy chọn)
```bash
npm run inspect-glb
```

---

## Hướng dẫn mở 2 tab để chơi thử trên 1 máy

1. Mở trình duyệt tới **`http://localhost:3000`**, nhập tên hiển thị, chọn chế độ đồng hồ (ví dụ `3+2` hoặc `10+0`) rồi bấm **Tạo phòng mới** (hoặc mở trực tiếp `http://localhost:3000/new`).
2. Bạn sẽ được chuyển tới `http://localhost:3000/room/<mã-phòng>` ở ghế **Quân Trắng**. Bấm **Copy link**.
3. Để đóng vai người chơi thứ 2 (**Quân Đen**), chọn một trong hai cách:
   - **Cách khuyên dùng**: Mở một **cửa sổ Ẩn danh (Incognito)** hoặc trình duyệt khác và dán link phòng vừa copy.
   - **Mở nhanh tab thường cùng trình duyệt**: Dán link phòng vào tab thứ 2. Do 2 tab thường dùng chung `localStorage`, tab cũ sẽ hiện thông báo trùng phiên — chỉ cần bấm nút **"Vào với tư cách người chơi mới (Tab test)"** là tab đó lập tức chuyển sang ghế **Quân Đen** (dùng `sessionStorage` riêng cho tab).
4. Mở thêm một cửa sổ ẩn danh thứ 3 vào cùng link nếu muốn kiểm tra chế độ **Khán giả**.
5. Bấm **F5 (Reload)** ở bất kỳ tab người chơi nào để kiểm tra tính năng khôi phục ghế ngồi, bàn cờ, đồng hồ và lịch sử chat.
6. Muốn tự chơi 2 bên trên cùng 1 máy mà không cần tạo phòng: mở **`http://localhost:3000/local`**.

---

## Ghi chú thiết kế & Quy tắc vận hành

- **Quyền của Khán giả**: Người thứ 3 trở đi vào phòng sẽ ở chế độ Khán giả — xem được bàn cờ, nước đi, đồng hồ và đọc tin nhắn chat realtime, nhưng **không được đi cờ**, **không được đầu hàng/xin hòa** và **không được gửi tin nhắn chat**.
- **Chính sách xử lý khi một bên rớt mạng giữa ván**:
  - **15 giây đầu tiên (grace period)**: server tự động **tạm dừng đồng hồ** để người chơi reload trang hoặc chập chờn mạng không bị mất thời gian oan.
  - **Sau 15 giây**: nếu vẫn chưa kết nối lại, đồng hồ **chạy tiếp** và mở bộ đếm **60 giây bỏ cuộc** (tổng cộng 75 giây từ lúc rớt mạng). Quá 75 giây mà không quay lại, server xử người rớt mạng thua do bỏ cuộc (`abandonment`).
  - Nếu kết nối lại kịp thời, bộ đếm được hủy và ván cờ tiếp tục bình thường.
- **Dọn bộ nhớ server**: phòng trống hoàn toàn quá **15 phút** hoặc không có hoạt động quá **2 giờ** sẽ tự động được dọn khỏi `Map`.

---

## Hướng dẫn Deploy (Render / Railway / Fly.io)

### Tại sao KHÔNG dùng Vercel / Netlify Serverless?
Game sử dụng **Socket.IO (WebSocket kết nối liên tục)** và lưu trạng thái phòng/đồng hồ **trong bộ nhớ RAM (`Map`)** của tiến trình Node.js. Các nền tảng serverless như Vercel hay Netlify Functions chạy theo từng request ngắn hạn, không duy trì WebSocket bền vững và không chia sẻ chung bộ nhớ RAM giữa các lần gọi. Do đó bạn cần deploy lên nền tảng chạy **container / tiến trình Node.js liên tục (long-running server)** như **Render**, **Railway** hoặc **Fly.io** (chạy 1 instance duy nhất vì state nằm trong RAM).

### Model 3D khi Deploy (`chess_set_opt.glb` — 6.03 MB)
- File gốc `public/models/chess_set.glb` (145.35 MB) đã được đưa vào `.gitignore` để không vượt giới hạn 100 MB của GitHub.
- Dự án dùng trực tiếp bản tối ưu **`public/models/chess_set_opt.glb` (6.03 MB — giảm 95.9%)** tạo từ `npm run optimize-glb`: đẩy thẳng lên GitHub bình thường (không cần Git LFS) và người chơi mở web chỉ mất ~1–2 giây kể cả trên 4G/điện thoại.
- Có thể đổi đường dẫn model bất cứ lúc nào bằng biến môi trường `VITE_MODEL_URL`.

### 1. Deploy lên Render (Miễn phí, khuyên dùng)
1. Đẩy dự án lên GitHub (file `render.yaml` đã được cấu hình sẵn).
2. Vào [Render Dashboard](https://dashboard.render.com/) → chọn **New +** → **Blueprint** (hoặc **Web Service**) → kết nối tới repo GitHub của bạn.
3. Nếu chọn **Blueprint**, Render tự đọc [render.yaml](render.yaml) và điền sẵn toàn bộ cấu hình:
   - **Runtime**: `Node`
   - **Plan**: `Free`
   - **Build Command**: `npm install && npm run build`
   - **Start Command**: `npm start`
   - **Health Check Path**: `/health`
   - **Instance Count**: `1` (bắt buộc giữ `1` để mọi người chơi vào chung 1 bộ nhớ phòng)
4. Bấm **Apply / Create Web Service**, chờ khoảng 2 phút là có link HTTPS công khai dạng `https://web-game-chess.onrender.com` để gửi cho bạn bè chơi ngay!
   *(Lưu ý: gói Free của Render tự ngủ sau 15 phút không có truy cập; lần mở đầu sau khi ngủ sẽ chờ ~30 giây để khởi động lại.)*

### 2. Deploy lên Railway
1. Vào [Railway](https://railway.app/) → **New Project** → **Deploy from GitHub repo**.
2. Trong mục **Settings → Build & Deploy**:
   - **Build Command**: `npm install && npm run build`
   - **Start Command**: `npm start`
   - **Healthcheck Path**: `/health`
3. Mở mục **Networking → Generate Domain** để lấy tên miền HTTPS (hỗ trợ sẵn WSS cho Socket.IO).

### 3. Deploy lên Fly.io
1. Cài [flyctl](https://fly.io/docs/flyctl/install/) và đăng nhập (`fly auth login`).
2. Tạo nhanh `Dockerfile` tối giản (Node 20 Alpine, `npm ci`, `npm run build`, `CMD ["npm", "start"]`) rồi chạy:
   ```bash
   fly launch --no-deploy
   ```
3. Đảm bảo trong `fly.toml` đặt `internal_port = 3000` (hoặc khớp biến `PORT`), chỉ giữ 1 machine (`min_machines_running = 1`), sau đó chạy:
   ```bash
   fly deploy
   ```

# chess-game
