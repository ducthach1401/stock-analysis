import {
  BadRequestException,
  forwardRef,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Not, Repository } from 'typeorm';
import { shouldRunAnalyzeAllHistoryAfterSync } from '../common/sync-analyze-policy';
import { StockPrice } from '../stock/entities/stock-price.entity';
import { StockService } from '../stock/stock.service';
import { SignalService } from './signal.service';
import { Recommendation } from './dto/recommendation.dto';
import { BacktestRun } from './entities/backtest-run.entity';
import { SimulatedTrade } from './entities/simulated-trade.entity';
import {
  firstLegPriceFromWeightedAverage,
  isInReentryCooldown,
} from '../position/averaging-policy';
import { MIN_TRADING_SESSIONS_AFTER_ENTRY } from '../common/vn-trading-days';
import {
  evaluateMinervini,
  MarketContext,
  MINERVINI_PROFIT_LOCK_PCT,
  MINERVINI_STOP_PCT,
} from './minervini-strategy';

/**
 * Cấu hình thuật toán backtest — có thể so sánh đa chiến lược.
 * Mặc định bật cả 3 cải tiến so với V1 (strict Minervini baseline).
 */
export type BacktestConfig = {
  /** Chỉ mở lệnh khi VNINDEX > SMA50 (market uptrend). Default: true */
  marketTiming: boolean;
  /** Chỉ mua khi cổ phiếu tăng mạnh hơn VNINDEX 3 tháng (~63 phiên). Default: true */
  rsFilter: boolean;
  /** Trailing stop: hòa vốn khi lãi ≥10%, lock 50% gains khi lãi ≥20%. Default: true */
  trailingStop: boolean;
};

export const DEFAULT_BACKTEST_CONFIG: BacktestConfig = {
  marketTiming: true,
  rsFilter: true,
  trailingStop: true,
};

/** Baseline Minervini thuần — không có các bộ lọc thị trường hay trailing stop. */
export const BASELINE_BACKTEST_CONFIG: BacktestConfig = {
  marketTiming: false,
  rsFilter: false,
  trailingStop: false,
};

/** Giả lập T+2: ít nhất 2 phiên (nến) sau ngày mua mới được bán. */
function canExitAfterT2(
  entryBarIndex: number,
  currentBarIndex: number,
): boolean {
  return currentBarIndex - entryBarIndex >= MIN_TRADING_SESSIONS_AFTER_ENTRY;
}

function smaFromValues(
  values: number[],
  endIndex: number,
  length: number,
): number | null {
  if (endIndex < 0 || length <= 0 || endIndex + 1 < length) return null;
  let sum = 0;
  const start = endIndex - length + 1;
  for (let i = start; i <= endIndex; i++) sum += values[i];
  return sum / length;
}

/** Một dòng cho bảng xếp hạng backtest trên Dashboard (run mới nhất / mã). */
export interface BacktestRunSummaryRow {
  ticker: string;
  /** Compound % chỉ từ các lệnh có ngày đóng trong `rankingFrom`…`rankingTo`. */
  compoundPnlPercent: number;
  sumPnlPercent: number;
  tradeCount: number;
  winCount: number;
  /** Kỳ giả lập đầy đủ đã lưu (IPO → phiên mới nhất). */
  fullPeriodFrom: string;
  fullPeriodTo: string;
  /** Cửa sổ xếp hạng (đóng lệnh nằm trong đoạn này). */
  rankingFrom: string;
  rankingTo: string;
  createdAt: string;
}

/** Hiển thị: lệnh đóng gần đây nhất trước (ngày ra ↓, rồi ngày vào ↓). */
function sortSimulatedTradesNewestFirst(trades: SimulatedTrade[]): void {
  trades.sort((a, b) => {
    const byExit = String(b.exitDate).localeCompare(String(a.exitDate));
    if (byExit !== 0) return byExit;
    return String(b.entryDate).localeCompare(String(a.entryDate));
  });
}

/** Số tháng lăn: chỉ lệnh **đóng** trong đoạn này mới vào compound xếp hạng trang chủ. */
export const BACKTEST_LEADERBOARD_MONTHS = 12;

function formatVnYmd(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Ho_Chi_Minh',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

function lastDayOfCalendarMonth(y: number, month1to12: number): number {
  return new Date(y, month1to12, 0).getDate();
}

/** Cận dưới / trên (YYYY-MM-DD, giờ VN) cho bảng xếp hạng. */
export function leaderboardRollingWindowVn(): { from: string; to: string } {
  const to = formatVnYmd(new Date());
  const [y, m, day] = to.split('-').map((x) => parseInt(x, 10));
  let tm = m - BACKTEST_LEADERBOARD_MONTHS;
  let ty = y;
  while (tm <= 0) {
    tm += 12;
    ty -= 1;
  }
  const maxD = lastDayOfCalendarMonth(ty, tm);
  const td = Math.min(day, maxD);
  const from = `${ty}-${String(tm).padStart(2, '0')}-${String(td).padStart(2, '0')}`;
  return { from, to };
}

/**
 * Số ngày lịch không mở lại sau khi đóng lệnh giả lập.
 * - **0** (mặc định): thuật toán backtest **cũ** — khớp bản trước khi có cooldown (gần production cũ).
 * - **5**: gần `PositionService` (`POSITION_REENTRY_COOLDOWN_DAYS`).
 */
function backtestReentryCooldownDaysFromEnv(): number {
  const raw = process.env.BACKTEST_REENTRY_COOLDOWN_DAYS;
  if (raw === undefined || raw === '') return 0;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function metricsFromTradesInExitWindow(
  trades: SimulatedTrade[],
  from: string,
  to: string,
): {
  compoundPnlPercent: number;
  sumPnlPercent: number;
  tradeCount: number;
  winCount: number;
} {
  const filtered = trades.filter((t) => {
    const ex = String(t.exitDate).slice(0, 10);
    return ex >= from && ex <= to;
  });
  if (filtered.length === 0) {
    return {
      compoundPnlPercent: 0,
      sumPnlPercent: 0,
      tradeCount: 0,
      winCount: 0,
    };
  }
  const ordered = [...filtered].sort((a, b) =>
    String(a.exitDate).localeCompare(String(b.exitDate)),
  );
  const sumPnl = ordered.reduce((s, x) => s + Number(x.pnlPercent), 0);
  const compound =
    (ordered.reduce((acc, x) => acc * (1 + Number(x.pnlPercent) / 100), 1) -
      1) *
    100;
  const winCount = ordered.filter((x) => Number(x.pnlPercent) > 0).length;
  return {
    compoundPnlPercent: Number(compound.toFixed(4)),
    sumPnlPercent: Number(sumPnl.toFixed(4)),
    tradeCount: ordered.length,
    winCount,
  };
}

@Injectable()
export class SignalBacktestService {
  private readonly logger = new Logger(SignalBacktestService.name);

  constructor(
    @InjectRepository(BacktestRun)
    private readonly runRepo: Repository<BacktestRun>,
    @InjectRepository(SimulatedTrade)
    private readonly tradeRepo: Repository<SimulatedTrade>,
    @InjectRepository(StockPrice)
    private readonly stockRepo: Repository<StockPrice>,
    @Inject(forwardRef(() => StockService))
    private readonly stockService: StockService,
    private readonly signalService: SignalService,
  ) {}

  /**
   * Giả lập trên **toàn bộ nến giá** đã lưu (IPO → phiên mới nhất).
   * Xếp hạng trang chủ dùng cửa sổ **12 tháng** (theo ngày đóng lệnh) — xem `getBacktestGoodBad`.
   *
   * @param config Bộ lọc thuật toán — mặc định dùng `DEFAULT_BACKTEST_CONFIG` (market timing + RS + trailing stop).
   *               Truyền `BASELINE_BACKTEST_CONFIG` để so sánh với Minervini thuần.
   */
  async runBacktest(
    ticker: string,
    config: BacktestConfig = DEFAULT_BACKTEST_CONFIG,
  ): Promise<BacktestRun & { trades: SimulatedTrade[] }> {
    const t = ticker.toUpperCase();
    const reentryCooldownDays = backtestReentryCooldownDaysFromEnv();

    let syncSaved = 0;
    let syncMode = 'incremental';
    try {
      const r = await this.stockService.syncHistorySmart(t);
      syncSaved = r.saved;
      syncMode = r.mode;
    } catch (e) {
      this.logger.warn(
        `${t}: sync giá trước backtest — ${(e as Error).message} (dùng nến DB hiện có)`,
      );
    }

    if (
      shouldRunAnalyzeAllHistoryAfterSync({
        isFullPriceSync: false,
        smartMode: syncMode,
        savedBarCount: syncSaved,
      })
    ) {
      try {
        await this.signalService.analyzeAllHistory(t);
      } catch (e) {
        this.logger.warn(
          `${t}: analyzeAllHistory trước backtest — ${(e as Error).message}`,
        );
      }
    }

    const bars = await this.stockRepo.find({
      where: { ticker: t },
      order: { tradingDate: 'ASC' },
    });
    if (bars.length < 20) {
      throw new BadRequestException(
        `${t}: quá ít nến để backtest (${bars.length}), cần ≥20 phiên giá`,
      );
    }

    const periodFrom = bars[0].tradingDate;
    const periodTo = bars[bars.length - 1].tradingDate;

    const closes = bars.map((b) => Number(b.close));

    // ── VNINDEX data cho market timing + RS filter ─────────────────────────────
    // Chỉ load khi cần (tránh query thừa khi dùng BASELINE config)
    let vnCtxByDate: Map<string, MarketContext> | null = null;
    if (config.marketTiming || config.rsFilter) {
      const vnBars = await this.stockRepo.find({
        where: { ticker: 'VNINDEX' },
        order: { tradingDate: 'ASC' },
      });
      if (vnBars.length >= 50) {
        const vnCloses = vnBars.map((b) => Number(b.close));
        const vnDates = vnBars.map((b) => b.tradingDate);
        const vnIdx = new Map<string, number>(vnDates.map((d, i) => [d, i]));
        vnCtxByDate = new Map<string, MarketContext>();
        for (let vi = 0; vi < vnBars.length; vi++) {
          const vnClose = vnCloses[vi];
          const vnSma50 = vi >= 49
            ? vnCloses.slice(vi - 49, vi + 1).reduce((a, b) => a + b, 0) / 50
            : null;
          const vnReturn3M = vi >= 63
            ? ((vnClose - vnCloses[vi - 63]) / vnCloses[vi - 63]) * 100
            : null;
          vnCtxByDate.set(vnDates[vi], {
            vnindexClose: vnClose,
            vnindexSma50: vnSma50,
            stockReturn3M: null, // sẽ được điền riêng theo từng cổ phiếu
            vnindexReturn3M: vnReturn3M,
          });
        }
        void vnIdx; // chỉ dùng để build map
      } else {
        this.logger.warn(`${t}: VNINDEX chưa đủ 50 nến — bỏ qua market timing / RS filter`);
      }
    }

    type Draft = {
      entryDate: string;
      entryPrice: number;
      entryRecommendation: string;
      entryStrength: string | null;
      entryReason: string | null;
      averageDownCount: number;
      averageDownLegs: null;
      takeProfitTarget: number | null;
      stopLossAtEntry: number | null;
      exitDate: string;
      exitPrice: number;
      exitRecommendation: string;
      exitSellStrength: string | null;
      exitReason: string | null;
      pnlPercent: number;
    };

    const closed: Draft[] = [];
    /** Ngày đóng lệnh gần nhất — chỉ chặn mở lại khi `reentryCooldownDays` > 0 */
    let lastExitDate: string | null = null;
    let pos: {
      entryDate: string;
      entryBarIndex: number;
      entryPrice: number;
      entryRecommendation: string;
      entryStrength: string | null;
      entryReason: string | null;
      takeProfitTarget: number | null;
      stopLossAtEntry: number | null;
      /** Stop loss động — khởi đầu = stopLossAtEntry, tăng dần khi trailing stop bật */
      trailStop: number;
      peakPrice: number;
    } | null = null;

    for (let i = 0; i < bars.length; i++) {
      const bar = bars[i];
      const close = closes[i];
      const sma10 = smaFromValues(closes, i, 10);

      if (pos) {
        const t2Ok = canExitAfterT2(pos.entryBarIndex, i);
        pos.peakPrice = Math.max(pos.peakPrice, close);
        const pnlPct = ((close - pos.entryPrice) / pos.entryPrice) * 100;

        // ── Trailing stop: nâng stop khi lãi đủ ngưỡng (sau T+2) ───────────────
        if (config.trailingStop && t2Ok) {
          // Hòa vốn khi lãi ≥ 10%
          if (pnlPct >= 10) {
            pos.trailStop = Math.max(pos.trailStop, pos.entryPrice);
          }
          // Lock 50% gains khi lãi ≥ 20% và giá đã chạy từ entry
          if (pnlPct >= 20 && pos.peakPrice > pos.entryPrice) {
            const lockAt = pos.entryPrice + 0.5 * (pos.peakPrice - pos.entryPrice);
            pos.trailStop = Math.max(pos.trailStop, lockAt);
          }
        }

        // ── Exit 1: Stop / Trailing stop (sau T+2) ──────────────────────────────
        if (t2Ok && close <= pos.trailStop) {
          const pnlPercent = ((close - pos.entryPrice) / pos.entryPrice) * 100;
          const isTrail = pos.trailStop > pos.stopLossAtEntry!;
          closed.push({
            entryDate: pos.entryDate,
            entryPrice: pos.entryPrice,
            entryRecommendation: pos.entryRecommendation,
            entryStrength: pos.entryStrength,
            entryReason: pos.entryReason,
            averageDownCount: 0,
            averageDownLegs: null,
            takeProfitTarget: pos.takeProfitTarget,
            stopLossAtEntry: pos.stopLossAtEntry,
            exitDate: bar.tradingDate,
            exitPrice: close,
            exitRecommendation: isTrail ? 'MINERVINI_TRAIL' : 'MINERVINI_STOP',
            exitSellStrength: null,
            exitReason: isTrail
              ? `Trailing stop: đóng ${close.toLocaleString('vi-VN')} ≤ trail ${Math.round(pos.trailStop).toLocaleString('vi-VN')} (bảo vệ lãi)`
              : `Cắt lỗ: đóng ${close.toLocaleString('vi-VN')} ≤ stop ${Math.round(pos.trailStop).toLocaleString('vi-VN')} (sau T+2)`,
            pnlPercent: Number(pnlPercent.toFixed(4)),
          });
          lastExitDate = bar.tradingDate;
          pos = null;
          continue;
        }

        // ── Exit 2: Take profit (sau T+2) ───────────────────────────────────────
        if (t2Ok && pos.takeProfitTarget != null && close >= pos.takeProfitTarget) {
          const pnlPercent = ((close - pos.entryPrice) / pos.entryPrice) * 100;
          closed.push({
            entryDate: pos.entryDate,
            entryPrice: pos.entryPrice,
            entryRecommendation: pos.entryRecommendation,
            entryStrength: pos.entryStrength,
            entryReason: pos.entryReason,
            averageDownCount: 0,
            averageDownLegs: null,
            takeProfitTarget: pos.takeProfitTarget,
            stopLossAtEntry: pos.stopLossAtEntry,
            exitDate: bar.tradingDate,
            exitPrice: close,
            exitRecommendation: 'MINERVINI_TARGET',
            exitSellStrength: null,
            exitReason: `Chốt target sau T+2: đóng ${close.toLocaleString('vi-VN')} ≥ ${Math.round(pos.takeProfitTarget).toLocaleString('vi-VN')}`,
            pnlPercent: Number(pnlPercent.toFixed(4)),
          });
          lastExitDate = bar.tradingDate;
          pos = null;
          continue;
        }

        // ── Exit 3: Profit lock khi lãi ≥ 20% + dưới MA10 / rút 8% từ đỉnh ────
        const peakPnlPct = ((pos.peakPrice - pos.entryPrice) / pos.entryPrice) * 100;
        const drawdownFromPeak = (pos.peakPrice - close) / pos.peakPrice;
        if (
          t2Ok &&
          pnlPct >= MINERVINI_PROFIT_LOCK_PCT * 100 &&
          ((sma10 != null && close < sma10) || drawdownFromPeak >= 0.08)
        ) {
          const pnlPercent = ((close - pos.entryPrice) / pos.entryPrice) * 100;
          closed.push({
            entryDate: pos.entryDate,
            entryPrice: pos.entryPrice,
            entryRecommendation: pos.entryRecommendation,
            entryStrength: pos.entryStrength,
            entryReason: pos.entryReason,
            averageDownCount: 0,
            averageDownLegs: null,
            takeProfitTarget: pos.takeProfitTarget,
            stopLossAtEntry: pos.stopLossAtEntry,
            exitDate: bar.tradingDate,
            exitPrice: close,
            exitRecommendation: 'MINERVINI_PROFIT_LOCK',
            exitSellStrength: null,
            exitReason: `Chặn lãi: đỉnh lãi ${peakPnlPct.toFixed(1)}%, đóng dưới MA10 hoặc giảm ${(drawdownFromPeak * 100).toFixed(1)}% từ đỉnh`,
            pnlPercent: Number(pnlPercent.toFixed(4)),
          });
          lastExitDate = bar.tradingDate;
          pos = null;
          continue;
        }
      } else if (
        !isInReentryCooldown(lastExitDate, bar.tradingDate, reentryCooldownDays)
      ) {
        // ── Chuẩn bị MarketContext (market timing + RS filter) ─────────────────
        let ctx: MarketContext | undefined;
        if (vnCtxByDate != null) {
          const vnBase = vnCtxByDate.get(bar.tradingDate);
          if (vnBase != null) {
            const stockReturn3M = i >= 63
              ? ((close - closes[i - 63]) / closes[i - 63]) * 100
              : null;
            ctx = { ...vnBase, stockReturn3M };
          }
        }

        const evalBars = bars.slice(0, i + 1).map((b) => ({
          open: Number(b.open),
          high: Number(b.high),
          low: Number(b.low),
          close: Number(b.close),
          volume: Number(b.volume),
          tradingDate: b.tradingDate,
        }));
        const setup = evaluateMinervini(evalBars, ctx);
        if (setup.recommendation !== Recommendation.STRONG_BUY) continue;

        // evaluateMinervini đã kiểm tra marketTimingOk && rsOk trong recommendation
        // khi ctx được cung cấp — STRONG_BUY chỉ pass khi cả 2 đều ok

        const initStop = setup.stopLoss ?? Math.round(close * (1 - MINERVINI_STOP_PCT));
        pos = {
          entryDate: bar.tradingDate,
          entryBarIndex: i,
          entryPrice: close,
          entryRecommendation: 'MINERVINI_STRONG_BUY',
          entryStrength: 'STRONG',
          entryReason: `Strict Minervini: ${setup.reasons.join(' · ')}`,
          takeProfitTarget: setup.targetPrice,
          stopLossAtEntry: initStop,
          trailStop: initStop,
          peakPrice: close,
        };
      }
    }

    if (pos && bars.length) {
      const last = bars[bars.length - 1];
      const close = Number(last.close);
      const pnlPercent = ((close - pos.entryPrice) / pos.entryPrice) * 100;
      lastExitDate = last.tradingDate;
      closed.push({
        entryDate: pos.entryDate,
        entryPrice: pos.entryPrice,
        entryRecommendation: pos.entryRecommendation,
        entryStrength: pos.entryStrength,
        entryReason: pos.entryReason,
        averageDownCount: 0,
        averageDownLegs: null,
        takeProfitTarget: pos.takeProfitTarget,
        stopLossAtEntry: pos.stopLossAtEntry,
        exitDate: last.tradingDate,
        exitPrice: close,
        exitRecommendation: 'END_OF_PERIOD',
        exitSellStrength: null,
        exitReason:
          'Cuối kỳ · đóng theo giá phiên cuối (cưỡng bức, có thể trước T+2)',
        pnlPercent: Number(pnlPercent.toFixed(4)),
      });
    }

    const sumPnl = closed.reduce((s, x) => s + x.pnlPercent, 0);
    const compound =
      (closed.reduce((acc, x) => acc * (1 + x.pnlPercent / 100), 1) - 1) * 100;
    const winCount = closed.filter((x) => x.pnlPercent > 0).length;

    const run = this.runRepo.create({
      ticker: t,
      periodFrom,
      periodTo,
      tradingDays: bars.length,
      tradeCount: closed.length,
      winCount,
      sumPnlPercent: Number(sumPnl.toFixed(4)),
      compoundPnlPercent: Number(compound.toFixed(4)),
      strongBuyEntryOnly: true,
      strongSellExitOnly: true,
      trades: closed.map((c) =>
        this.tradeRepo.create({
          entryDate: c.entryDate,
          entryPrice: c.entryPrice,
          entryRecommendation: c.entryRecommendation,
          entryStrength: c.entryStrength,
          entryReason: c.entryReason,
          averageDownCount: c.averageDownCount,
          averageDownLegs: c.averageDownLegs,
          takeProfitTarget: c.takeProfitTarget,
          stopLossAtEntry: c.stopLossAtEntry,
          exitDate: c.exitDate,
          exitPrice: c.exitPrice,
          exitRecommendation: c.exitRecommendation,
          exitSellStrength: c.exitSellStrength,
          exitReason: c.exitReason,
          pnlPercent: c.pnlPercent,
        }),
      ),
    });

    const saved = await this.runRepo.save(run);

    const del = await this.runRepo.delete({
      ticker: t,
      id: Not(saved.id),
    });
    if (del.affected && del.affected > 0) {
      this.logger.log(
        `${t}: đã xóa ${del.affected} backtest cũ — chỉ giữ run #${saved.id}`,
      );
    }

    this.logger.log(
      `${t} backtest ${periodFrom}→${periodTo}: ${closed.length} lệnh, Σ%=${sumPnl.toFixed(2)} compound=${compound.toFixed(2)}%`,
    );

    const full = await this.runRepo.findOne({
      where: { id: saved.id },
      relations: ['trades'],
    });
    if (!full) throw new Error('backtest save failed');
    if (full.trades?.length) sortSimulatedTradesNewestFirst(full.trades);
    return full as BacktestRun & { trades: SimulatedTrade[] };
  }

  async listRuns(ticker: string, take = 20): Promise<BacktestRun[]> {
    return this.runRepo.find({
      where: { ticker: ticker.toUpperCase() },
      order: { createdAt: 'DESC', id: 'DESC' },
      take,
    });
  }

  async getRun(
    ticker: string,
    runId: number,
  ): Promise<BacktestRun & { trades: SimulatedTrade[] }> {
    const run = await this.runRepo.findOne({
      where: { id: runId, ticker: ticker.toUpperCase() },
      relations: ['trades'],
    });
    if (!run) {
      throw new NotFoundException('Không tìm thấy backtest');
    }
    if (run.trades?.length) sortSimulatedTradesNewestFirst(run.trades);
    const trades = (run.trades ?? []).map((t) => {
      const ep = Number(t.entryPrice);
      const legs = t.averageDownLegs ?? [];
      const firstEntryPrice =
        legs.length > 0
          ? Math.round(firstLegPriceFromWeightedAverage(ep, legs))
          : ep;
      return { ...t, firstEntryPrice };
    });
    return { ...run, trades } as BacktestRun & {
      trades: (SimulatedTrade & { firstEntryPrice: number })[];
    };
  }

  /**
   * Run mới nhất mỗi mã (id giảm dần — lần đầu gặp ticker là bản mới nhất).
   */
  async listLatestRunPerTicker(): Promise<BacktestRun[]> {
    const all = await this.runRepo.find({ order: { id: 'DESC' } });
    const byTicker = new Map<string, BacktestRun>();
    for (const run of all) {
      if (!byTicker.has(run.ticker)) {
        byTicker.set(run.ticker, run);
      }
    }
    return [...byTicker.values()];
  }

  /**
   * Top / bottom theo **compound %** (lãi gộp giả lập) trên run mới nhất từng mã.
   */
  async getBacktestGoodBad(limit: number): Promise<{
    good: BacktestRunSummaryRow[];
    bad: BacktestRunSummaryRow[];
    total: number;
  }> {
    const baseRuns = await this.listLatestRunPerTicker();
    const total = baseRuns.length;
    if (total === 0) {
      return { good: [], bad: [], total: 0 };
    }
    const ids = baseRuns.map((r) => r.id);
    const withTrades = await this.runRepo.find({
      where: { id: In(ids) },
      relations: ['trades'],
    });
    const { from: rankingFrom, to: rankingTo } = leaderboardRollingWindowVn();

    const rows: BacktestRunSummaryRow[] = withTrades.map((run) => {
      const m = metricsFromTradesInExitWindow(
        run.trades ?? [],
        rankingFrom,
        rankingTo,
      );
      return {
        ticker: run.ticker,
        compoundPnlPercent: m.compoundPnlPercent,
        sumPnlPercent: m.sumPnlPercent,
        tradeCount: m.tradeCount,
        winCount: m.winCount,
        fullPeriodFrom: run.periodFrom,
        fullPeriodTo: run.periodTo,
        rankingFrom,
        rankingTo,
        createdAt:
          run.createdAt instanceof Date
            ? run.createdAt.toISOString()
            : String(run.createdAt),
      };
    });

    const eligible = rows.filter((r) => r.tradeCount > 0);
    const lim = Math.min(Math.max(1, limit), 50);
    const desc = [...eligible].sort(
      (a, b) => Number(b.compoundPnlPercent) - Number(a.compoundPnlPercent),
    );
    const asc = [...eligible].sort(
      (a, b) => Number(a.compoundPnlPercent) - Number(b.compoundPnlPercent),
    );
    return {
      good: desc.slice(0, lim),
      bad: asc.slice(0, lim),
      total,
    };
  }
}
