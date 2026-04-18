import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { Recommendation } from '../signal/dto/recommendation.dto';
import { RecommendationService } from '../signal/recommendation.service';
import { SignalDirection } from '../signal/entities/signal.entity';
import { SignalService } from '../signal/signal.service';
import { StockService } from '../stock/stock.service';
import { TelegramService } from '../telegram/telegram.service';
import { PositionService } from '../position/position.service';
import { WatchlistService } from '../watchlist/watchlist.service';
import { IntradayBreakoutNotifyService } from './intraday-breakout-notify.service';
import { mapPool } from '../common/map-pool';
import {
  parseTelegramBuyNotifyMode,
  shouldIncludeBuyInTelegram,
  TelegramBuyNotifyMode,
} from '../common/telegram-buy-notify-policy';
import { shouldRunAnalyzeAllHistoryAfterSync } from '../common/sync-analyze-policy';
import {
  isVnAfterMarketCloseForDailySignals,
  isVnCashMarketSessionOpen,
} from '../common/vn-trading-days';
import {
  isMarketIndexTicker,
  MARKET_INDEX_TICKERS,
  tickerCapLiquidityRank,
} from './watchlist';

const REC_CONF_ORDER: Record<'HIGH' | 'MEDIUM' | 'LOW', number> = {
  HIGH: 3,
  MEDIUM: 2,
  LOW: 1,
};

@Injectable()
export class ScannerService {
  private readonly logger = new Logger(ScannerService.name);
  private isRunning = false;

  constructor(
    private readonly stockService: StockService,
    private readonly signalService: SignalService,
    private readonly telegramService: TelegramService,
    private readonly recommendationService: RecommendationService,
    private readonly positionService: PositionService,
    private readonly watchlistService: WatchlistService,
    private readonly config: ConfigService,
    private readonly intradayBreakoutNotify: IntradayBreakoutNotifyService,
  ) {}

  /**
   * VNINDEX / VN30 luôn đứng đầu — cập nhật chỉ số trong phiên + phân tích nến
   * dù hai mã có bị tắt trên watchlist hay không.
   */
  private mergeActiveTickersWithMarketIndices(active: string[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const t of [...Array.from(MARKET_INDEX_TICKERS), ...active]) {
      const u = t.toUpperCase();
      if (seen.has(u)) continue;
      seen.add(u);
      out.push(u);
    }
    return out;
  }

  private syncPoolSize(): number {
    const n = parseInt(
      this.config.get<string>('SYNC_TICKERS_CONCURRENCY', '4') ?? '4',
      10,
    );
    return Number.isFinite(n) && n >= 1 && n <= 32 ? n : 4;
  }

  /** Giới hạn dòng MUA/BÁN trong tin 16:00 — tránh loãng. */
  private telegramRecommendCap(side: 'buy' | 'sell'): number {
    const key =
      side === 'buy'
        ? 'TELEGRAM_RECOMMEND_MAX_BUYS'
        : 'TELEGRAM_RECOMMEND_MAX_SELLS';
    const raw = this.config.get<string>(key, '8') ?? '8';
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n >= 1 && n <= 40 ? n : 8;
  }

  /** Báo cáo quét 15:45 — tối đa bao nhiêu mã mỗi nhóm Tăng/Giảm. */
  private telegramDailySignalCap(): number {
    const raw =
      this.config.get<string>('TELEGRAM_DAILY_MAX_STOCKS_PER_SIDE', '10') ??
      '10';
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n >= 3 && n <= 50 ? n : 10;
  }

  /** Chỉ vài loại tín hiệu đầu + gợi ý còn lại — tin ngắn. */
  private formatDailySignalTypes(types: string[]): string {
    if (!types.length) return '—';
    const max = 2;
    const head = types.slice(0, max);
    const rest = types.length - head.length;
    return rest > 0 ? `${head.join(', ')} <i>+${rest}</i>` : head.join(', ');
  }

  // ─── Cron jobs ────────────────────────────────────────────────────────

  // Sync dữ liệu giá: T2-T6 lúc 15:30 (sau ATC 14:45, chờ DNSE cập nhật)
  @Cron('30 15 * * 1-5', { timeZone: 'Asia/Ho_Chi_Minh' })
  async scheduledSync() {
    this.logger.log('⏰ [Cron] Bắt đầu sync dữ liệu giá...');
    const { ran } = await this.syncAll();
    if (ran) {
      await this.intradayBreakoutNotify.notifyDayCloseConfirmAfterSync();
    }
  }

  // Quét tín hiệu + phân phối đỉnh: T2-T6 lúc 15:45
  @Cron('45 15 * * 1-5', { timeZone: 'Asia/Ho_Chi_Minh' })
  async scheduledScan() {
    this.logger.log('⏰ [Cron] Bắt đầu quét tín hiệu...');
    await this.scanAll();
  }

  // Theo dõi vị thế đang mở: T2-T6 lúc 15:35 (sau sync 15:30)
  @Cron('35 15 * * 1-5', { timeZone: 'Asia/Ho_Chi_Minh' })
  async scheduledTrackPositions() {
    this.logger.log('⏰ [Cron] Theo dõi vị thế đang mở...');
    await this.positionService.trackAll();
  }

  // Gửi khuyến nghị + cảnh báo phân phối: T2-T6 lúc 16:00
  @Cron('0 16 * * 1-5', { timeZone: 'Asia/Ho_Chi_Minh' })
  async scheduledRecommend() {
    this.logger.log('⏰ [Cron] Gửi khuyến nghị lên Telegram...');
    await this.recommendAll();
  }

  /**
   * Trong phiên: sync giá + phân tích nến/tín hiệu (~7 phút/lần, có thể đổi biểu thức cron).
   * Khuyến nghị tự động / mở vị thế vẫn chỉ sau đóng cửa (scheduledRecommend 16:00).
   */
  @Cron('*/7 9-14 * * 1-5', { timeZone: 'Asia/Ho_Chi_Minh' })
  async scheduledIntradaySyncAnalyze() {
    if (!isVnCashMarketSessionOpen()) return;
    if (this.isRunning) return;
    this.logger.log('⏰ [Cron] Sync nến ngày + phân tích trong phiên...');
    const { ran } = await this.syncIntradayAll();
    if (ran) {
      await this.intradayBreakoutNotify.processWatchlistAfterSync();
    }
  }

  // Kiểm tra biến động intraday: T2-T6 mỗi 30 phút trong giờ sàn
  @Cron('*/30 9-14 * * 1-5', { timeZone: 'Asia/Ho_Chi_Minh' })
  async scheduledIntradayAlert() {
    if (!isVnCashMarketSessionOpen()) return;

    this.logger.log('⏰ [Cron] Kiểm tra biến động intraday...');
    await this.intradayAlertAll();
  }

  /**
   * Phái sinh VN30 (tham chiếu chỉ số): mỗi 5 phút trong phiên — nến ngày hiện tại + quét tín hiệu.
   * Tắt: DERIVATIVES_VN30_FIVE_MIN_SCAN=false
   */
  @Cron('*/5 9-14 * * 1-5', { timeZone: 'Asia/Ho_Chi_Minh' })
  async scheduledDerivativesVn30FiveMinScan() {
    if (
      this.config.get<string>('DERIVATIVES_VN30_FIVE_MIN_SCAN', 'true') ===
      'false'
    ) {
      return;
    }
    if (!isVnCashMarketSessionOpen()) return;
    try {
      await this.stockService.syncIntradaySessionBar('VN30');
      await this.signalService.analyze('VN30');
      this.logger.log('⏰ [Cron] Phái sinh VN30: sync phiên + analyze');
    } catch (e) {
      this.logger.warn(`[Cron] Phái sinh VN30: ${(e as Error).message}`);
    }
  }

  // ─── Manual triggers ─────────────────────────────────────────────────

  /**
   * Trong phiên: chỉ đồng bộ **nến ngày hiện tại** (API nhẹ), rồi `analyze` — không `analyzeAllHistory`.
   */
  async syncIntradayAll(): Promise<{
    result: Record<string, number>;
    ran: boolean;
  }> {
    if (this.isRunning) {
      this.logger.warn('Scanner đang chạy, bỏ qua sync intraday');
      return { result: {}, ran: false };
    }
    this.isRunning = true;
    const active = await this.watchlistService.getActiveTickers();
    const tickers = this.mergeActiveTickersWithMarketIndices(active);
    const result: Record<string, number> = {};

    try {
      const pool = this.syncPoolSize();
      this.logger.log(
        `Bắt đầu sync intraday (chỉ nến ngày VN, luôn gồm VNINDEX/VN30) — ${tickers.length} mã, song song ≤${pool}...`,
      );
      await mapPool(tickers, pool, async (ticker) => {
        try {
          const r = await this.stockService.syncIntradaySessionBar(ticker);
          result[ticker] = r.saved;
          await this.signalService.analyze(ticker);
        } catch (e) {
          this.logger.error(
            `Sync intraday lỗi ${ticker}: ${(e as Error).message}`,
          );
          result[ticker] = -1;
        }
      });

      const ok = Object.values(result).filter((v) => v >= 0).length;
      this.logger.log(`✅ Sync intraday xong: ${ok}/${tickers.length} mã`);
    } finally {
      this.isRunning = false;
    }

    return { result, ran: true };
  }

  async syncAll(
    from?: string,
  ): Promise<{ result: Record<string, number>; ran: boolean }> {
    if (this.isRunning) {
      this.logger.warn('Scanner đang chạy, bỏ qua lần này');
      return { result: {}, ran: false };
    }
    this.isRunning = true;
    const tickers = await this.watchlistService.getActiveTickers();
    const result: Record<string, number> = {};
    const fromLabel = from ?? 'mặc định (1 năm)';

    try {
      const pool = this.syncPoolSize();
      this.logger.log(
        `Bắt đầu sync ${tickers.length} mã từ ${fromLabel} (song song ≤${pool})...`,
      );
      await mapPool(tickers, pool, async (ticker) => {
        try {
          const r = await this.stockService.syncHistorySmart(ticker, from);
          result[ticker] = r.saved;
          try {
            await this.signalService.analyze(ticker);
            if (
              shouldRunAnalyzeAllHistoryAfterSync({
                isFullPriceSync: false,
                smartMode: r.mode,
                savedBarCount: r.saved,
              })
            ) {
              await this.signalService.analyzeAllHistory(ticker, from);
            }
          } catch (e) {
            this.logger.warn(
              `Tín hiệu sau sync ${ticker}: ${(e as Error).message}`,
            );
          }
        } catch (e) {
          this.logger.error(`Sync lỗi ${ticker}: ${(e as Error).message}`);
          result[ticker] = -1;
        }
      });

      const total = Object.values(result)
        .filter((v) => v > 0)
        .reduce((a, b) => a + b, 0);
      this.logger.log(
        `✅ Sync xong: ${total} records mới từ ${tickers.length} mã (from=${fromLabel})`,
      );
    } finally {
      this.isRunning = false;
    }

    return { result, ran: true };
  }

  async scanAll(): Promise<void> {
    const watchlist = await this.watchlistService.findActiveSortedByPriority();
    const allSignals: Array<{
      ticker: string;
      name: string;
      sector: string;
      bullish: string[];
      bearish: string[];
    }> = [];

    for (const stock of watchlist) {
      try {
        await this.signalService.analyze(stock.ticker);
        const signals = await this.signalService.getSignalsForLatestSession(
          stock.ticker,
        );
        const bullish = signals
          .filter((s) => s.direction === SignalDirection.BULLISH)
          .map((s) => s.type.toString());
        const bearish = signals
          .filter((s) => s.direction === SignalDirection.BEARISH)
          .map((s) => s.type.toString());

        if (bullish.length || bearish.length) {
          allSignals.push({ ...stock, bullish, bearish });
        }
        await delay(200);
      } catch (e) {
        this.logger.error(`Scan lỗi ${stock.ticker}: ${(e as Error).message}`);
      }
    }

    if (!allSignals.length) {
      this.logger.log('Không có tín hiệu mới hôm nay');
      return;
    }

    await this.sendDailySummary(allSignals, watchlist.length);
  }

  async intradayAlertAll(): Promise<void> {
    const tickers = await this.watchlistService.getActiveTickers();
    for (const ticker of tickers) {
      try {
        await this.stockService.checkAndAlert(ticker, 3);
        await delay(300);
      } catch (e) {
        this.logger.error(`Alert lỗi ${ticker}: ${(e as Error).message}`);
      }
    }
  }

  async recommendAll(): Promise<void> {
    const watchlist = await this.watchlistService.findActiveSortedByPriority();
    const date = new Date().toLocaleDateString('vi-VN', {
      timeZone: 'Asia/Ho_Chi_Minh',
    });
    const buyNotifyMode: TelegramBuyNotifyMode = parseTelegramBuyNotifyMode(
      this.config.get<string>('TELEGRAM_BUY_NOTIFY_MODE'),
    );
    const allowDailyTradeSignals = isVnAfterMarketCloseForDailySignals();
    if (!allowDailyTradeSignals) {
      this.logger.log(
        'Khuyến nghị: chưa sau đóng cửa (nến ngày chưa xác nhận) — bỏ qua Telegram MUA/BÁN và mở vị thế',
      );
    }

    const buyRows: { rank: number; conf: number; line: string }[] = [];
    const distRows: { rank: number; conf: number; line: string }[] = [];

    for (const stock of watchlist) {
      try {
        const result = await this.recommendationService.recommend(stock.ticker);
        const pt = result.priceTarget;
        const rec = result.recommendation;
        const rank = tickerCapLiquidityRank(stock.ticker);
        const conf = REC_CONF_ORDER[result.confidence] ?? 0;

        if (rec === Recommendation.STRONG_BUY || rec === Recommendation.BUY) {
          let scale: Awaited<
            ReturnType<PositionService['openOrScaleIn']>
          > | null = null;
          if (allowDailyTradeSignals) {
            scale = await this.positionService.openOrScaleIn(result);
          }
          const includeBuyTelegram = shouldIncludeBuyInTelegram(
            buyNotifyMode,
            result,
          );
          const priceStr = pt
            ? ` ${(pt.currentPrice / 1000).toFixed(1)}k→${(pt.targetPrice / 1000).toFixed(1)}k +${pt.upside.toFixed(0)}%`
            : '';
          const star = result.confidence === 'HIGH' ? ' ⭐' : '';
          let shortExtra = '';
          if (
            scale?.outcome === 'AVERAGED' &&
            scale.weightedEntryPrice != null
          ) {
            shortExtra = ` <i>TB ${(scale.weightedEntryPrice / 1000).toFixed(1)}k</i>`;
          }
          if (
            allowDailyTradeSignals &&
            includeBuyTelegram &&
            !isMarketIndexTicker(stock.ticker)
          ) {
            buyRows.push({
              rank,
              conf,
              line: `  • <b>${stock.ticker}</b>${star}${priceStr}${shortExtra}`,
            });
          }
        } else if (
          rec === Recommendation.STRONG_SELL ||
          rec === Recommendation.SELL
        ) {
          const priceStr = pt ? ` ${(pt.currentPrice / 1000).toFixed(1)}k` : '';
          const star = result.confidence === 'HIGH' ? ' ⭐' : '';
          const topSignal =
            result.bearishSignals[0]?.type.replace(/_/g, ' ') ?? '';
          if (allowDailyTradeSignals && !isMarketIndexTicker(stock.ticker)) {
            distRows.push({
              rank,
              conf,
              line: `  • <b>${stock.ticker}</b>${star}${priceStr} · ${topSignal || 'bearish'}`,
            });
          }
        }

        await delay(300);
      } catch (e) {
        this.logger.error(
          `Recommend lỗi ${stock.ticker}: ${(e as Error).message}`,
        );
      }
    }

    const sortRecRows = (rows: typeof buyRows) =>
      [...rows].sort((a, b) => {
        if (a.rank !== b.rank) return a.rank - b.rank;
        return b.conf - a.conf;
      });
    const maxB = this.telegramRecommendCap('buy');
    const maxS = this.telegramRecommendCap('sell');
    const sortedBuys = sortRecRows(buyRows);
    const sortedDist = sortRecRows(distRows);
    const buys = sortedBuys.slice(0, maxB).map((r) => r.line);
    const distributions = sortedDist.slice(0, maxS).map((r) => r.line);
    const moreBuys = Math.max(0, sortedBuys.length - buys.length);
    const moreSells = Math.max(0, sortedDist.length - distributions.length);

    const hasAlert = buys.length > 0 || distributions.length > 0;
    if (hasAlert) {
      let summary = `📊 <b>Khuyến nghị</b> — ${date}\n`;
      summary +=
        buyNotifyMode === 'safe'
          ? `<i>Phiên mới nhất · ${watchlist.length} mã · MUA: STRONG_BUY + HIGH + nền</i>\n`
          : `<i>Phiên mới nhất · ${watchlist.length} mã</i>\n`;
      summary += '─'.repeat(24) + '\n\n';

      if (buys.length) {
        summary += `📈 <b>MUA</b> (${sortedBuys.length})\n${buys.join('\n')}\n`;
        if (moreBuys > 0) {
          summary += `<i>… +${moreBuys} mã</i>\n`;
        }
        summary += '\n';
      }
      if (distributions.length) {
        summary += `🔻 <b>Bán / đảo chiều</b> (${sortedDist.length})\n`;
        summary += `<i>Không tự đóng lệnh theo tín hiệu.</i>\n`;
        summary += `${distributions.join('\n')}\n`;
        if (moreSells > 0) {
          summary += `<i>… +${moreSells} mã</i>\n`;
        }
        summary += '\n';
      }

      summary += `<i>⚠️ Tự động, không phải tư vấn.</i>`;
      await this.telegramService.sendMessage({ text: summary });
      this.logger.log(
        `✅ Gửi Telegram: ${buys.length} MUA, ${distributions.length} phân phối`,
      );
    } else {
      this.logger.log(`Không có tín hiệu đặc biệt hôm nay`);
    }
  }

  // ─── Telegram Summary ────────────────────────────────────────────────

  private async sendDailySummary(
    results: Array<{
      ticker: string;
      name: string;
      sector: string;
      bullish: string[];
      bearish: string[];
    }>,
    totalScanned: number,
  ): Promise<void> {
    const cap = this.telegramDailySignalCap();
    const bullishAll = results
      .filter((r) => r.bullish.length > 0)
      .sort(
        (a, b) =>
          tickerCapLiquidityRank(a.ticker) - tickerCapLiquidityRank(b.ticker),
      );
    const bearishAll = results
      .filter((r) => r.bearish.length > 0)
      .sort(
        (a, b) =>
          tickerCapLiquidityRank(a.ticker) - tickerCapLiquidityRank(b.ticker),
      );
    const bullishStocks = bullishAll.slice(0, cap);
    const bearishStocks = bearishAll.slice(0, cap);
    const date = new Date().toLocaleDateString('vi-VN', {
      timeZone: 'Asia/Ho_Chi_Minh',
    });

    let msg = `📊 <b>Tín hiệu phiên</b> — ${date}\n`;
    msg += `<i>${totalScanned} mã · ${results.length} mã có tín hiệu — tối đa ${cap} mã/nhóm, 2 loại/nền</i>\n`;
    msg += '─'.repeat(24) + '\n\n';

    if (bullishAll.length) {
      msg += `🟢 <b>Tăng</b> (${bullishAll.length})\n`;
      for (const s of bullishStocks) {
        msg += `  • <b>${s.ticker}</b>: ${this.formatDailySignalTypes(s.bullish)}\n`;
      }
      if (bullishAll.length > bullishStocks.length) {
        msg += `<i>… +${bullishAll.length - bullishStocks.length} mã</i>\n`;
      }
      msg += '\n';
    }

    if (bearishAll.length) {
      msg += `🔴 <b>Giảm</b> (${bearishAll.length})\n`;
      for (const s of bearishStocks) {
        msg += `  • <b>${s.ticker}</b>: ${this.formatDailySignalTypes(s.bearish)}\n`;
      }
      if (bearishAll.length > bearishStocks.length) {
        msg += `<i>… +${bearishAll.length - bearishStocks.length} mã</i>\n`;
      }
    }

    await this.telegramService.sendMessage({ text: msg });
    this.logger.log('✅ Đã gửi báo cáo tín hiệu lên Telegram');
  }

  // Phân tích lịch sử toàn bộ watchlist
  async analyzeHistoryAll(
    from?: string,
  ): Promise<{ ticker: string; analyzed: number; saved: number }[]> {
    const tickers = await this.watchlistService.getActiveTickers();
    const results: { ticker: string; analyzed: number; saved: number }[] = [];
    const fromLabel = from ?? 'đầu lịch sử (đủ 130 nến)';

    this.logger.log(
      `Bắt đầu analyzeHistory ${tickers.length} mã — từ ${fromLabel}...`,
    );
    const pool = this.syncPoolSize();
    const batch = await mapPool(tickers, pool, async (ticker) => {
      try {
        const r = await this.signalService.analyzeAllHistory(ticker, from);
        return { ticker, ok: true as const, ...r };
      } catch (e) {
        this.logger.error(
          `analyzeHistory lỗi ${ticker}: ${(e as Error).message}`,
        );
        return { ticker, ok: false as const, analyzed: 0, saved: 0 };
      }
    });
    for (const row of batch) {
      if (row.ok) {
        results.push({
          ticker: row.ticker,
          analyzed: row.analyzed,
          saved: row.saved,
        });
      } else {
        results.push({ ticker: row.ticker, analyzed: 0, saved: 0 });
      }
    }

    const totalSaved = results.reduce((s, r) => s + r.saved, 0);
    const totalAnalyzed = results.reduce((s, r) => s + r.analyzed, 0);
    this.logger.log(
      `✅ analyzeHistory xong: ${totalAnalyzed} ngày-mã, ${totalSaved} tín hiệu mới`,
    );
    return results;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
