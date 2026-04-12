import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { RecommendationService } from '../signal/recommendation.service';
import { SignalDirection } from '../signal/entities/signal.entity';
import { SignalService } from '../signal/signal.service';
import { StockService } from '../stock/stock.service';
import { TelegramService } from '../telegram/telegram.service';
import { PositionService } from '../position/position.service';
import { WatchlistService } from '../watchlist/watchlist.service';

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
  ) {}

  // ─── Cron jobs ────────────────────────────────────────────────────────

  // Sync dữ liệu giá: T2-T6 lúc 15:30 (sau ATC 14:45, chờ DNSE cập nhật)
  @Cron('30 15 * * 1-5', { timeZone: 'Asia/Ho_Chi_Minh' })
  async scheduledSync() {
    this.logger.log('⏰ [Cron] Bắt đầu sync dữ liệu giá...');
    await this.syncAll();
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

  // Kiểm tra biến động intraday: T2-T6 mỗi 30 phút (9:30 - 14:45)
  @Cron('*/30 9-14 * * 1-5', { timeZone: 'Asia/Ho_Chi_Minh' })
  async scheduledIntradayAlert() {
    const now = new Date();
    const hour = now.getHours();
    const min = now.getMinutes();
    // Chỉ chạy trong giờ giao dịch: 9:30–11:30 và 13:00–14:45
    const inMorning = hour === 9 ? min >= 30 : hour === 10 || hour === 11;
    const inAfternoon = hour === 13 || (hour === 14 && min <= 45);
    if (!inMorning && !inAfternoon) return;

    this.logger.log('⏰ [Cron] Kiểm tra biến động intraday...');
    await this.intradayAlertAll();
  }

  // ─── Manual triggers ─────────────────────────────────────────────────

  async syncAll(from?: string): Promise<Record<string, number>> {
    if (this.isRunning) {
      this.logger.warn('Scanner đang chạy, bỏ qua lần này');
      return {};
    }
    this.isRunning = true;
    const tickers = await this.watchlistService.getActiveTickers();
    const result: Record<string, number> = {};
    const fromLabel = from ?? 'mặc định (1 năm)';

    try {
      this.logger.log(`Bắt đầu sync ${tickers.length} mã từ ${fromLabel}...`);
      for (const ticker of tickers) {
        try {
          result[ticker] = await this.stockService.syncHistory(ticker, from);
          await delay(300);
        } catch (e) {
          this.logger.error(`Sync lỗi ${ticker}: ${(e as Error).message}`);
          result[ticker] = -1;
        }
      }

      const total = Object.values(result)
        .filter((v) => v > 0)
        .reduce((a, b) => a + b, 0);
      this.logger.log(
        `✅ Sync xong: ${total} records mới từ ${tickers.length} mã (from=${fromLabel})`,
      );
    } finally {
      this.isRunning = false;
    }

    return result;
  }

  async scanAll(): Promise<void> {
    const watchlist = await this.watchlistService.findActive();
    const allSignals: Array<{
      ticker: string;
      name: string;
      sector: string;
      bullish: string[];
      bearish: string[];
    }> = [];

    for (const stock of watchlist) {
      try {
        const signals = await this.signalService.analyze(stock.ticker);
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
    const watchlist = await this.watchlistService.findActive();
    const date = new Date().toLocaleDateString('vi-VN', {
      timeZone: 'Asia/Ho_Chi_Minh',
    });

    const buys: string[] = [];
    const distributions: string[] = [];
    const distributionTickers: string[] = [];

    for (const stock of watchlist) {
      try {
        const result = await this.recommendationService.recommend(stock.ticker);
        const pt = result.priceTarget;
        const rec = result.recommendation;

        if (rec === 'STRONG_BUY' || rec === 'BUY') {
          // Lớp bảo vệ: chỉ mở vị thế mới khi tín hiệu đủ mạnh (HIGH confidence)
          // BUY thường có thể là noise; STRONG_BUY hoặc HIGH confidence mới đáng tin
          const strongEnough =
            rec === 'STRONG_BUY' || result.confidence === 'HIGH';
          const isNew = strongEnough
            ? await this.positionService.openPosition(result)
            : false;
          if (isNew) {
            await this.recommendationService.recommendAndNotify(stock.ticker);
          }
          const priceStr = pt
            ? ` | ${(pt.currentPrice / 1000).toFixed(1)}k → ${(pt.targetPrice / 1000).toFixed(1)}k (+${pt.upside.toFixed(0)}%)`
            : '';
          const star = result.confidence === 'HIGH' ? ' ⭐' : '';
          const newTag = isNew
            ? ''
            : strongEnough
              ? ' <i>(đang theo dõi)</i>'
              : ' <i>(tín hiệu yếu, không mở lệnh)</i>';
          buys.push(`  • <b>${stock.ticker}</b>${star}${priceStr}${newTag}`);
        } else if (rec === 'STRONG_SELL' || rec === 'SELL') {
          distributionTickers.push(stock.ticker);
          await this.recommendationService.recommendAndNotify(stock.ticker);
          const priceStr = pt
            ? ` | ${(pt.currentPrice / 1000).toFixed(1)}k`
            : '';
          const star = result.confidence === 'HIGH' ? ' ⭐' : '';
          const topSignal =
            result.bearishSignals[0]?.type.replace(/_/g, ' ') ?? '';
          distributions.push(
            `  • <b>${stock.ticker}</b>${star}${priceStr} — ${topSignal}`,
          );
        }

        await delay(300);
      } catch (e) {
        this.logger.error(
          `Recommend lỗi ${stock.ticker}: ${(e as Error).message}`,
        );
      }
    }

    if (distributionTickers.length) {
      await this.positionService.trackAll(distributionTickers);
    }

    const hasAlert = buys.length > 0 || distributions.length > 0;
    if (hasAlert) {
      let summary = `📊 <b>Tổng hợp tín hiệu</b> — ${date}\n`;
      summary += `<i>Quét ${watchlist.length} mã VNIndex</i>\n`;
      summary += '─'.repeat(30) + '\n\n';

      if (buys.length) {
        summary += `📈 <b>MUA (${buys.length} mã)</b>\n${buys.join('\n')}\n\n`;
      }
      if (distributions.length) {
        summary += `🔴 <b>PHÂN PHỐI ĐỈNH (${distributions.length} mã)</b>\n${distributions.join('\n')}\n\n`;
      }

      summary += `<i>⚠️ Phân tích kỹ thuật tự động, không phải tư vấn đầu tư chuyên nghiệp.</i>`;
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
    const bullishStocks = results.filter((r) => r.bullish.length > 0);
    const bearishStocks = results.filter((r) => r.bearish.length > 0);
    const date = new Date().toLocaleDateString('vi-VN', {
      timeZone: 'Asia/Ho_Chi_Minh',
    });

    let msg = `📊 <b>Báo cáo tín hiệu đảo chiều</b> — ${date}\n`;
    msg += `<i>Quét ${totalScanned} mã | ${results.length} mã có tín hiệu</i>\n`;
    msg += '─'.repeat(30) + '\n\n';

    if (bullishStocks.length) {
      msg += `🟢 <b>Tín hiệu TĂNG (${bullishStocks.length} mã)</b>\n`;
      for (const s of bullishStocks) {
        msg += `  • <b>${s.ticker}</b> (${s.sector}): ${s.bullish.join(', ')}\n`;
      }
      msg += '\n';
    }

    if (bearishStocks.length) {
      msg += `🔴 <b>Tín hiệu GIẢM (${bearishStocks.length} mã)</b>\n`;
      for (const s of bearishStocks) {
        msg += `  • <b>${s.ticker}</b> (${s.sector}): ${s.bearish.join(', ')}\n`;
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
    const fromLabel = from ?? '2025-01-01';

    this.logger.log(`Bắt đầu analyzeHistory ${tickers.length} mã từ ${fromLabel}...`);
    for (const ticker of tickers) {
      try {
        const r = await this.signalService.analyzeAllHistory(ticker, from);
        results.push({ ticker, ...r });
        await delay(50); // nhẹ để không block CPU
      } catch (e) {
        this.logger.error(`analyzeHistory lỗi ${ticker}: ${(e as Error).message}`);
        results.push({ ticker, analyzed: 0, saved: 0 });
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
