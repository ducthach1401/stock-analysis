import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { BacktestSeries, Trade, buildSeries } from './vn30-backtest-core';
import {
  isVnFuturesSessionOpen,
  vnCalendarTodayYmd,
} from '../common/vn-trading-days';
import { IntradayIndexBarDto } from '../stock/dto/intraday-bar.dto';
import { StockService } from '../stock/stock.service';
import { TelegramService } from '../telegram/telegram.service';
import {
  DerivativeDecision,
  DerivativeDecisionAction,
  DerivativeDecisionMetadata,
  DerivativeDecisionOutcome,
  DerivativeDecisionStatus,
} from './entities/derivative-decision.entity';
import {
  isVn30FuturesRollWindow,
  nearestVn30FuturesContract,
} from './vn30-contracts.util';

/**
 * Phiên bản thuật toán — LƯU vào cột `algorithm` của bảng `derivative_decisions`.
 * Mỗi quyết định được gắn tag version để sau này phân tích/so sánh theo từng đời thuật toán
 * (xem `yarn analytics:derivatives`, `yarn backtest:vn30`). KHI ĐỔI LOGIC → BUMP version + ghi changelog.
 *
 * Changelog:
 *  - V1: 5 điều kiện định hướng (score X/5), SL/TP cố định theo ATR (1.2/2.0), TIME_EXIT sau 12 nến.
 *        Không có gate; bug isDuplicateDecision spam NO_TRADE mỗi phút. (dữ liệu lịch sử tới 2026-06)
 *  - V2: thêm gate (ATR≥1.5, không vào sau 14:15, dừng sau 2 lỗ/ngày), 6 điều kiện (≥5/6),
 *        thêm lọc EMA50 + EMA slope 5 nến, RSI≥50 (bỏ trần), fix duplicate theo slot 5 phút,
 *        đóng cuối phiên 14:45. (chưa từng chạy live — không có bản ghi trong DB)
 *  - V3: trần RSI mềm (LONG 50–75 / SHORT 25–50), SL dời hòa vốn khi lãi 1R, trailing stop khi lãi >2R,
 *        outcome phân loại theo P/L thực (hòa vốn = trung tính). BỎ lọc EMA50 → còn 5 điều kiện (≥4/5):
 *        backtest 6 tháng (yarn backtest:vn30) cho thấy EMA50 bóp SHORT nhiều hơn lợi cho LONG, net hại
 *        (~−29đ/438 lệnh); trailing đóng góp lớn nhất (+122đ), trần RSI dương nhẹ (+46đ).
 *  - V4: NGƯỠNG VÀO BẤT ĐỐI XỨNG — LONG cần đủ 5/5, SHORT giữ 4/5. Data live V3 (DB prod, 130 lệnh
 *        2026-05→07): LONG 4/5 = 33 lệnh NET −18.3đ (mua đỉnh trong choppy), LONG 5/5 = 9 lệnh NET +15.5đ;
 *        SHORT ăn dày nhất ở 4/5 (+138đ). Đồng thời hiệu chỉnh `confidence` trung thực: data cho thấy
 *        score gần như KHÔNG tương quan win-rate (score 5 không hơn score 4) → bỏ gán 95% gây hiểu nhầm.
 *        CHƯA làm (chờ backtest qua giai đoạn thị trường TĂNG + hạ tầng khung lớn): bộ lọc regime, trừ phí
 *        giao dịch. Lưu ý: edge hiện tại đo trong 1 downtrend nên có thể là short-beta, chưa phải alpha bền.
 *  - V4 (2026-07-24, sau khi đổi nguồn giá sang HĐTL VN30F1M — KHÔNG bump version): thêm 3 cải thiện vào lệnh
 *        đặc thù futures: (a) GATE cửa sổ roll — không mở lệnh ngày đáo hạn (T5 tuần 3) + ngày kế, vì gap
 *        giữa 2 hợp đồng làm méo EMA/ATR/RSI/break trong lookback 120 nến; (b) breakout phải có VOLUME xác nhận
 *        (`volumeRatio20 ≥ 1.2`) — data VN30F1M cho thấy ~22% break là "mỏng" (<1.2) và dễ cụt đầu, volume
 *        futures nay là volume hợp đồng thật (khác index); (c) re-tune `MIN_ATR_POINTS` 1.5→2.5 vì ATR futures
 *        cao hơn (median 3.63 vs index 2.82) khiến ngưỡng cũ lọc 0% — 2.5 lọc ~15.6% nến trầm lắng nhất. (đang chạy)
 */
const ALGORITHM = 'VN30_EMA_VWAP_RSI_ATR_5M_V4';
// Nguồn GIÁ cho tín hiệu & P/L: HĐTL VN30 tháng gần (VN30F1M), KHÔNG dùng chỉ số VN30 nữa.
// Lý do: basis index↔futures dao động tới ~±8đ/ngày (lớn hơn cả TP/SL ~5.6/3.4đ) → chỉ báo và P/L
// phải tính trên chính hợp đồng giao dịch. Endpoint Entrade `/ohlcs/derivative`, không cần auth.
const PRICE_SYMBOL = 'VN30F1M';
// Nhãn `symbol` lưu DB cho quyết định MỚI — tách baseline futures khỏi dữ liệu index cũ (dưới 'VN30').
const DECISION_SYMBOL = 'VN30F1M';
// Danh sách symbol cho DANH SÁCH LỊCH SỬ (hiển thị): gồm cả baseline index cũ (V1/V3 dưới 'VN30')
// lẫn futures mới ('VN30F1M') để không mất lịch sử. Các query VẬN HÀNH (mở/đóng/dup) vẫn chỉ dùng DECISION_SYMBOL.
const HISTORY_SYMBOLS = ['VN30', DECISION_SYMBOL];
const LOOKBACK_BARS = 120;
const SETTLE_AFTER_BARS = 12;
const MIN_BARS = 60;
const ATR_PERIOD = 14;
const RISK_ATR_MULT = 1.2;
const REWARD_ATR_MULT = 2;
// V4: 2.5 (từ 1.5) — ATR futures VN30F1M cao hơn index (median 3.63 vs 2.82) nên 1.5 lọc 0% (gate chết);
// 2.5 lọc ~15.6% nến trầm lắng nhất, khôi phục đúng mục đích "tránh thị trường ít biến động".
const MIN_ATR_POINTS = 2.5;
// V4: breakout chỉ tính khi volume ≥ 1.2× trung bình 20 nến — data VN30F1M: ~22% break "mỏng" (<1.2) hay cụt đầu.
const VOL_BREAKOUT_MIN = 1.2;
const NO_TRADE_AFTER_HHMM = 1415; // 14:15 VN — quá gần đóng cửa
// V4: ngưỡng vào bất đối xứng. LONG dễ mua đỉnh trong thị trường choppy nên siết đủ 5/5;
// SHORT là nhóm ăn dày nhất và tốt nhất ở 4/5 nên giữ nguyên (xem changelog V4 + `yarn analytics:derivatives`).
const LONG_CHECKS_REQUIRED = 5;
const SHORT_CHECKS_REQUIRED = 4;
const RSI_MAX_LONG = 75; // Không đu LONG khi đã quá mua (data V1: LONG ở RSI 74-81 toàn lỗ)
const RSI_MIN_SHORT = 25; // Không đu SHORT khi đã quá bán
const BREAKEVEN_TRIGGER_R = 1; // Lãi đạt 1R → dời SL về hòa vốn
const TRAIL_AFTER_R = 1; // Lãi vượt 2R → trailing stop cách đỉnh/đáy 1R

type IndicatorSnapshot = {
  close: number;
  ema9: number;
  ema21: number;
  ema50: number;
  emaSlope: number;
  rsi14: number | null;
  atr14: number | null;
  vwap: number;
  prevHigh12: number;
  prevLow12: number;
  volumeRatio20: number;
  latestTime: Date;
  tradingDate: string;
};

type DailyDerivativeSummary = {
  tradingDate: string;
  openedToday: number;
  closedToday: number;
  openFromToday: number;
  openCurrent: number;
  wins: number;
  losses: number;
  timeExits: number;
  realizedPnlPoints: number;
  winRatePct: number;
};

@Injectable()
export class DerivativesService {
  private readonly logger = new Logger(DerivativesService.name);
  private running = false;
  private lastDailySummarySentAt: string | null = null;

  constructor(
    @InjectRepository(DerivativeDecision)
    private readonly decisionRepo: Repository<DerivativeDecision>,
    private readonly stockService: StockService,
    private readonly telegramService: TelegramService,
    private readonly config: ConfigService,
  ) {}

  // Quét nhanh hơn: mỗi 1 phút trong phiên để phản ứng mở/đóng lệnh sớm hơn.
  @Cron('* 9-14 * * 1-5', { timeZone: 'Asia/Ho_Chi_Minh' })
  async scheduledVn30FiveMinuteDecision(): Promise<void> {
    if (
      this.config.get<string>('DERIVATIVES_VN30_FIVE_MIN_SCAN', 'true') ===
      'false'
    ) {
      return;
    }
    if (!isVnFuturesSessionOpen()) return;
    await this.scanVn30({ source: 'cron' });
  }

  // Đóng tất cả vị thế phái sinh còn OPEN khi hết phiên 14:45 để tránh rollover sang ngày sau.
  @Cron('45 14 * * 1-5', { timeZone: 'Asia/Ho_Chi_Minh' })
  async scheduledEndOfSessionClose(): Promise<void> {
    if (
      this.config.get<string>('DERIVATIVES_VN30_FIVE_MIN_SCAN', 'true') ===
      'false'
    ) {
      return;
    }
    await this.closeAllOpenAtEndOfSession();
  }

  @Cron('0 15 * * 1-5', { timeZone: 'Asia/Ho_Chi_Minh' })
  async scheduledDailyTelegramSummary(): Promise<void> {
    if (
      this.config.get<string>('DERIVATIVES_TELEGRAM_NOTIFY', 'true') ===
        'false' ||
      this.config.get<string>(
        'DERIVATIVES_TELEGRAM_NOTIFY_DAILY_SUMMARY',
        'true',
      ) === 'false'
    ) {
      return;
    }
    const tradingDate = vnCalendarTodayYmd();
    if (this.lastDailySummarySentAt === tradingDate) return;
    const summary = await this.buildDailySummary(tradingDate);
    if (!summary) return;
    const sent = await this.notifyDailySummary(summary);
    if (sent) this.lastDailySummarySentAt = tradingDate;
  }

  async scanVn30(
    opts: { forceNotify?: boolean; source?: string } = {},
  ): Promise<{
    decision: DerivativeDecision | null;
    bars: number;
    skipped?: string;
  }> {
    if (this.running) {
      const latest = await this.decisionRepo.findOne({
        where: { symbol: DECISION_SYMBOL },
        order: { decidedAt: 'DESC' },
      });
      return { decision: latest ?? null, bars: 0, skipped: 'ALREADY_RUNNING' };
    }
    this.running = true;
    try {
      const runAt = new Date();
      const bars = await this.fetchRecentFiveMinuteBars();
      if (opts.source === 'cron' && !this.latestBarIsToday(bars)) {
        this.logger.log('Phái sinh VN30: bỏ qua cron vì chưa có nến hôm nay');
        return {
          decision: await this.latestDecision(),
          bars: bars.length,
          skipped: 'NO_TODAY_BAR',
        };
      }
      const closedDecisions = await this.settleOpenDecisions(bars);
      for (const closedDecision of closedDecisions) {
        await this.notifyClosedDecision(
          closedDecision,
          opts.source ?? 'manual',
        );
      }
      const activeOpenDecision = await this.latestOpenDecision();
      if (activeOpenDecision) {
        await this.touchDecisionScan(activeOpenDecision.id);
        const latest = bars[bars.length - 1];
        const latestPrice = latest
          ? this.round2(this.price(latest.close))
          : null;
        this.logger.log(
          `Phái sinh VN30: giữ lệnh ${activeOpenDecision.action} @ ${activeOpenDecision.entryPrice ?? 'n/a'} (chưa đóng) — không mở lệnh mới`,
        );
        return {
          decision: this.withFloatingPnl(activeOpenDecision, latestPrice),
          bars: bars.length,
          skipped: 'OPEN_DECISION_ACTIVE',
        };
      }
      const decision = await this.makeDecision(bars, runAt);
      const latestSaved = await this.latestPersistedDecision();
      if (latestSaved && this.isDuplicateDecision(latestSaved, decision)) {
        const latest = bars[bars.length - 1];
        const latestPrice = latest
          ? this.round2(this.price(latest.close))
          : null;
        return {
          decision: this.withFloatingPnl(latestSaved, latestPrice),
          bars: bars.length,
          skipped: 'DUPLICATE_DECISION',
        };
      }
      const saved = await this.decisionRepo.save(
        this.decisionRepo.create(decision),
      );
      const shouldNotify = await this.shouldNotify(saved, opts.forceNotify);
      if (shouldNotify) {
        // Mở vị thế LONG/SHORT → tin "Mở lệnh" chuyên biệt; các trường hợp khác giữ tin quyết định chung.
        const isNewOpenPosition =
          saved.status === DerivativeDecisionStatus.OPEN &&
          (saved.action === DerivativeDecisionAction.LONG ||
            saved.action === DerivativeDecisionAction.SHORT);
        const notifySource = opts.source ?? 'manual';
        const sent = isNewOpenPosition
          ? await this.notifyOpenedDecision(saved, notifySource, runAt)
          : await this.notifyDecision(saved, notifySource, runAt);
        if (sent) {
          saved.notified = true;
          await this.decisionRepo.save(saved);
        }
      }
      this.logger.log(
        `Phái sinh VN30 ${saved.action} score=${saved.score} conf=${saved.confidence}% @ ${saved.entryPrice ?? 'n/a'}`,
      );
      return { decision: saved, bars: bars.length };
    } catch (e) {
      this.logger.warn(`Phái sinh VN30 scan lỗi: ${(e as Error).message}`);
      throw e;
    } finally {
      this.running = false;
    }
  }

  private async closeAllOpenAtEndOfSession(): Promise<void> {
    const open = await this.decisionRepo.find({
      where: { symbol: DECISION_SYMBOL, status: DerivativeDecisionStatus.OPEN },
      order: { decidedAt: 'ASC' },
    });
    if (!open.length) return;

    let exitPrice: number | null = null;
    let exitAt = new Date();
    try {
      const bars = await this.fetchRecentFiveMinuteBars();
      const latest = bars[bars.length - 1];
      if (latest) {
        exitPrice = this.round2(this.price(latest.close));
        exitAt = new Date(Number(latest.time) * 1000);
      }
    } catch (e) {
      this.logger.warn(
        `Đóng cuối phiên: không lấy được giá cuối — ${(e as Error).message}`,
      );
    }

    for (const d of open) {
      if (
        d.action === DerivativeDecisionAction.NO_TRADE ||
        d.entryPrice == null
      ) {
        d.status = DerivativeDecisionStatus.CLOSED;
        d.outcome = DerivativeDecisionOutcome.NO_TRADE;
        d.pnlPoints = 0;
        d.exitAt = exitAt;
        d.exitPrice = exitPrice;
        d.outcomeReason = 'Đóng cuối phiên (NO_TRADE).';
        await this.decisionRepo.save(d);
        continue;
      }
      const ep = exitPrice ?? Number(d.entryPrice);
      d.status = DerivativeDecisionStatus.CLOSED;
      d.exitAt = exitAt;
      d.exitPrice = this.round2(ep);
      d.pnlPoints = this.round2(
        d.action === DerivativeDecisionAction.LONG
          ? ep - Number(d.entryPrice)
          : Number(d.entryPrice) - ep,
      );
      d.outcome = DerivativeDecisionOutcome.TIME_EXIT;
      d.outcomeReason = 'Đóng cuối phiên 14:45 — tránh rollover sang ngày sau.';
      await this.decisionRepo.save(d);
      await this.notifyClosedDecision(d, 'end_of_session');
    }
    this.logger.log(
      `Đóng cuối phiên: ${open.length} vị thế phái sinh đã được đóng @ ${exitPrice ?? 'n/a'}`,
    );
  }

  async latestDecision(): Promise<DerivativeDecision | null> {
    const decision = await this.decisionRepo.findOne({
      where: { symbol: DECISION_SYMBOL },
      order: { decidedAt: 'DESC' },
    });
    if (!decision) return null;
    const latestPrice = await this.latestMarkPrice();
    return this.withFloatingPnl(decision, latestPrice);
  }

  private latestOpenDecision(): Promise<DerivativeDecision | null> {
    return this.decisionRepo.findOne({
      where: { symbol: DECISION_SYMBOL, status: DerivativeDecisionStatus.OPEN },
      order: { decidedAt: 'DESC' },
    });
  }

  private latestPersistedDecision(): Promise<DerivativeDecision | null> {
    return this.decisionRepo.findOne({
      where: { symbol: DECISION_SYMBOL },
      order: { decidedAt: 'DESC' },
    });
  }

  private async touchDecisionScan(id: number): Promise<void> {
    await this.decisionRepo
      .createQueryBuilder()
      .update(DerivativeDecision)
      .set({ updatedAt: () => 'CURRENT_TIMESTAMP' } as never)
      .where('id = :id', { id })
      .execute();
  }

  async recentDecisions(limit = 50): Promise<DerivativeDecision[]> {
    const safeLimit = Math.min(Math.max(Math.floor(limit), 1), 200);
    const fetchTake = Math.min(1200, Math.max(300, safeLimit * 10));
    const rows = await this.decisionRepo.find({
      where: { symbol: In(HISTORY_SYMBOLS) },
      order: { decidedAt: 'DESC' },
      take: fetchTake,
    });
    const latestPrice = await this.latestMarkPrice();
    const dedupKeys = new Set<string>();
    const filtered: DerivativeDecision[] = [];
    for (const row of rows) {
      if (row.action === DerivativeDecisionAction.NO_TRADE) continue;
      const key = `${row.symbol}|${row.action}|${row.decidedAt.toISOString()}`;
      if (dedupKeys.has(key)) continue;
      dedupKeys.add(key);
      filtered.push(this.withFloatingPnl(row, latestPrice));
      if (filtered.length >= safeLimit) break;
    }
    return filtered;
  }

  private async fetchRecentFiveMinuteBars(): Promise<IntradayIndexBarDto[]> {
    const to = new Date();
    const from = new Date(to.getTime() - 10 * 24 * 60 * 60 * 1000);
    const bars = await this.stockService.fetchIntradayDerivativeOhlc(
      PRICE_SYMBOL,
      '5',
      from.toISOString(),
      to.toISOString(),
      true,
    );
    return bars
      .filter((b) => this.isValidBar(b))
      .sort((a, b) => Number(a.time) - Number(b.time))
      .slice(-LOOKBACK_BARS);
  }

  private async latestMarkPrice(): Promise<number | null> {
    try {
      const bars = await this.fetchRecentFiveMinuteBars();
      const latest = bars[bars.length - 1];
      if (!latest) return null;
      return this.round2(this.price(latest.close));
    } catch {
      return null;
    }
  }

  private withFloatingPnl(
    decision: DerivativeDecision,
    latestPrice: number | null,
  ): DerivativeDecision {
    if (
      decision.status !== DerivativeDecisionStatus.OPEN ||
      decision.entryPrice == null ||
      latestPrice == null
    ) {
      return decision;
    }
    if (
      decision.action !== DerivativeDecisionAction.LONG &&
      decision.action !== DerivativeDecisionAction.SHORT
    ) {
      return decision;
    }
    const entry = Number(decision.entryPrice);
    if (!Number.isFinite(entry)) return decision;
    const pnl =
      decision.action === DerivativeDecisionAction.LONG
        ? latestPrice - entry
        : entry - latestPrice;
    return {
      ...decision,
      pnlPoints: this.round2(pnl),
    };
  }

  private isDuplicateDecision(
    previous: DerivativeDecision,
    next: Omit<DerivativeDecision, 'id' | 'createdAt' | 'updatedAt'>,
  ): boolean {
    if (previous.symbol !== next.symbol || previous.action !== next.action)
      return false;
    // Chỉ lưu tối đa 1 decision cùng action trong mỗi cửa sổ 5 phút.
    const FIVE_MIN_MS = 5 * 60 * 1000;
    const prevSlot = Math.floor(previous.decidedAt.getTime() / FIVE_MIN_MS);
    const nextSlot = Math.floor(next.decidedAt.getTime() / FIVE_MIN_MS);
    return prevSlot === nextSlot;
  }

  private isValidBar(b: IntradayIndexBarDto): boolean {
    return [b.time, b.open, b.high, b.low, b.close].every((v) => {
      const n = Number(v);
      return Number.isFinite(n) && n > 0;
    });
  }

  private latestBarIsToday(bars: IntradayIndexBarDto[]): boolean {
    const latest = bars[bars.length - 1];
    if (!latest) return false;
    return this.vnDateFromUnix(Number(latest.time)) === vnCalendarTodayYmd();
  }

  private async makeDecision(
    bars: IntradayIndexBarDto[],
    runAt: Date,
  ): Promise<Omit<DerivativeDecision, 'id' | 'createdAt' | 'updatedAt'>> {
    const insufficient = bars.length < MIN_BARS;
    const snapshot = insufficient ? null : this.indicators(bars);
    const latest = bars[bars.length - 1];
    const decidedAt = runAt;
    const tradingDate = snapshot?.tradingDate ?? vnCalendarTodayYmd();
    const contractCode = nearestVn30FuturesContract(tradingDate)?.id ?? null;

    const noTrade = (reason: string) =>
      this.noTradeResult(
        reason,
        decidedAt,
        tradingDate,
        contractCode,
        latest,
        snapshot,
      );

    // Gate 0: dữ liệu / ATR cơ bản
    if (!snapshot || snapshot.atr14 == null || snapshot.atr14 <= 0) {
      return noTrade(
        insufficient
          ? `Không vào lệnh: thiếu nến 5m (${bars.length}/${MIN_BARS}).`
          : 'Không vào lệnh: ATR chưa đủ tin cậy để đặt SL/TP.',
      );
    }

    // Gate 1: ATR tối thiểu — tránh vào lệnh khi thị trường quá ít biến động
    if (snapshot.atr14 < MIN_ATR_POINTS) {
      return noTrade(
        `Không vào lệnh: ATR14 ${this.round2(snapshot.atr14)} < ${MIN_ATR_POINTS} điểm — thị trường ít biến động.`,
      );
    }

    // Gate 2: Không mở lệnh mới sau 14:15 — quá ít thời gian đạt TP trước khi đóng phiên
    if (this.isLateSession(snapshot.latestTime)) {
      return noTrade(
        'Không vào lệnh sau 14:15 — quá ít thời gian đạt TP trước khi đóng phiên.',
      );
    }

    // Gate 3: Cửa sổ roll HĐTL (ngày đáo hạn T5 tuần 3 + ngày kế) — gap giữa 2 hợp đồng
    // làm méo EMA/ATR/RSI/mức break trong lookback 120 nến → tín hiệu không tin cậy.
    if (isVn30FuturesRollWindow(tradingDate)) {
      return noTrade(
        'Không vào lệnh: cửa sổ roll HĐTL (đáo hạn/ngày kế) — chỉ báo bị méo bởi gap chuyển hợp đồng.',
      );
    }

    // 5 điều kiện định hướng — mutually exclusive giữa LONG và SHORT.
    // (EMA50 đã bỏ: backtest 6T cho thấy bóp phe SHORT nhiều hơn lợi cho LONG → net hại.)
    const longChecks = [
      snapshot.close > snapshot.vwap, // 1. Giá trên VWAP ngày
      snapshot.ema9 > snapshot.ema21, // 2. EMA9 dẫn EMA21 (uptrend ngắn hạn)
      snapshot.emaSlope > 0, // 3. EMA9 đang tăng (slope 25 phút)
      snapshot.rsi14 != null &&
        snapshot.rsi14 >= 50 &&
        snapshot.rsi14 <= RSI_MAX_LONG, // 4. RSI bullish nhưng chưa quá mua (50–75)
      snapshot.close > snapshot.prevHigh12 &&
        snapshot.volumeRatio20 >= VOL_BREAKOUT_MIN, // 5. Break đỉnh 60' + volume xác nhận
    ];
    const shortChecks = [
      snapshot.close < snapshot.vwap,
      snapshot.ema9 < snapshot.ema21,
      snapshot.emaSlope < 0,
      snapshot.rsi14 != null &&
        snapshot.rsi14 <= 50 &&
        snapshot.rsi14 >= RSI_MIN_SHORT, // RSI bearish nhưng chưa quá bán (25–50)
      snapshot.close < snapshot.prevLow12 &&
        snapshot.volumeRatio20 >= VOL_BREAKOUT_MIN, // Break đáy 60' + volume xác nhận
    ];

    const longScore = longChecks.filter(Boolean).length;
    const shortScore = shortChecks.filter(Boolean).length;
    const notes = this.explainSnapshot(snapshot);
    let action = DerivativeDecisionAction.NO_TRADE;
    let score = longScore - shortScore;

    if (longScore >= LONG_CHECKS_REQUIRED && longScore > shortScore) {
      action = DerivativeDecisionAction.LONG;
      score = longScore;
      notes.unshift(
        `LONG: ${longScore}/5 điều kiện tăng thỏa mãn (EMA trend, VWAP, RSI, breakout).`,
      );
    } else if (shortScore >= SHORT_CHECKS_REQUIRED && shortScore > longScore) {
      action = DerivativeDecisionAction.SHORT;
      score = shortScore;
      notes.unshift(
        `SHORT: ${shortScore}/5 điều kiện giảm thỏa mãn (EMA trend, VWAP, RSI, breakdown).`,
      );
    } else {
      notes.unshift(
        `NO_TRADE: LONG ${longScore}/5 (cần ${LONG_CHECKS_REQUIRED}), SHORT ${shortScore}/5 (cần ${SHORT_CHECKS_REQUIRED}).`,
      );
    }

    const entry = this.round2(snapshot.close);
    const stopLoss =
      action === DerivativeDecisionAction.LONG
        ? this.round2(entry - RISK_ATR_MULT * snapshot.atr14)
        : action === DerivativeDecisionAction.SHORT
          ? this.round2(entry + RISK_ATR_MULT * snapshot.atr14)
          : null;
    const takeProfit =
      action === DerivativeDecisionAction.LONG
        ? this.round2(entry + REWARD_ATR_MULT * snapshot.atr14)
        : action === DerivativeDecisionAction.SHORT
          ? this.round2(entry - REWARD_ATR_MULT * snapshot.atr14)
          : null;
    // V4: score gần như KHÔNG tương quan win-rate thực (data live: score 5 không hơn score 4)
    // → confidence khiêm tốn, phản ánh đúng win-rate quan sát (~50–58%), không gán 95% gây hiểu nhầm.
    const requiredForAction =
      action === DerivativeDecisionAction.LONG
        ? LONG_CHECKS_REQUIRED
        : SHORT_CHECKS_REQUIRED;
    const confidence =
      action === DerivativeDecisionAction.NO_TRADE
        ? Math.min(50, 20 + Math.abs(longScore - shortScore) * 8)
        : Math.min(72, 55 + (score - requiredForAction) * 8);

    return {
      symbol: DECISION_SYMBOL,
      contractCode,
      decidedAt,
      tradingDate,
      resolution: '5',
      algorithm: ALGORITHM,
      action,
      status:
        action === DerivativeDecisionAction.NO_TRADE
          ? DerivativeDecisionStatus.CLOSED
          : DerivativeDecisionStatus.OPEN,
      entryPrice: entry,
      stopLoss,
      takeProfit,
      riskReward:
        action === DerivativeDecisionAction.NO_TRADE
          ? null
          : this.round2(REWARD_ATR_MULT / RISK_ATR_MULT),
      score,
      confidence,
      reason: notes.join(' '),
      metadata: this.metadata(notes, snapshot),
      exitAt: action === DerivativeDecisionAction.NO_TRADE ? decidedAt : null,
      exitPrice: action === DerivativeDecisionAction.NO_TRADE ? entry : null,
      pnlPoints: action === DerivativeDecisionAction.NO_TRADE ? 0 : null,
      outcome:
        action === DerivativeDecisionAction.NO_TRADE
          ? DerivativeDecisionOutcome.NO_TRADE
          : null,
      outcomeReason:
        action === DerivativeDecisionAction.NO_TRADE
          ? 'NO_TRADE không tính P/L.'
          : null,
      notified: false,
    };
  }

  private noTradeResult(
    reason: string,
    decidedAt: Date,
    tradingDate: string,
    contractCode: string | null,
    latest: IntradayIndexBarDto | undefined,
    snapshot: IndicatorSnapshot | null,
  ): Omit<DerivativeDecision, 'id' | 'createdAt' | 'updatedAt'> {
    const price = latest ? this.price(latest.close) : null;
    return {
      symbol: DECISION_SYMBOL,
      contractCode,
      decidedAt,
      tradingDate,
      resolution: '5',
      algorithm: ALGORITHM,
      action: DerivativeDecisionAction.NO_TRADE,
      status: DerivativeDecisionStatus.CLOSED,
      entryPrice: price,
      stopLoss: null,
      takeProfit: null,
      riskReward: null,
      score: 0,
      confidence: 0,
      reason,
      metadata: this.metadata([], snapshot),
      exitAt: decidedAt,
      exitPrice: price,
      pnlPoints: 0,
      outcome: DerivativeDecisionOutcome.NO_TRADE,
      outcomeReason: 'NO_TRADE không tính P/L.',
      notified: false,
    };
  }

  private isLateSession(latestTime: Date): boolean {
    const hhmm = parseInt(
      new Intl.DateTimeFormat('en-US', {
        timeZone: 'Asia/Ho_Chi_Minh',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      })
        .format(latestTime)
        .replace(':', ''),
      10,
    );
    return hhmm >= NO_TRADE_AFTER_HHMM;
  }

  private indicators(bars: IntradayIndexBarDto[]): IndicatorSnapshot {
    const closes = bars.map((b) => this.price(b.close));
    const highs = bars.map((b) => this.price(b.high));
    const lows = bars.map((b) => this.price(b.low));
    const volumes = bars.map((b) => Number(b.volume) || 0);
    const ema9 = this.ema(closes, 9);
    const ema21 = this.ema(closes, 21);
    const ema50 = this.ema(closes, 50);
    const rsi = this.rsi(closes, 14);
    const atr = this.atr(bars, ATR_PERIOD);
    const latestIdx = bars.length - 1;
    const dayBars = this.sameVnDateBars(bars, bars[latestIdx].time);
    const vwap = this.vwap(dayBars);
    const prior = bars.slice(Math.max(0, latestIdx - 12), latestIdx);
    const vol20 = volumes.slice(Math.max(0, latestIdx - 20), latestIdx);
    const avgVol20 = vol20.length
      ? vol20.reduce((a, b) => a + b, 0) / vol20.length
      : 0;

    return {
      close: closes[latestIdx],
      ema9: ema9[latestIdx],
      ema21: ema21[latestIdx],
      ema50: ema50[latestIdx],
      emaSlope: ema9[latestIdx] - ema9[Math.max(0, latestIdx - 5)],
      rsi14: rsi[latestIdx],
      atr14: atr[latestIdx],
      vwap,
      prevHigh12: prior.length
        ? Math.max(...prior.map((b) => this.price(b.high)))
        : highs[latestIdx],
      prevLow12: prior.length
        ? Math.min(...prior.map((b) => this.price(b.low)))
        : lows[latestIdx],
      volumeRatio20: avgVol20 > 0 ? volumes[latestIdx] / avgVol20 : 1,
      latestTime: new Date(Number(bars[latestIdx].time) * 1000),
      tradingDate: this.vnDateFromUnix(Number(bars[latestIdx].time)),
    };
  }

  private async settleOpenDecisions(
    bars: IntradayIndexBarDto[],
  ): Promise<DerivativeDecision[]> {
    if (!bars.length) return [];
    const open = await this.decisionRepo.find({
      where: {
        symbol: DECISION_SYMBOL,
        status: DerivativeDecisionStatus.OPEN,
      },
      order: { decidedAt: 'ASC' },
      take: 200,
    });
    if (!open.length) return [];
    const closedDecisions: DerivativeDecision[] = [];

    for (const d of open) {
      if (
        d.action === DerivativeDecisionAction.NO_TRADE ||
        d.entryPrice == null ||
        d.stopLoss == null ||
        d.takeProfit == null
      ) {
        d.status = DerivativeDecisionStatus.CLOSED;
        d.outcome = DerivativeDecisionOutcome.NO_TRADE;
        d.pnlPoints = 0;
        d.exitAt = d.decidedAt;
        d.exitPrice = d.entryPrice;
        d.outcomeReason = 'Không có điểm vào hợp lệ.';
        await this.decisionRepo.save(d);
        closedDecisions.push(d);
        continue;
      }
      const after = bars.filter(
        (b) => Number(b.time) * 1000 > d.decidedAt.getTime(),
      );
      if (!after.length) continue;
      const entryP = Number(d.entryPrice);
      const isLong = d.action === DerivativeDecisionAction.LONG;
      const riskDist = Math.abs(entryP - Number(d.stopLoss));
      // SL động: khởi đầu = SL gốc, dời về hòa vốn khi lãi 1R, trailing khi lãi > 2R.
      let trailStop = Number(d.stopLoss);
      let movedToBreakeven = false;
      let trailing = false;
      const stopHitReason = () =>
        trailing
          ? 'Chạm trailing stop — đã khóa một phần lãi.'
          : movedToBreakeven
            ? 'Chạm SL hòa vốn (đã dời về entry sau khi lãi 1R).'
            : 'Chạm SL trước TP.';
      let exitBar: IntradayIndexBarDto | null = null;
      let exitPrice: number | null = null;
      let reason = '';
      for (const b of after) {
        const high = this.price(b.high);
        const low = this.price(b.low);
        if (isLong) {
          // 1. Kiểm tra stop (mức trail tính từ các nến TRƯỚC — không dùng high của nến hiện tại)
          if (low <= trailStop) {
            exitBar = b;
            exitPrice = trailStop;
            reason = stopHitReason();
            break;
          }
          // 2. Take-profit
          if (high >= Number(d.takeProfit)) {
            exitBar = b;
            exitPrice = Number(d.takeProfit);
            reason = 'Chạm TP.';
            break;
          }
          // 3. Cập nhật SL động theo đỉnh nến này
          const favorable = high - entryP;
          if (
            !movedToBreakeven &&
            favorable >= BREAKEVEN_TRIGGER_R * riskDist
          ) {
            trailStop = Math.max(trailStop, entryP);
            movedToBreakeven = true;
          }
          if (favorable >= (TRAIL_AFTER_R + 1) * riskDist) {
            const t = high - TRAIL_AFTER_R * riskDist;
            if (t > trailStop) {
              trailStop = t;
              trailing = true;
            }
          }
        } else {
          if (high >= trailStop) {
            exitBar = b;
            exitPrice = trailStop;
            reason = stopHitReason();
            break;
          }
          if (low <= Number(d.takeProfit)) {
            exitBar = b;
            exitPrice = Number(d.takeProfit);
            reason = 'Chạm TP.';
            break;
          }
          const favorable = entryP - low;
          if (
            !movedToBreakeven &&
            favorable >= BREAKEVEN_TRIGGER_R * riskDist
          ) {
            trailStop = Math.min(trailStop, entryP);
            movedToBreakeven = true;
          }
          if (favorable >= (TRAIL_AFTER_R + 1) * riskDist) {
            const t = low + TRAIL_AFTER_R * riskDist;
            if (t < trailStop) {
              trailStop = t;
              trailing = true;
            }
          }
        }
      }
      if (!exitBar && after.length >= SETTLE_AFTER_BARS) {
        exitBar = after[after.length - 1];
        exitPrice = this.price(exitBar.close);
        reason = `Thoát theo thời gian sau ${SETTLE_AFTER_BARS} nến 5m.`;
      }
      if (!exitBar || exitPrice == null) continue;
      // Phân loại theo P/L thực tế: hòa vốn (±0.01đ) tính trung tính, không kể là LOSS.
      const settledPnl = isLong ? exitPrice - entryP : entryP - exitPrice;
      const outcome: DerivativeDecisionOutcome =
        settledPnl > 0.01
          ? DerivativeDecisionOutcome.WIN
          : settledPnl < -0.01
            ? DerivativeDecisionOutcome.LOSS
            : DerivativeDecisionOutcome.TIME_EXIT;
      d.status = DerivativeDecisionStatus.CLOSED;
      d.exitAt = new Date(Number(exitBar.time) * 1000);
      d.exitPrice = this.round2(exitPrice);
      d.pnlPoints = this.round2(
        d.action === DerivativeDecisionAction.LONG
          ? exitPrice - Number(d.entryPrice)
          : Number(d.entryPrice) - exitPrice,
      );
      d.outcome = outcome;
      d.outcomeReason = reason;
      await this.decisionRepo.save(d);
      closedDecisions.push(d);
    }
    return closedDecisions;
  }

  private async shouldNotify(
    decision: DerivativeDecision,
    forceNotify = false,
  ): Promise<boolean> {
    if (forceNotify) return true;
    if (
      this.config.get<string>('DERIVATIVES_TELEGRAM_NOTIFY', 'true') === 'false'
    ) {
      return false;
    }
    const notifyNoTrade =
      this.config.get<string>(
        'DERIVATIVES_TELEGRAM_NOTIFY_NO_TRADE',
        'false',
      ) === 'true';
    if (
      decision.action === DerivativeDecisionAction.NO_TRADE &&
      !notifyNoTrade
    ) {
      const previous = await this.previousDecisionBefore(decision.decidedAt);
      return (
        previous?.status === DerivativeDecisionStatus.OPEN &&
        (previous.action === DerivativeDecisionAction.LONG ||
          previous.action === DerivativeDecisionAction.SHORT)
      );
    }
    if (
      decision.action === DerivativeDecisionAction.LONG ||
      decision.action === DerivativeDecisionAction.SHORT
    ) {
      const sameSideOpenNotified = await this.findOpenNotifiedDecision(
        decision.action,
        decision.decidedAt,
      );
      if (sameSideOpenNotified) return false;
    }
    const previous = await this.previousDecisionBefore(decision.decidedAt);
    if (!previous) return decision.action !== DerivativeDecisionAction.NO_TRADE;
    if (previous.action !== decision.action) return true;
    if (decision.action === DerivativeDecisionAction.NO_TRADE) return false;
    // Nếu lệnh trước cùng hướng nhưng đã đóng, đây là một trade cycle mới và cần báo lại.
    return previous.status === DerivativeDecisionStatus.CLOSED;
  }

  private findOpenNotifiedDecision(
    action: DerivativeDecisionAction.LONG | DerivativeDecisionAction.SHORT,
    at: Date,
  ): Promise<DerivativeDecision | null> {
    return this.decisionRepo
      .createQueryBuilder('d')
      .where('d.symbol = :symbol', { symbol: DECISION_SYMBOL })
      .andWhere('d.action = :action', { action })
      .andWhere('d.status = :status', { status: DerivativeDecisionStatus.OPEN })
      .andWhere('d.notified = :notified', { notified: true })
      .andWhere('d.decidedAt < :at', { at })
      .orderBy('d.decidedAt', 'DESC')
      .getOne();
  }

  private previousDecisionBefore(at: Date): Promise<DerivativeDecision | null> {
    return this.decisionRepo
      .createQueryBuilder('d')
      .where('d.symbol = :symbol', { symbol: DECISION_SYMBOL })
      .andWhere('d.decidedAt < :at', { at })
      .orderBy('d.decidedAt', 'DESC')
      .getOne();
  }

  private async notifyDecision(
    decision: DerivativeDecision,
    source: string,
    runAt?: Date,
  ): Promise<boolean> {
    const eventAt =
      runAt && !Number.isNaN(runAt.getTime()) ? runAt : decision.decidedAt;
    const time = this.formatVnTime(eventAt);
    const actionIcon =
      decision.action === DerivativeDecisionAction.LONG
        ? '🟢'
        : decision.action === DerivativeDecisionAction.SHORT
          ? '🔴'
          : '🟡';
    const actionLabel =
      decision.action === DerivativeDecisionAction.LONG
        ? 'LONG'
        : decision.action === DerivativeDecisionAction.SHORT
          ? 'SHORT'
          : 'NO TRADE';
    const linePrice =
      decision.entryPrice == null
        ? ''
        : `\n🎯 <b>Entry</b>: <code>${decision.entryPrice}</code>  |  🛡️ <b>SL</b>: <code>${decision.stopLoss ?? '-'}</code>  |  🏁 <b>TP</b>: <code>${decision.takeProfit ?? '-'}</code>`;
    const pnl =
      decision.pnlPoints == null
        ? ''
        : `\n💰 <b>P/L review</b>: <code>${decision.pnlPoints}</code> điểm (${decision.outcome ?? '-'})`;
    return this.telegramService.sendMessage({
      parseMode: 'HTML',
      text:
        `📊 <b>Phái sinh VN30 5m</b> <i>(${source})</i>\n` +
        `🕒 <b>Thời điểm</b>: <b>${time}</b>\n` +
        `${actionIcon} <b>Quyết định</b>: <b>${actionLabel}</b>  |  🎚️ <b>Confidence</b>: <b>${decision.confidence}%</b>  |  🧮 <b>Score</b>: <b>${decision.score}</b>` +
        linePrice +
        pnl +
        `\n🧠 <b>Lý do</b>: ${this.escapeHtml(decision.reason)}`,
    });
  }

  private async notifyOpenedDecision(
    decision: DerivativeDecision,
    source: string,
    runAt?: Date,
  ): Promise<boolean> {
    if (
      this.config.get<string>('DERIVATIVES_TELEGRAM_NOTIFY', 'true') === 'false'
    ) {
      return false;
    }
    if (
      decision.action !== DerivativeDecisionAction.LONG &&
      decision.action !== DerivativeDecisionAction.SHORT
    ) {
      return false;
    }
    const eventAt =
      runAt && !Number.isNaN(runAt.getTime()) ? runAt : decision.decidedAt;
    const time = this.formatVnTime(eventAt);
    const actionIcon =
      decision.action === DerivativeDecisionAction.LONG ? '🟢' : '🔴';
    const actionLabel =
      decision.action === DerivativeDecisionAction.LONG ? 'LONG' : 'SHORT';
    return this.telegramService.sendMessage({
      parseMode: 'HTML',
      text:
        `📗 <b>Phái sinh VN30 5m - Mở lệnh</b> <i>(${source})</i>\n` +
        `${actionIcon} <b>Vị thế</b>: <b>${actionLabel}</b>  |  🎚️ <b>Confidence</b>: <b>${decision.confidence}%</b>  |  🧮 <b>Score</b>: <b>${decision.score}</b>\n` +
        `🕒 <b>Thời điểm</b>: <b>${time}</b>\n` +
        `🎯 <b>Entry</b>: <code>${decision.entryPrice ?? '-'}</code>  |  🛡️ <b>SL</b>: <code>${decision.stopLoss ?? '-'}</code>  |  🏁 <b>TP</b>: <code>${decision.takeProfit ?? '-'}</code>` +
        (decision.riskReward != null
          ? `  |  ⚖️ <b>R:R</b>: <code>${decision.riskReward}</code>`
          : '') +
        `\n🧠 <b>Lý do</b>: ${this.escapeHtml(decision.reason)}`,
    });
  }

  private async notifyClosedDecision(
    decision: DerivativeDecision,
    source: string,
  ): Promise<boolean> {
    if (
      this.config.get<string>('DERIVATIVES_TELEGRAM_NOTIFY', 'true') === 'false'
    ) {
      return false;
    }
    if (
      decision.action !== DerivativeDecisionAction.LONG &&
      decision.action !== DerivativeDecisionAction.SHORT
    ) {
      return false;
    }
    if (decision.exitAt == null || decision.exitPrice == null) {
      return false;
    }
    const entryTime = this.formatVnTime(decision.decidedAt);
    const exitTime = this.formatVnTime(decision.exitAt);
    const actionIcon =
      decision.action === DerivativeDecisionAction.LONG ? '🟢' : '🔴';
    const actionLabel =
      decision.action === DerivativeDecisionAction.LONG ? 'LONG' : 'SHORT';
    const outcomeLabel = decision.outcome ?? 'CLOSED';
    const pnlText =
      decision.pnlPoints == null
        ? '-'
        : `${this.formatSigned(decision.pnlPoints)} điểm`;
    return this.telegramService.sendMessage({
      parseMode: 'HTML',
      text:
        `📕 <b>Phái sinh VN30 5m - Chốt lệnh</b> <i>(${source})</i>\n` +
        `${actionIcon} <b>Vị thế</b>: <b>${actionLabel}</b>  |  🏁 <b>Kết quả</b>: <b>${outcomeLabel}</b>\n` +
        `🕒 <b>Mở</b>: <b>${entryTime}</b>  |  🕒 <b>Đóng</b>: <b>${exitTime}</b>\n` +
        `🎯 <b>Entry</b>: <code>${decision.entryPrice ?? '-'}</code>  |  🚪 <b>Exit</b>: <code>${decision.exitPrice}</code>\n` +
        `💰 <b>P/L</b>: <b>${pnlText}</b>\n` +
        `🧠 <b>Lý do thoát</b>: ${this.escapeHtml(decision.outcomeReason ?? decision.reason)}`,
    });
  }

  private async buildDailySummary(
    tradingDate: string,
  ): Promise<DailyDerivativeSummary | null> {
    const dayRows = await this.decisionRepo.find({
      where: { symbol: DECISION_SYMBOL, tradingDate },
      order: { decidedAt: 'ASC' },
      take: 1500,
    });
    const currentOpenRows = await this.decisionRepo.find({
      where: { symbol: DECISION_SYMBOL, status: DerivativeDecisionStatus.OPEN },
      order: { decidedAt: 'ASC' },
      take: 300,
    });
    if (!dayRows.length && !currentOpenRows.length) return null;

    const dedupRows = this.deduplicateTradeRows(dayRows);
    const openedToday = dedupRows.length;
    const closedRows = dedupRows.filter(
      (row) => row.status === DerivativeDecisionStatus.CLOSED,
    );
    const pnlRows = closedRows.filter(
      (row) => row.pnlPoints != null && Number.isFinite(Number(row.pnlPoints)),
    );
    const realizedPnlPoints = this.round2(
      pnlRows.reduce((sum, row) => sum + Number(row.pnlPoints), 0),
    );
    const wins = closedRows.filter(
      (row) => row.outcome === DerivativeDecisionOutcome.WIN,
    ).length;
    const losses = closedRows.filter(
      (row) => row.outcome === DerivativeDecisionOutcome.LOSS,
    ).length;
    const timeExits = closedRows.filter(
      (row) => row.outcome === DerivativeDecisionOutcome.TIME_EXIT,
    ).length;
    const closedToday = closedRows.length;
    const openFromToday = dedupRows.filter(
      (row) => row.status === DerivativeDecisionStatus.OPEN,
    ).length;
    const openCurrent = this.deduplicateTradeRows(currentOpenRows).length;
    const decidedTotal = wins + losses + timeExits;
    const winRatePct =
      decidedTotal > 0 ? this.round2((wins / decidedTotal) * 100) : 0;

    return {
      tradingDate,
      openedToday,
      closedToday,
      openFromToday,
      openCurrent,
      wins,
      losses,
      timeExits,
      realizedPnlPoints,
      winRatePct,
    };
  }

  private deduplicateTradeRows(
    rows: DerivativeDecision[],
  ): DerivativeDecision[] {
    const map = new Map<string, DerivativeDecision>();
    for (const row of rows) {
      if (
        row.action !== DerivativeDecisionAction.LONG &&
        row.action !== DerivativeDecisionAction.SHORT
      ) {
        continue;
      }
      const key = `${row.symbol}|${row.action}|${row.decidedAt.toISOString()}`;
      const existing = map.get(key);
      if (!existing) {
        map.set(key, row);
        continue;
      }
      if (existing.status === DerivativeDecisionStatus.CLOSED) continue;
      if (row.status === DerivativeDecisionStatus.CLOSED) {
        map.set(key, row);
      }
    }
    return Array.from(map.values());
  }

  private async notifyDailySummary(
    summary: DailyDerivativeSummary,
  ): Promise<boolean> {
    const pnlText = this.formatSigned(summary.realizedPnlPoints);
    const openIcon = summary.openCurrent > 0 ? '🟠' : '🟢';
    const sent = await this.telegramService.sendMessage({
      parseMode: 'HTML',
      text:
        `📘 <b>Tổng kết phái sinh VN30 ngày ${summary.tradingDate}</b>\n` +
        `💰 <b>P/L đã chốt</b>: <b>${pnlText} điểm</b>\n` +
        `📈 <b>Win / Loss / TimeExit</b>: <b>${summary.wins} / ${summary.losses} / ${summary.timeExits}</b>  |  🎯 <b>Win rate</b>: <b>${summary.winRatePct}%</b>\n` +
        `📝 <b>Lệnh mở mới trong ngày</b>: <b>${summary.openedToday}</b>  |  ✅ <b>Đã đóng</b>: <b>${summary.closedToday}</b>  |  🔓 <b>Chưa đóng (trong ngày)</b>: <b>${summary.openFromToday}</b>\n` +
        `${openIcon} <b>Số lệnh đang OPEN hiện tại</b>: <b>${summary.openCurrent}</b>`,
    });
    if (sent) {
      this.logger.log(
        `Đã gửi tổng kết ngày ${summary.tradingDate}: pnl=${summary.realizedPnlPoints}, openCurrent=${summary.openCurrent}`,
      );
    }
    return sent;
  }

  private metadata(
    notes: string[],
    snapshot: IndicatorSnapshot | null,
  ): DerivativeDecisionMetadata {
    return {
      algorithm: ALGORITHM,
      notes,
      metrics: snapshot
        ? {
            close: this.round2(snapshot.close),
            ema9: this.round2(snapshot.ema9),
            ema21: this.round2(snapshot.ema21),
            ema50: this.round2(snapshot.ema50),
            emaSlope: this.round2(snapshot.emaSlope),
            rsi14: snapshot.rsi14 == null ? null : this.round2(snapshot.rsi14),
            atr14: snapshot.atr14 == null ? null : this.round2(snapshot.atr14),
            vwap: this.round2(snapshot.vwap),
            prevHigh12: this.round2(snapshot.prevHigh12),
            prevLow12: this.round2(snapshot.prevLow12),
            volumeRatio20: this.round2(snapshot.volumeRatio20),
          }
        : {},
    };
  }

  private explainSnapshot(s: IndicatorSnapshot): string[] {
    return [
      `Close ${this.round2(s.close)}, VWAP ${this.round2(s.vwap)}, EMA50 ${this.round2(s.ema50)}.`,
      `EMA9 ${this.round2(s.ema9)} / EMA21 ${this.round2(s.ema21)}, slope(5b) ${this.round2(s.emaSlope)}.`,
      `RSI14 ${s.rsi14 == null ? '-' : this.round2(s.rsi14)}, ATR14 ${s.atr14 == null ? '-' : this.round2(s.atr14)}.`,
      `Breakout 12 nến: high ${this.round2(s.prevHigh12)}, low ${this.round2(s.prevLow12)}, vol x${this.round2(s.volumeRatio20)}.`,
    ];
  }

  private ema(values: number[], period: number): number[] {
    if (!values.length) return [];
    const k = 2 / (period + 1);
    const seed = Math.min(period, values.length);
    const out: number[] = new Array(values.length);
    // Warmup: running SMA up to `seed` values, used as seed for EMA.
    let sum = 0;
    for (let i = 0; i < seed; i++) {
      sum += values[i];
      out[i] = sum / (i + 1);
    }
    // EMA từ index `seed` trở đi, dùng SMA(seed) làm giá trị khởi đầu.
    for (let i = seed; i < values.length; i++) {
      out[i] = values[i] * k + out[i - 1] * (1 - k);
    }
    return out;
  }

  private rsi(values: number[], period: number): Array<number | null> {
    const out = new Array<number | null>(values.length).fill(null);
    if (values.length <= period) return out;
    let gain = 0;
    let loss = 0;
    for (let i = 1; i <= period; i++) {
      const diff = values[i] - values[i - 1];
      if (diff >= 0) gain += diff;
      else loss -= diff;
    }
    let avgGain = gain / period;
    let avgLoss = loss / period;
    out[period] = this.rsiFromAvg(avgGain, avgLoss);
    for (let i = period + 1; i < values.length; i++) {
      const diff = values[i] - values[i - 1];
      avgGain = (avgGain * (period - 1) + Math.max(diff, 0)) / period;
      avgLoss = (avgLoss * (period - 1) + Math.max(-diff, 0)) / period;
      out[i] = this.rsiFromAvg(avgGain, avgLoss);
    }
    return out;
  }

  private rsiFromAvg(avgGain: number, avgLoss: number): number {
    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    return 100 - 100 / (1 + rs);
  }

  private atr(
    bars: IntradayIndexBarDto[],
    period: number,
  ): Array<number | null> {
    const out = new Array<number | null>(bars.length).fill(null);
    if (bars.length <= period) return out;
    const tr: number[] = [];
    for (let i = 0; i < bars.length; i++) {
      const high = this.price(bars[i].high);
      const low = this.price(bars[i].low);
      const prevClose = i > 0 ? this.price(bars[i - 1].close) : high;
      tr.push(
        Math.max(
          high - low,
          Math.abs(high - prevClose),
          Math.abs(low - prevClose),
        ),
      );
    }
    let avg = tr.slice(1, period + 1).reduce((a, b) => a + b, 0) / period;
    out[period] = avg;
    for (let i = period + 1; i < tr.length; i++) {
      avg = (avg * (period - 1) + tr[i]) / period;
      out[i] = avg;
    }
    return out;
  }

  private sameVnDateBars(
    bars: IntradayIndexBarDto[],
    unixSec: number,
  ): IntradayIndexBarDto[] {
    const ymd = this.vnDateFromUnix(unixSec);
    return bars.filter((b) => this.vnDateFromUnix(Number(b.time)) === ymd);
  }

  private vwap(bars: IntradayIndexBarDto[]): number {
    let pv = 0;
    let vol = 0;
    for (const b of bars) {
      const v = Number(b.volume) || 0;
      const typical =
        (this.price(b.high) + this.price(b.low) + this.price(b.close)) / 3;
      pv += typical * v;
      vol += v;
    }
    if (vol <= 0) return this.price(bars[bars.length - 1]?.close ?? 0);
    return pv / vol;
  }

  private price(v: number): number {
    const n = Number(v);
    return Number.isFinite(n) ? n / 1000 : 0;
  }

  private round2(v: number): number {
    return Math.round((v + Number.EPSILON) * 100) / 100;
  }

  private formatSigned(v: number): string {
    if (!Number.isFinite(v)) return '0';
    const rounded = this.round2(v);
    if (rounded > 0) return `+${rounded}`;
    return `${rounded}`;
  }

  private vnDateFromUnix(unixSec: number): string {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Ho_Chi_Minh',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(unixSec * 1000));
  }

  private formatVnTime(d: Date): string {
    return new Intl.DateTimeFormat('vi-VN', {
      timeZone: 'Asia/Ho_Chi_Minh',
      hour: '2-digit',
      minute: '2-digit',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
    }).format(d);
  }

  private escapeHtml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  /**
   * Xây dựng BacktestSeries từ lệnh thực tế trong DB (algorithm V3).
   * Dùng để so sánh backtest giả lập với kết quả live trên chart.
   */
  async buildLiveSeries(from: string, to: string): Promise<BacktestSeries | null> {
    const rows = await this.decisionRepo
      .createQueryBuilder('d')
      .where('d.symbol = :symbol', { symbol: DECISION_SYMBOL })
      .andWhere('d.status = :status', { status: DerivativeDecisionStatus.CLOSED })
      .andWhere('d.action IN (:...actions)', { actions: [DerivativeDecisionAction.LONG, DerivativeDecisionAction.SHORT] })
      .andWhere('d.outcome IN (:...outcomes)', {
        outcomes: [DerivativeDecisionOutcome.WIN, DerivativeDecisionOutcome.LOSS, DerivativeDecisionOutcome.TIME_EXIT],
      })
      .andWhere('d.pnlPoints IS NOT NULL')
      .andWhere('d.tradingDate BETWEEN :from AND :to', { from, to })
      .orderBy('d.decidedAt', 'ASC')
      .take(5000)
      .getMany();

    if (!rows.length) return null;

    // Dedup: cùng symbol+action+decidedAt chỉ giữ 1 bản ghi
    const seen = new Set<string>();
    const trades: Trade[] = [];
    for (const row of rows) {
      const key = `${row.action}|${row.decidedAt.toISOString()}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const outcome: Trade['outcome'] =
        row.outcome === DerivativeDecisionOutcome.WIN ? 'WIN' :
        row.outcome === DerivativeDecisionOutcome.LOSS ? 'LOSS' : 'NEUTRAL';

      trades.push({
        side: row.action as 'LONG' | 'SHORT',
        entry: Number(row.entryPrice ?? 0),
        pnl: Number(row.pnlPoints),
        rsi: (row.metadata?.metrics?.rsi14 as number | null | undefined) ?? null,
        outcome,
        date: row.tradingDate,
      });
    }

    if (!trades.length) return null;
    return buildSeries('Live V3 (thực tế DB)', 'Live', '#f43f5e', trades);
  }
}
