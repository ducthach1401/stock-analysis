# Stock Analysis

Ứng dụng phân tích kỹ thuật cổ phiếu Việt Nam (VNIndex): đồng bộ giá, phát hiện tín hiệu, khuyến nghị mua/bán, cảnh báo Telegram và giao diện web. Backend **NestJS** + **MySQL** + **Redis** (hàng đợi BullMQ), giao diện tĩnh trong thư mục `public/`.

---

## Tính năng chính

### Dữ liệu giá
- Lấy nến OHLCV từ **DNSE LightSpeed** (chart API công khai, không cần token cho lịch sử).
- Lưu vào MySQL (`stock_prices`), sync theo khoảng thời gian hoặc **full** từ mốc sớm đến hiện tại.
- Sau mỗi lần sync (API, queue, cron) hệ thống **tự chạy phân tích phiên hiện tại** và **backfill tín hiệu lịch sử** (sliding window), không cần bấm thao tác thủ công riêng.

### Watchlist
- Danh sách ~100 mã VNIndex (file `src/scanner/watchlist.ts`), seed khi DB trống.
- **Tự động hàng ngày (07:30):** đồng bộ mã mới / cập nhật tên–ngành từ file chuẩn, rồi **quét thanh khoản** — tắt mã không đạt ngưỡng, bật lại khi đạt (mã tắt thủ công `MANUAL` không bị bật lại tự động).
- Quản lý bật/tắt/xóa mã; ngưỡng thanh khoản giống `SignalService.checkLiquidity` (avg volume, số ngày có giao dịch trong 30 phiên gần nhất).
- Thứ tự ưu tiên khi hiển thị khuyến nghị / dashboard: **vốn hoá & thanh khoản** (thứ tự trong danh sách + `avgVolume`), sau đó **độ tin cậy tín hiệu**, rồi độ mạnh điểm.

### Tín hiệu kỹ thuật
- Phát hiện đa dạng loại: RSI, MACD, Bollinger, EMA cross/stack/bounce, nền, break kháng cự / thủng hỗ trợ, mẫu nến, volume surge, v.v.
- Nhóm **phân phối đỉnh**: phân kỳ RSI/MACD, climax volume, nến phân phối, failed breakout, v.v.
- Lọc mã **thanh khoản tối thiểu** trước khi phân tích.
- API tóm tắt tín hiệu theo watchlist, tín hiệu cho biểu đồ, thống kê lịch sử.
- **Dự báo ngắn hạn** (`GET /scanner/forming-setups`): heuristic các mã có MACD/RSI/EMA/BB *gần* ngưỡng — gợi ý chờ thêm vài nến (không lưu DB, không thay tín hiệu đã xác nhận).

### Khuyến nghị & vị thế
- Gợi ý **MUA / BÁN / GIỮ** kèm **điểm**, **mức độ tin cậy** (HIGH/MEDIUM/LOW), mục tiêu giá khi đủ dữ liệu (chiến lược **không đặt cắt lỗ tự động**).
- Module **vị thế**: mở theo khuyến nghị mạnh, theo dõi P/L, đóng lệnh; tích hợp với cron và Telegram.

### Chiến lược vị thế, trung bình giá (TB) & backtest

Tóm tắt quy tắc đang cài trong code (`src/position/`, `src/position/averaging-policy.ts`, `src/signal/signal-backtest.service.ts`). Chi tiết đầy đủ cũng có trên web: tab **Chiến lược** (`public/index.html`).

#### Vào lệnh đầu
- **STRONG_BUY** và có **nền tốt** hoặc **break** (điều kiện cụ thể trong `allowsFirstPositionEntry` / `allowsFirstPositionEntryFromSignals`).
- Target mặc định **≥ 20%** lên từ giá vào (có thể cao hơn nếu kháng cự / ATR — `POSITION_MIN_UPSIDE_PCT`, `calcPriceTargetForFixedEntry`).
- **Không đặt cắt lỗ (SL) tự động**; **không** thoát theo tín hiệu bán/đảo chiều — chỉ **target**, **chặn lãi** (sàn tối thiểu ~20%, **nâng** khi đỉnh chạy xa — `effectiveProfitFloorPnl`, `PROFIT_TRAIL_FROM_PEAK_PCT`) khi quay đầu, hoặc **đóng tay**.

#### Trung bình giá (TB / TBG)
- **Quy ước khối lượng:** lệnh mở đầu = **`BASE_POSITION_UNITS` (1)** đơn vị chuẩn; **mỗi lần TB chỉ cộng thêm `UNITS_PER_AVERAGE_LEG` (1)** đơn vị (lần 1, 2, 3… đều +1 đơn).
- **Giá vào bình quân** sau mỗi lần TB: `weightedEntryAfterAverageDown` — trung bình **gia quyền** theo đúng số đơn vị (không phải cộng tiền đều mà là **cùng khối lượng mỗi lần**).
- **Tỷ lệ** khối đang nắm so với lần mua mới tại TB thứ **k** là **k : 1** (1:1 → 2:1 → 3:1…).
- Điều kiện TB: lỗ **ít nhất ~10%** so với giá TB (`AVERAGE_DOWN_MIN_LOSS_PCT`, không trần — lỗ sâu vẫn TB nếu đủ điều kiện); có **nền tốt** (`GOOD_BASE_TYPES`: nền đang hình thành, EMA bullish stack, BB squeeze) **hoặc** tín hiệu **hồi phục** (MACD cross, EMA bounce, RSI momentum…); khuyến nghị **BUY**, **STRONG_BUY**, hoặc **HOLD** (khi đã có nền/hồi phục — tránh lỡ TB vì điểm tổng chưa tới BUY); **không** TB khi **SELL** / **STRONG_SELL**; không vượt **`MAX_AVERAGE_DOWN_LEGS` (10)** lần TB.

#### Thoát lệnh (tóm tắt)
- **Chặn lãi** khi giá quay đầu từ đỉnh (không chờ T+2): sàn lãi tối thiểu ~**20%** (`PROFIT_RUN_PCT`), và **cao hơn** nếu đỉnh đã vượt xa (trailing ~**20%** từ giá đỉnh — `PROFIT_TRAIL_FROM_PEAK_PCT`, `effectiveProfitFloorPnl`, `peakPriceSinceOpen`).
- **Chốt target** sau **T+2** khi lãi dưới ngưỡng gồng (đủ phiên kể từ ngày mua đầu — `MIN_TRADING_SESSIONS_AFTER_ENTRY`).
- **Không** đóng vị thế theo tín hiệu bán / **STRONG_SELL** — chỉ mua/TB và chờ target (hoặc chặn lãi như trên).
- **Cuối kỳ backtest:** đóng theo giá phiên cuối nếu vị thế vẫn mở.
- **Một vị thế — bán một lần:** toàn bộ khối (đầu + các lần TB) chốt cùng một lệnh bán trong mô hình hệ thống.

#### Backtest giả lập
- Cùng quy tắc vào / TB / thoát như trên (`SignalBacktestService.runBacktest`).
- Lưu **`averageDownLegs`** (ngày, giá, lý do từng lần TB) trên `SimulatedTrade` để hiển thị timeline trên UI.

#### Giao diện
- Bảng vị thế: cột **Ngày mua** (Đầu + TB1, TB2…), **Trung bình giá**, backtest có cột timeline tương ứng.
- Tab **Chiến lược** trên dashboard: bản đọc nhanh cùng nội dung với README (phần TB).

### Telegram
- Thông báo khi server khởi động (tuỳ cấu hình).
- Cảnh báo biến động giá, tổng hợp **quét tín hiệu**, **khuyến nghị** (MUA / phân phối đỉnh) theo ngày.
- Tin nhắn định dạng HTML; cần `TELEGRAM_BOT_TOKEN` và `TELEGRAM_CHAT_ID`.

### Scanner & lịch (cron)
- **Sync giá** (T2–T6, sau phiên), **quét tín hiệu**, **theo dõi vị thế**, **gửi khuyến nghị**, **cảnh báo intraday** trong giờ giao dịch — múi giờ `Asia/Ho_Chi_Minh`.
- Có thể kích hoạt thủ công qua API hoặc nút trên web (một số tác vụ nặng đưa vào **Redis queue**).

### Hàng đợi (BullMQ)
- Job: sync toàn watchlist / một mã, quét tín hiệu, phân tích lịch sử (toàn danh sách hoặc một mã).
- Theo dõi tiến độ job qua API (`/queue/jobs/:id`).

### Giao diện web (`public/index.html`)
- **Chiến lược**: mô tả quy tắc vị thế / TB / backtest (đồng bộ với README).
- **Dashboard**: tóm tắt tín hiệu watchlist, lịch cron, log thao tác; admin có thể **phân tích lịch sử toàn watchlist** (job BullMQ).
- **Tín hiệu**: biểu đồ nến (Lightweight Charts), RSI, MACD, khuyến nghị, thống kê tín hiệu lịch sử; admin: **Phân tích ngay** (phiên hiện tại), **Tín hiệu quá khứ** / **Cập nhật lịch sử** (backfill qua queue, mặc định từ `2025-01-01`).
- **Giá**: sync từng mã, lịch sử giá đã lưu.
- **Watchlist**: CRUD, kiểm tra thanh khoản.
- Đăng nhập **admin** (JWT) cho các thao tác ghi (sync, queue, watchlist).

### API & bảo mật
- REST JSON; một số endpoint yêu cầu header `Authorization: Bearer <token>` (đăng nhập `/auth/login`).
- Trang chủ tĩnh: `GET /` phục vụ `public/index.html` (cấu hình trong `AppModule`).

---

## Công nghệ

| Thành phần | Mô tả |
|------------|--------|
| Runtime | Node.js, NestJS 11 |
| ORM | TypeORM, MySQL 8 |
| Queue | BullMQ + Redis |
| Chỉ báo | `technicalindicators` |
| HTTP client | Axios (gọi DNSE) |

---

## Biến môi trường

Sao chép `.env.example` thành `.env` và chỉnh các giá trị sau:

| Biến | Ý nghĩa |
|------|---------|
| `PORT` | Cổng HTTP (mặc định 3000) |
| `DB_*` | Kết nối MySQL |
| `REDIS_*` | Redis cho BullMQ |
| `TELEGRAM_*` | Bot Telegram |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` / `JWT_SECRET` | Đăng nhập admin web |

Chi tiết đầy đủ nằm trong `.env.example`.

---

## Chạy dự án

### Cài đặt

```bash
yarn install
```

### Development (máy local, cần MySQL + Redis)

```bash
yarn start:dev
```

### Docker (dev)

```bash
docker compose -f docker-compose.dev.yml up
```

Ứng dụng map cổng `3000` (hoặc `PORT` trong `.env`). Đảm bảo service `app` trỏ đúng host MySQL/Redis trong `.env` (ví dụ `mysql`, `redis` như trong compose).

### Production

```bash
yarn build
yarn start:prod
```

Hoặc dùng PM2: `yarn start:pm2` (xem `ecosystem.config.js`).

---

## Lưu ý

- Phân tích kỹ thuật **không phải** tư vấn đầu tư; chỉ hỗ trợ tham khảo.
- Dữ liệu phụ thuộc nguồn công khai (DNSE); độ trễ và điều chỉnh giá theo cổ tức do phía nhà cung cấp quyết định.

---

## License

UNLICENSED (dự án private).
