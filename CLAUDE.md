# CLAUDE.md — Stock Analysis (ghi chú cho AI)

File này tóm tắt kiến trúc + quy tắc nghiệp vụ **theo code thực tế** (đọc ngày 2026-09-20, nhánh `staging`).
Khi README/tab "Chiến lược" mâu thuẫn với file này, **tin code** (xem mục "Chỗ lệch đã biết").
Ngôn ngữ dự án: comment, log, tin Telegram, UI đều bằng **tiếng Việt**; giữ nguyên phong cách khi sửa.

## 1. Dự án là gì

Ứng dụng phân tích kỹ thuật cổ phiếu VN (VNIndex) + phái sinh VN30: đồng bộ giá từ DNSE, phát hiện tín hiệu,
khuyến nghị MUA/BÁN, mở/theo dõi vị thế, backtest, cảnh báo Telegram, dashboard web.

- Backend: NestJS 11, TypeORM + MySQL 8, BullMQ + Redis, `@nestjs/schedule` (cron), Ogma logger, JWT admin.
- Chỉ báo: `technicalindicators` (ATR, RSI, MACD, BB...), phần còn lại tự tính.
- Frontend: tĩnh trong `public/` — `index.html` (~5.000 dòng), `js/app.js` (~5.200 dòng, Alpine `app()`),
  `js/config.js`, `js/ticker-picker.js`, Tailwind/Alpine/lightweight-charts vendor sẵn, PWA (`sw.js`, `manifest.json`).
  8 tab: dashboard, market, derivatives, scanner, signals, stocks, watchlist, guide (Chiến lược).
- Múi giờ nghiệp vụ luôn là `Asia/Ho_Chi_Minh`.

## 2. Lệnh thường dùng

```bash
yarn start:dev          # nest --watch (cần MySQL + Redis, xem .env)
yarn build && yarn start:prod
yarn format:check && yarn lint:check   # = yarn prepush
yarn test               # jest (chỉ 2 spec: minervini-strategy, telegram-notify-policy)
yarn backtest:vn30 | analytics:derivatives | analytics:stocks   # script trong scripts/
docker compose -f docker-compose.dev.yml up
```

Deploy: push nhánh `staging` → `.github/workflows/deploy-staging.yml` SSH vào server → `git pull --ff-only` →
`deploy.sh` (`docker-compose build/down/up -d`). `.husky/pre-push` hiện là `exit 0` (không chặn gì).
Không có `ci.yml` trong repo dù README nhắc. `package.json` có script `db:reset-market*` trỏ tới
`scripts/reset-market-data.sh` nhưng **file này không tồn tại**.

## 3. Cấu trúc `src/`

| Thư mục | Vai trò |
|---|---|
| `app/` | `AppModule` (Config, Bull, Ogma, ServeStatic `public/`, TypeORM, Schedule). `synchronize` = true nếu không phải production hoặc `DB_SYNCHRONIZE=true` |
| `auth/` | Login admin (`ADMIN_USERNAME/PASSWORD`, `JWT_SECRET`), `JwtAuthGuard` cho mọi endpoint ghi |
| `stock/` | `DnseService` (gọi DNSE chart API), `StockService` (sync giá, `syncHistorySmart`, `syncIntradaySessionBar`, cache intraday), entity `StockPrice` |
| `signal/` | `SignalService` (detector + lưu tín hiệu + liquidity), `minervini-strategy.ts` (lõi quyết định), `RecommendationService`, `SignalBacktestService`, `chart-patterns.ts`, entity Signal/BacktestRun/SimulatedTrade |
| `position/` | `PositionService` (mở/theo dõi/đóng), `averaging-policy.ts` (entry rule + hằng số TB, hiện TB đã tắt) |
| `scanner/` | `ScannerService` (toàn bộ cron cổ phiếu), `IntradayBreakoutNotifyService`, `watchlist.ts` (danh sách chuẩn ~100 mã + hạng vốn hoá/thanh khoản) |
| `watchlist/` | CRUD watchlist, kiểm tra thanh khoản, cron 07:30 tự đồng bộ/bật/tắt mã |
| `queue/` | BullMQ: queue `stock-tasks` (sync-all, sync-ticker, scan-all, analyze-history-all/ticker) và `derivatives-tasks` (backtest-vn30) |
| `derivatives/` | Phái sinh VN30F1M: quét nến 5m, quyết định LONG/SHORT/NO_TRADE, backtest riêng |
| `telegram/` | `TelegramService` (gửi HTML) + `TelegramNotifyPolicyService` (profile balanced/strict/full, cờ bật/tắt, daily cap, dedupe) |
| `common/` | `vn-trading-days.ts` (phiên VN, T+2, sau đóng cửa), `position-profit-run.ts`, `map-pool.ts`, policy sync/Telegram |

## 4. Luồng dữ liệu chính (cổ phiếu)

1. **Sync giá** (`StockService.syncHistorySmart`) → lưu `stock_prices`.
2. **Tín hiệu**: `SignalService.analyze(ticker)` (phiên mới nhất, cần ≥65 nến, qua `checkLiquidity`) hoặc
   `analyzeAllHistory` (sliding window 260 nến, `INSERT IGNORE`, **cuối hàm tự chạy `runBacktest`**).
   Sau sync: `analyze` luôn chạy; `analyzeAllHistory` chỉ chạy khi có nến mới / không phải incremental
   (`shouldRunAnalyzeAllHistoryAfterSync`).
3. **Khuyến nghị**: `RecommendationService.recommend` → `buildResult` dùng **`evaluateMinervini(bars)`** làm khuyến nghị/điểm
   thật. Điểm cộng dồn theo `SIGNAL_WEIGHTS` vẫn tính nhưng chỉ để hiển thị danh sách tín hiệu (`signals=...` trong log).
4. **Vị thế**: `ScannerService.recommendAll` (16:00) → `PositionService.openOrScaleIn`.
5. **Theo dõi**: `PositionService.trackAll` (15:35) lấy giá mới nhất từ DNSE, cập nhật P/L, đỉnh, stop, đóng lệnh, báo Telegram.

### Cron (giờ VN, T2–T6 trừ khi ghi khác)

| Giờ | Việc | Nơi |
|---|---|---|
| 07:30 hàng ngày | đồng bộ watchlist chuẩn + quét thanh khoản | `WatchlistService` |
| `*/7` 9–14 (trong phiên 9:30–14:45) | sync nến ngày hiện tại + `analyze` + báo break intraday | `ScannerService` |
| `*/30` 9–14 | cảnh báo biến động giá intraday | `ScannerService` |
| 15:30 | sync giá + báo "đóng cửa xác nhận break" | `ScannerService` |
| 15:35 | `trackAll` vị thế | `ScannerService` |
| 15:45 | quét tín hiệu, tin tổng hợp | `ScannerService` |
| 16:00 | `recommendAll`: mở vị thế + Telegram MUA/BÁN | `ScannerService` |
| mỗi phút 9–14 / 14:45 / 15:00 | quét phái sinh / đóng cuối phiên / tổng kết ngày | `DerivativesService` |

`ScannerService.isRunning` là cờ chống chạy chồng cho sync; VNINDEX/VN30 luôn được ghép vào đầu danh sách sync intraday.

## 5. Chiến lược đang chạy (Strict Minervini) — nguồn: `signal/minervini-strategy.ts`

Cần ≥220 nến, nếu không → HOLD.

- **trendOk**: close > SMA50 > SMA150 > SMA200, SMA200 dốc lên (so với 20 phiên trước), close ≥ 1.3×đáy 52w, close ≥ 0.75×đỉnh 52w.
- **baseOk** (`findBaseBeforeLast`): nền 15–65 phiên, depth ≤ 30%, biên độ nửa sau co lại ≤ 95% hoặc volume cuối ≤ nửa đầu. `pivot` = đỉnh nền.
- **breakoutOk**: close > pivot. **buyZoneOk**: ≤ 8% trên pivot (`MINERVINI_MAX_BUY_ZONE_PCT`, nới từ 5% ngày 2026-09-20 vì quá chặt). **volumeOk**: volume ≥ 1.4× TB50. **extended**: close > 1.25×SMA50 (`MINERVINI_MAX_MA50_EXTENSION_PCT`, nới từ 15%).
  Đổi hai ngưỡng này thì chạy lại backtest (`runBacktest` gọi thẳng `evaluateMinervini`, tự áp ngưỡng mới); bảng `signals` cũ **không** tự sửa vì `analyzeAllHistory` là `INSERT IGNORE` (các dòng `MINERVINI_EXTENDED` gắn ở ngưỡng 15% vẫn còn cho tới khi xoá tay và phân tích lại).
- **STRONG_BUY** = trend + base + breakout + volume + buyZone + đóng cửa nửa trên nến + không extended + market timing + RS.
  **BUY** = trend + base + gần pivot (97%–100.5%) + không extended. Còn lại HOLD. (Không sinh SELL từ Minervini.)
- Market timing: VNINDEX > SMA50. RS: lợi suất 63 phiên của mã > VNINDEX. Thiếu `MarketContext` → **mặc định pass**.
- Hằng số: stop 7% (`MINERVINI_STOP_PCT`), target mặc định 25% và sàn 20% (`MINERVINI_TARGET_PCT`), profit lock 20%.

### Vị thế (live) — `position/position.service.ts`

- Mở: chỉ sau 14:46 VN, mã không phải chỉ số, chưa có vị thế OPEN, market timing + RS ok, `allowsFirstPositionEntry`
  (STRONG_BUY + có đủ TREND_TEMPLATE & VCP_BASE **hoặc** đủ PIVOT_BREAKOUT & VOLUME_CONFIRM & BUY_ZONE), không trong cooldown 5 ngày lịch.
  Giá vào = close của phiên tín hiệu. Target ≥ 20% (`calcPriceTargetForFixedEntry`), stop 7%.
- **Không trung bình giá**: `MAX_AVERAGE_DOWN_LEGS = 0`, `allowsAverageDown*` luôn `false`. Entity vẫn còn cột `averageDownLegs`.
- `trackAll` thứ tự: cập nhật giá/đỉnh → nâng stop (chỉ sau T+2: lãi ≥10% → dời về hoà vốn; lãi ≥20% → khoá 50% lãi tính từ đỉnh)
  → nếu chạm stop/target mà chưa đủ T+2 thì chỉ báo "chờ T+2" → stop → target → **chặn lãi** (`PROFIT_FLOOR_20`).
- Chặn lãi: đỉnh lãi > 20% và lãi hiện tại ≤ `effectiveProfitFloorPnl` = `max(20, (peak/entry)×0.8 − 1)` (%). Không cần chờ T+2 (theo thiết kế).
- T+2: đếm phiên T2–T6 sau ngày mua, **không trừ ngày lễ** (`vn-trading-days.ts`).
- `CloseReason`: TARGET_HIT, STOP_LOSS, PROFIT_FLOOR_20, DISTRIBUTION (không còn dùng để đóng), MANUAL.

### Backtest cổ phiếu — `signal/signal-backtest.service.ts`

- Chạy trên toàn bộ nến đã lưu của mã; chỉ vào lệnh khi `evaluateMinervini` = STRONG_BUY (có `MarketContext` từ VNINDEX nếu bật).
- `DEFAULT_BACKTEST_CONFIG` = marketTiming + rsFilter + trailingStop đều bật; `BASELINE_BACKTEST_CONFIG` = tắt hết.
- Thoát (sau T+2): trail/stop → target → profit lock (lãi ≥20% và thủng SMA10 hoặc rút ≥8% từ đỉnh) → cuối kỳ `END_OF_PERIOD`.
- Mỗi mã chỉ giữ **1 run mới nhất** (xoá run cũ). Bảng xếp hạng trang chủ = compound % của lệnh **đóng trong 12 tháng gần nhất**.
- Cooldown backtest mặc định **0** ngày (`BACKTEST_REENTRY_COOLDOWN_DAYS`), khác live (5 ngày).

### Thanh khoản (`SignalService.checkLiquidity`)
Cửa sổ 30 phiên: ≥10 nến, avg volume ≥ 100.000, ≥18 ngày có giao dịch. Mã không đạt bị bỏ qua ở analyze/recommend.

## 6. Thuật toán chi tiết — tín hiệu cổ phiếu (`signal/signal.service.ts`)

Mọi detector nhận `bars` (ASC, OHLCV) và chỉ xét **nến cuối**. Lưu bảng `signals` với UNIQUE `(ticker, tradingDate, type)`.
`analyze` (live) tải 260 nến gần nhất; `analyzeAllHistory` trượt cửa sổ 260 nến cho từng ngày (cần ≥260 nến, mã ít hơn bị bỏ qua).
Chỉ báo dùng `technicalindicators` (lưu ý: RSI trả `N−14` phần tử, EMA(p) trả `N−p+1`, MACD trả `N−25` và phần tử đầu chưa có `signal`).

| Detector → SignalType (hướng) | Điều kiện chính |
|---|---|
| RSI → `RSI_OVERSOLD`(+) / `RSI_OVERBOUGHT`(−) | RSI14 <30 / >70. `RSI_MOMENTUM_UP`(+): vượt 50 từ dưới lên và ≤70; `RSI_MOMENTUM_DOWN`(−): rớt dưới 50 |
| MACD → `MACD_BULLISH_CROSS`(+)/`MACD_BEARISH_CROSS`(−) | MACD(12,26,9) cắt signal ở nến cuối |
| Bollinger(20,2) → `BB_BREAKOUT_DOWN`(+) / `BB_BREAKOUT_UP`(−) / `BB_SQUEEZE`(0) | close < dải dưới (+); close > dải trên **và không phải breakout mạnh** (vol ≥2× TB19, nến xanh, thân ≥50% range) (−); băng thông <8% (trung tính). **Tên enum ngược nghĩa**: `DOWN`=chạm dưới=bullish |
| EMA cross → `EMA_GOLDEN_CROSS`/`EMA_DEATH_CROSS` | EMA20 cắt EMA50 (**đang sai chỉ số EMA50 — xem lỗi B1 ở mục 11**) |
| EMA stack → `EMA_BULLISH_STACK`(+)/`EMA_BEARISH_STACK`(−) | close>EMA20>EMA50(>EMA100 nếu có ≥100 nến) / close<EMA20<EMA50 |
| `EMA_BOUNCE`(+) | low nến trước ≤ EMA20(hoặc EMA50)×1.005, nến nay đóng trên EMA đó và là nến xanh |
| `BASE_FORMING`(+) | 20 nến trước nến cuối: (maxHigh−minLow)/avgClose ≤10%, vol TB nền ≤1.2×TB40, và close 25 nến trước < 1.05×close đầu nền |
| `RESISTANCE_BREAKOUT`(+) | close > đỉnh 60 phiên trước, vol ≥2× TB60, thân ≥50% range, nến xanh |
| `SUPPORT_BREAKDOWN`(−) | đối xứng: close < đáy 60 phiên, vol ≥2×, thân ≥50%, nến đỏ |
| 5 tín hiệu `MINERVINI_*` | lấy thẳng từ `evaluateMinervini(bars)` (không truyền `MarketContext`): TREND_TEMPLATE, VCP_BASE(value=depth%), PIVOT_BREAKOUT(value=pivot), VOLUME_CONFIRM(value=tỉ lệ vol), BUY_ZONE, và `MINERVINI_EXTENDED`(−) |
| Phân phối đỉnh (đều cần `hasUptrendToDistribute`: tăng ≥15% từ đáy 60 phiên và close ở ≥60% range 60 phiên) | |
| ↳ `RSI_BEARISH_DIVERGENCE`(−) | 2 đỉnh (swing ±2 nến, trong 40 nến) cách ≥5 nến, pullback giữa ≥3%, đỉnh 2 cao hơn ≥1% nhưng RSI thấp hơn ≥4 điểm |
| ↳ `MACD_BEARISH_DIVERGENCE`(−) | 2 đỉnh histogram dương trong 15 nến, đỉnh sau <70% đỉnh trước trong khi giá ≥99% |
| ↳ `VOLUME_CLIMAX_TOP`(−) | vol ≥3× TB20, close nến <40% range |
| ↳ `DISTRIBUTION_BAR`(−) | range >1.5× TB, vol >1.5×, close <35% range, bóng trên >25% range |
| ↳ `FAILED_BREAKOUT`(−) | high vượt đỉnh 21 nến, close dưới đỉnh đó ≥0.4% và nến đỏ; loại trừ nền hẹp/EMA20≈EMA50 (`isChopOrBaseContext...`) |
| `WASHOUT_BAR`(+) | giá ở ≤42% range 60 phiên và đã giảm ≥6% từ đỉnh; vol ≥2.2×, range ≥1.35×, close ≥48% range (và ≥55%, hoặc bóng dưới ≥33% range với close ≥45%) |
| Nến: `DOJI`(0), `HAMMER`(+), `SHOOTING_STAR`(−), `BULLISH/BEARISH_ENGULFING` | thân/range <10%; bóng >2× thân...; engulfing so với nến liền trước |
| `VOLUME_SURGE`(0) | vol > 2× TB19 — nhân trọng số ×1.3 cho mọi tín hiệu cùng ngày trong điểm cộng dồn |

**Điểm cộng dồn (fallback / hiển thị)**: `SIGNAL_WEIGHTS` (RESISTANCE_BREAKOUT/SUPPORT_BREAKDOWN/FAILED_BREAKOUT=5 cao nhất,
MINERVINI_EXTENDED=3...). `score = Σ(bullish) − Σ(bearish)`, kẹp [−10,10]; ≥6 STRONG_BUY, ≥3 BUY, ≤−3 SELL, ≤−6 STRONG_SELL.
`applyMinerviniBuyGate` hạ BUY/STRONG_BUY về HOLD nếu thiếu TREND_TEMPLATE + VCP_BASE hoặc có EXTENDED.
`SignalService.getSignalsSummary` có bản `SUMMARY_WEIGHTS` riêng (chép lại — sửa trọng số phải sửa **hai chỗ**);
sao: |score| ≥7→3, ≥4.5→2, ≥2.5→1; direction BULLISH/BEARISH khi |score| ≥2.5.
`calcConfidence(signalCount, score)`: HIGH nếu ≥3 tín hiệu và |score|≥4; MEDIUM nếu ≥2 và ≥2. Ở `buildResult` truyền `signals.length` (gồm cả trung tính) và **điểm Minervini 0–10**.

**Giá mục tiêu** (`calcPriceTarget`, `calcPriceTargetForFixedEntry` trong `recommendation.service.ts`): entry = close phiên; target = entry×(1+`minerviniTargetPctFromEnv`≥20%);
stop = entry×0.93; R:R = 0.25/0.07≈3.57 (với 25%). ATR14/support(đáy 20 phiên)/resistance(đỉnh toàn bộ bars) chỉ để hiển thị.
`suggestedPullbackPrice` chỉ là gợi ý hiển thị (limit chờ hồi = max(đáy 20p, close−0.3×ATR); STRONG_BUY → entry; BUY → pivot chờ retest).

**Forming setups** (`computeFormingSetups`, cần 130 nến, API `/scanner/forming-setups`): heuristic "sắp có tín hiệu" — RSI 31–38 đang hồi, RSI 62–70 đang tăng, RSI áp 50;
MACD thu hẹp khoảng cách với signal (gap/giá <0.25%); EMA20 áp EMA50 (<0.6% giá); BB thắt <7% băng thông; giá sát BB (<0.3%). Không lưu DB. `priority` để sắp xếp.

**Mô hình giá** (`chart-patterns.ts`, cần ≥80 nến, chỉ sinh văn bản + mức giá cho UI/Telegram, **không** ảnh hưởng khuyến nghị): swing pivot ±4 nến;
cốc-tay cầm (ưu tiên số 1; cốc sâu ≥12%, mép phải ±2.5% mép trái, tay cầm pullback 2–7.5%, vol tay cầm <88% vol hồi) → 2 đỉnh M / 2 đáy W (cách ≥28 nến, chênh ≤1.5%, neckline sâu ≥4.5%, trend trước ≥10%).

## 7. Thuật toán chi tiết — phái sinh VN30 (`derivatives/`)

Phiên bản: `ALGORITHM = 'VN30_EMA_VWAP_RSI_ATR_5M_V4'` (nhật ký thay đổi nằm ở đầu `derivatives.service.ts`). Nguồn giá: **VN30F1M** (Entrade `/ohlcs/derivative`), nến 5 phút, 120 nến gần nhất trong 10 ngày. Giá chia 1000 (đơn vị điểm).

- **Cron mỗi phút** trong phiên: `scanVn30` → (1) `settleOpenDecisions` đóng lệnh OPEN nếu chạm SL/TP → (2) nếu còn lệnh OPEN thì **không mở thêm** → (3) `makeDecision` → lưu (chống trùng cùng action trong cùng slot 5 phút) → Telegram theo `shouldNotify`.
- **Telegram phái sinh** (`shouldNotify`, `notifyOpenedDecision`, `notifyClosedDecision`, `retryOpenNotification`): mọi lệnh LONG/SHORT mới mở **luôn** gửi tin "Mở lệnh" (trừ khi `DERIVATIVES_TELEGRAM_NOTIFY=false`); NO_TRADE chỉ báo khi bật `DERIVATIVES_TELEGRAM_NOTIFY_NO_TRADE`. Gửi lỗi thì thử lại mỗi lần quét trong 15 phút đầu khi lệnh còn OPEN. Tin đóng lệnh gửi ở `settleOpenDecisions`/`closeAllOpenAtEndOfSession`, không qua `shouldNotify`.
  Đã sửa 2026-09-20: trước đó `shouldNotify` tìm "quyết định trước" bằng `decidedAt < runAt`, mà cột `decidedAt` là `datetime` (làm tròn giây) nên khoảng một nửa số lệnh vừa mở bị nhận chính nó làm "quyết định trước cùng hướng đang OPEN" → nuốt tin mở lệnh. Giờ so theo `id`. **Đừng so timestamp có mili-giây với cột `datetime` không có phần lẻ** (cùng bẫy ở mọi bảng dùng `datetime`).
- **Gate** (đều trả NO_TRADE): <60 nến; ATR14 chưa có; ATR14 <2.5 điểm; nến cuối ≥14:15; cửa sổ roll HĐTL (ngày đáo hạn = thứ Năm thứ 3 và ngày kế — `isVn30FuturesRollWindow`).
- **Điều kiện** (5 mỗi phía): LONG = close>VWAP ngày; EMA9>EMA21; slope EMA9 (5 nến)>0; RSI14 ∈[50,75]; close>đỉnh 12 nến trước **và** volume nến cuối ≥1.2× TB20 nến trước.
  SHORT = đối xứng, RSI ∈[25,50]. **LONG cần 5/5, SHORT cần 4/5**, và điểm phía đó phải lớn hơn phía kia.
- **SL/TP**: SL = entry ∓ 1.2×ATR, TP = entry ± 2×ATR (R:R hiển thị 1.67). Chỉ báo EMA/RSI/ATR tự cài (seed EMA bằng SMA chạy dần, RSI/ATR Wilder), VWAP tính từ đầu ngày, `confidence` khiêm tốn (`min(72, 55+(score−ngưỡng)×8)` ⇒ thực tế LONG 55%, SHORT 55–63%; NO_TRADE ≤50%).
- **Thoát** (duyệt các nến sau `decidedAt`): chạm SL/trail trước → chạm TP → cập nhật SL (dời hoà vốn khi lãi ≥1R=1.2×ATR; "trailing" khi lãi ≥2R) → sau 12 nến thoát theo close (`TIME_EXIT`) → 14:45 đóng hết (`closeAllOpenAtEndOfSession`). Trong cùng nến, SL được kiểm tra trước TP (bảo thủ). Outcome theo P/L: >+0.01 WIN, <−0.01 LOSS, còn lại TIME_EXIT.
- **Backtest** (`vn30-backtest-core.ts`, chạy qua queue `derivatives-tasks`, cache Redis 15 ngày theo tháng): `decide()` + `settle()` thuần. Chạy nhiều biến thể (LONG 4/5, LONG siết 5/5 RSI 58–72, SHORT only, LONG only, sáng only <11:30, ATR≥3) trên **chỉ số VN30** (không phải F1M). Có `MAX_DAILY_LOSSES = 2`. Thống kê: WR, PF, expectancy, max drawdown, Sharpe/lệnh, chuỗi thắng/thua, net theo tháng.

## 8. Sync giá, thông báo, chống trùng

- **`syncHistorySmart`**: DB trống → 1 năm; đã có → tải lại 7 ngày cuối (overlap) và so `close` API vs DB; lệch >2.5% ở bất kỳ ngày nào ⇒ coi là điều chỉnh cổ tức/tách cổ phiếu ⇒ **xoá toàn bộ giá mã đó và tải full IPO** (`full_resync_corporate_action`). Ghi bằng `INSERT IGNORE` (không cập nhật nến đã có).
- **`syncIntradaySessionBar`** (cron trong phiên): chỉ tải nến ngày hôm nay và **upsert** (`ON DUPLICATE KEY UPDATE`). Đây là chỗ duy nhất ghi đè nến đã tồn tại.
- `fetchOhlcFullHistory`: phân trang theo `nextTime`, tối đa 2000 trang. Chỉ số VNINDEX/VN30 dùng endpoint `index`, HĐTL dùng `derivative` (chỉ nhận `VN30F1M|VN30F2M`).
- **Break intraday** (`IntradayBreakoutNotifyService`, trạng thái **trong RAM**, mất khi restart): tin "đang mạnh" khi close > đỉnh 60 phiên trước, close ≥45% range nến ngày, và giữ liên tục ≥30 phút (`TELEGRAM_INTRADAY_BREAKOUT_HOLD_MINUTES`, 5–120) tính theo lần quan sát của cron 7 phút; sau 15:30 gửi 1 tin "đóng cửa xác nhận" nếu DB có `RESISTANCE_BREAKOUT` hôm nay và close vẫn trên cản.
- **`TelegramNotifyPolicyService.shouldSend`**: bỏ qua nếu `force`; lọc theo profile (`strict` chỉ recommend_summary/manual, position_close, breakout_close_confirm; `balanced` thêm position_track, signal_notify; `full` tất cả) → cờ `TELEGRAM_NOTIFY_ENABLE_<TYPE>` → dedupe theo `(ngày|type|dedupeKey)` (Set trong RAM, reset mỗi ngày) → trần theo ngày (recommend 2, position_track 1, breakout_close_confirm 20; chỉnh qua `MAX_*_PER_DAY`, 0 = không giới hạn).
  Dedupe/cap nằm trong RAM ⇒ restart app giữa ngày có thể gửi lại. Cap "recommend=2" gồm cả `recommend_manual` bấm tay.
- **`TelegramService.sendMessage` chỉ thật sự gửi khi `NODE_ENV=production`** (ngoài production trả `false` ngay, không lỗi) — nhớ khi thử tin nhắn ở dev.
  Tin đi qua hàng đợi tuần tự (giãn `QUEUE_INTERVAL_MS`), retry khi 429 (theo `retry-after`), 5xx, lỗi mạng; lỗi HTML "can't parse entities" → gửi lại bản đã bỏ thẻ; hết retry thì log lỗi và trả `false` (không throw). `shouldSend` **commit dedupe/cap trước khi gửi** nên gửi thất bại vẫn tính là đã gửi.
- **`ScannerService.getSignalsSummary`** cache 5 phút trong RAM, `invalidateSummaryCache()` sau sync/scan.

## 9. API (prefix không có `/api`, trừ `GET /api/v1`)

Đọc thì công khai, **ghi/tác vụ nặng cần `Authorization: Bearer <jwt>`** (`JwtAuthGuard`; token từ `POST /auth/login`).
Nhóm route: `/auth`, `/stocks/:ticker/*`, `/signals/*` (+ `/signals/backtest/summary`, `:ticker/backtest/*`),
`/scanner/*` (signals-summary, latest-signals, forming-setups, sync, scan, recommend, alert, analyze-history),
`/positions` (GET open/closed, POST track, DELETE :id = đóng tay), `/watchlist/*`, `/queue/*` (job status `/queue/jobs/:id`),
`/derivatives/vn30/*`. `GET /` phục vụ `public/index.html`.

## 10. Biến môi trường (chi tiết: `.env.example`)

`DB_*`, `REDIS_*`, `PORT`, `NODE_ENV`, `LOG_JSON`, `ADMIN_*`, `JWT_SECRET`, `TELEGRAM_BOT_TOKEN/CHAT_ID`,
nhóm `TELEGRAM_NOTIFY_*` (profile, cờ từng loại, daily cap), `TELEGRAM_BUY_NOTIFY_MODE` (`all` mặc định trong code / `safe`),
`SYNC_TICKERS_CONCURRENCY`, `STOCK_QUEUE_CONCURRENCY`, `MINERVINI_TARGET_PCT`, `BACKTEST_REENTRY_COOLDOWN_DAYS`,
`DERIVATIVES_*`, `ANALYTICS_DB_*` (DB read-only cho script analytics). **`.env` chứa secret thật — không commit, không in ra.**

## 11. Chỗ lệch đã biết (đọc trước khi sửa logic)

1. **README + tab "Chiến lược" (`public/index.html`) đã cũ**: ghi "không cắt lỗ", "TB tối đa 10 lần", "vào lệnh theo nền/break".
   Code thực tế: có stop 7% + trailing, TB tắt hoàn toàn, vào lệnh theo Strict Minervini. Sửa logic thì cập nhật cả hai.
2. **Backtest ≠ live ở bước chặn lãi**: backtest dùng profit lock (≥20% + thủng SMA10 hoặc rút 8% từ đỉnh),
   live dùng sàn động `effectiveProfitFloorPnl` (rút 20% từ đỉnh). Kết quả backtest không mô phỏng đúng live.
3. **Cooldown**: live 5 ngày, backtest mặc định 0.
4. **Bộ lọc thị trường/RS tự pass khi thiếu dữ liệu VNINDEX** (live: `<50`/`<64` nến; backtest: thiếu ctx) → có thể tắt ngầm.
5. **Điểm cộng dồn tín hiệu (`SIGNAL_WEIGHTS`, `scoreToRecommendation`, `applyMinerviniBuyGate`) không quyết định khuyến nghị nữa**
   ở đường `recommend` (dùng Minervini). `ScannerService.recommendationToScannerSummary` dùng `result.score` (điểm Minervini 0–10).
6. `CloseReason.DISTRIBUTION`, `detailReversalStrongSell`, `isDistributionSignal` là code sót lại, không còn dùng để đóng lệnh.
7. `yarn format:check` hiện **fail ở 9 file** (gồm `position.service.ts`, `signal-backtest.service.ts`, `watchlist.service.ts`...). Đừng chạy `yarn format` cả repo khi chỉ sửa nhỏ — diff sẽ lan rộng; chỉ format file mình sửa.
8. `.env.example` ghi `TELEGRAM_BUY_NOTIFY_MODE` mặc định `safe`, nhưng code (`parseTelegramBuyNotifyMode`) mặc định `all`.
9. Test gần như không có: sửa logic chiến lược nên thêm spec cạnh `minervini-strategy.spec.ts`.

**Đã sửa 2026-09-20 — `signals.value` tràn cột (`Out of range value for column 'value'`)**: mọi giá lưu ×1000 kể cả chỉ số (VNINDEX ~1,9 triệu),
nhưng cột từng là `decimal(10,4)` (tối đa 999.999,9999). `analyze` (TypeORM `save`, strict mode) văng lỗi khi mã VNINDEX/VN30 ghi tín hiệu có `value` là giá (EMA, close, pivot...);
`analyzeAllHistory` dùng `INSERT IGNORE` nên **âm thầm cắt** thành `999999.9999`. Đã đổi thành `decimal(20,4)`.
Production cần `ALTER TABLE signals MODIFY value DECIMAL(20,4) NULL;` (hoặc `DB_SYNCHRONIZE=true`). Dòng cũ của VNINDEX/VN30 vẫn mang giá trị bị cắt `999999.9999` cho tới khi xoá và phân tích lại.

### Lỗi logic phát hiện khi đọc thuật toán (chưa sửa — hỏi người dùng trước khi sửa)

**Đã kiểm chứng bằng chạy thư viện / đọc code:**

- **B1. `EMA_GOLDEN_CROSS/EMA_DEATH_CROSS` so sai chỉ số.** `detectEmaCross` ([signal.service.ts:1131-1135](src/signal/signal.service.ts#L1131-L1135)) lấy `prevEma50 = ema50[len-2-offset]` với `offset = ema20.length − ema50.length = 30`.
  Vì hai mảng EMA đã căn phải theo nến cuối, `ema50[len-2]` mới là EMA50 hôm qua; code đang lấy EMA50 của **30 phiên trước** (N=260: nến 228 thay vì 258). Cross vì thế bị phát hiện/bỏ sót sai. Cùng lỗi ở `computeFormingSetups` ([signal.service.ts:881](src/signal/signal.service.ts#L881)) → gợi ý `EMA_NEAR_GOLDEN/DEATH` sai. Sửa: `prevEma50 = ema50[ema50.length - 2]`.
- **B2. `chart-patterns.ts` `rsiAtBar` lệch 1 nến**: dùng `barIdx − 13` nhưng RSI14 bắt đầu ở nến index 14 (mảng dài `N−14`). Chỉ ảnh hưởng câu chữ "phân kỳ RSI" của mô hình M/W. (`detectRsiBearishDivergence` tính offset đúng bằng `bars.length − rsiArr.length`.)
- **B3. Phái sinh: nhánh "trailing khi lãi ≥2R" là mã chết** (cả live `settleOpenDecisions` và backtest `settle`). TP = 2×ATR = 1.67R nhưng trailing chỉ kích hoạt khi lãi ≥ (TRAIL_AFTER_R+1)×R = 2R; vì kiểm tra TP chạy trước trong cùng nến nên lệnh luôn thoát ở TP trước khi tới 2R.
  Chỉ còn cơ chế **dời SL về hoà vốn ở 1R**. Nhật ký V3 ghi "trailing đóng góp lớn nhất (+122đ)" thực chất là hiệu ứng hoà vốn.
- **B4. Backtest phái sinh ≠ live V4**: backtest `decide()` không có lọc volume ≥1.2×, `MIN_ATR_POINTS=1.5` (live 2.5), không có cổng cửa sổ roll, LONG "bình thường" chỉ cần 4/5 (live 5/5), có `MAX_DAILY_LOSSES=2` (live **không có**, dù nhật ký V2 nhắc), và chạy trên chỉ số VN30 (live dùng F1M). Kết quả backtest không phản ánh thuật toán đang chạy.
- **B5. Live phái sinh quyết định trên nến 5 phút đang hình thành** (cron mỗi phút): `close`, `volumeRatio20`, RSI... tính trên nến chưa đóng (volume nến cuối bị thiếu đầu nến ⇒ tỉ lệ vol thấp giả). Backtest dùng nến đã đóng.
- **B6. `StockService.checkAndAlert` so với sai mốc**: `prev` = nến mới nhất trong DB; vì cron trong phiên upsert nến hôm nay mỗi ~7 phút nên `prev` thường là chính nến hôm nay (~7 phút trước), không phải phiên trước. Tin nhắn vẫn ghi "hôm qua". Ngưỡng 3% vì vậy đo biến động ~7 phút, hiếm khi kích hoạt.
- **B7. Tín hiệu trong phiên bị "dính"**: `analyze` chạy mỗi 7 phút trên nến ngày chưa đóng và chỉ **thêm** bản ghi mới (`if (!exists) save`), không bao giờ xoá/cập nhật. Tín hiệu bật lên giữa phiên (cross, RSI, engulfing...) vẫn nằm trong `signals` dù cuối phiên hết đúng; dashboard/scanner/`hasBreak` của tin xác nhận đọc thẳng bảng này.
- **B8. `SignalBacktestService.runBacktest` chi phí O(n²)**: mỗi nến khi chưa có vị thế tạo lại `bars.slice(0,i+1).map(...)` rồi `evaluateMinervini` (vòng `findBaseBeforeLast` 51 lần × slice). Mã có hàng nghìn nến chạy rất chậm; nó lại tự chạy sau mỗi `analyzeAllHistory`.
- **B9. `BASE_FORMING` tên "nền tăng trước" nhưng điều kiện chỉ là "25 nến trước không cao hơn 5% so với đầu nền"** — không kiểm tra uptrend thật.

**Nghi vấn chưa xác nhận (cần đối chiếu dữ liệu thật):**

- **N1. Nến ngày có thể đứng ở giá ~14:42 thay vì giá đóng cửa thật.** Nến hôm nay được upsert bởi cron trong phiên (lần cuối ~14:42, trước khi ATC 14:45 khớp xong). Sau đó `syncHistorySmart` lúc 15:30 dùng `INSERT IGNORE` nên **không ghi đè** nến đã có, và các lần sync overlap 7 ngày sau đó cũng không sửa (chỉ sửa khi lệch >2.5% thì xoá và tải full). Nếu đúng, `close/volume` cuối ngày trong DB thiếu ATC, ảnh hưởng: giá vào lệnh (`PositionService` lấy `dayBar.close`), `analyze` lúc 15:30/15:45, backtest. Cách kiểm: so vài mã `stock_prices` của một phiên gần đây với DNSE/Entrade.

## 12. Quy ước khi làm việc trong repo

- Giữ comment/log/UI tiếng Việt, định dạng số kiểu `vi-VN`, giá lưu VND (`decimal(15,2)`), ngày `YYYY-MM-DD` dạng chuỗi (so sánh bằng chuỗi).
- Mọi tác vụ theo giờ dùng helper trong `common/vn-trading-days.ts`, không dùng `new Date()` trần cho giờ VN.
- Tin Telegram đi qua `TelegramNotifyPolicyService.shouldSend({type, dedupeKey})` — thêm loại tin mới phải đăng ký type + cờ ở đó.
- Thay đổi thuật toán phái sinh: **bump `ALGORITHM` + ghi changelog** trong `derivatives.service.ts` (mỗi quyết định lưu tag version).
- Thêm entity mới: TypeORM `autoLoadEntities` + `synchronize` tự tạo bảng khi không phải production; production cần `DB_SYNCHRONIZE=true` hoặc migration thủ công.
