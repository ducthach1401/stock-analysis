import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { SignalService } from '../signal/signal.service';
import { StockService } from '../stock/stock.service';
import { WatchlistService } from '../watchlist/watchlist.service';
import { JobName, JobProgress, STOCK_QUEUE } from './queue.constants';

@Processor(STOCK_QUEUE, { concurrency: 1 })
export class StockJobProcessor extends WorkerHost {
  private readonly logger = new Logger(StockJobProcessor.name);

  constructor(
    private readonly stockService: StockService,
    private readonly signalService: SignalService,
    private readonly watchlistService: WatchlistService,
  ) {
    super();
  }

  async process(job: Job): Promise<unknown> {
    this.logger.log(`▶ Job [${job.name}] #${job.id} bắt đầu`);
    switch (job.name as JobName) {
      case JobName.SYNC_ALL:
        return this.handleSyncAll(
          job as Job<{ from?: string; full?: boolean }>,
        );
      case JobName.SYNC_TICKER:
        return this.handleSyncTicker(
          job as Job<{
            ticker: string;
            from?: string;
            full?: boolean;
          }>,
        );
      case JobName.SCAN_ALL:
        return this.handleScanAll(job as Job<{ from?: string }>);
      case JobName.ANALYZE_HISTORY_ALL:
        return this.handleAnalyzeHistoryAll(job as Job<{ from?: string }>);
      case JobName.ANALYZE_HISTORY_TICKER:
        return this.handleAnalyzeHistoryTicker(
          job as Job<{ ticker: string; from?: string }>,
        );
      default:
        throw new Error(`Unknown job: ${job.name}`);
    }
  }

  // ─── Handlers ──────────────────────────────────────────────────────────────

  private async handleSyncAll(
    job: Job<{ from?: string; full?: boolean }>,
  ): Promise<{ synced: number; errors: number }> {
    const { from, full } = job.data;
    const tickers = await this.watchlistService.getActiveTickers();
    let synced = 0;
    let errors = 0;

    for (let i = 0; i < tickers.length; i++) {
      const ticker = tickers[i];
      try {
        if (full) await this.stockService.syncHistoryFull(ticker);
        else await this.stockService.syncHistory(ticker, from);
        await this.runSignalsAfterSync(ticker, from);
        synced++;
      } catch (e) {
        this.logger.error(`Sync lỗi ${ticker}: ${(e as Error).message}`);
        errors++;
      }
      await this.updateProgress(job, i + 1, tickers.length, ticker);
    }
    this.logger.log(`✅ Sync xong: ${synced} ok, ${errors} lỗi`);
    return { synced, errors };
  }

  private async handleSyncTicker(
    job: Job<{ ticker: string; from?: string; full?: boolean }>,
  ): Promise<{ saved: number }> {
    const { ticker, from, full } = job.data;
    const saved = full
      ? await this.stockService.syncHistoryFull(ticker)
      : await this.stockService.syncHistory(ticker, from);
    await this.runSignalsAfterSync(ticker, from);
    await this.updateProgress(job, 1, 1, ticker);
    return { saved };
  }

  /** Sau khi có giá mới: tín hiệu phiên hiện tại + backfill lịch sử (INSERT IGNORE). */
  private async runSignalsAfterSync(
    ticker: string,
    from?: string,
  ): Promise<void> {
    try {
      await this.signalService.analyze(ticker);
    } catch (e) {
      this.logger.warn(`analyze ${ticker} sau sync: ${(e as Error).message}`);
    }
    try {
      await this.signalService.analyzeAllHistory(ticker, from);
    } catch (e) {
      this.logger.warn(
        `analyzeAllHistory ${ticker} sau sync: ${(e as Error).message}`,
      );
    }
  }

  private async handleScanAll(
    job: Job,
  ): Promise<{ scanned: number; errors: number }> {
    const tickers = await this.watchlistService.getActiveTickers();
    let scanned = 0;
    let errors = 0;

    for (let i = 0; i < tickers.length; i++) {
      const ticker = tickers[i];
      try {
        await this.signalService.analyze(ticker);
        scanned++;
      } catch (e) {
        this.logger.error(`Scan lỗi ${ticker}: ${(e as Error).message}`);
        errors++;
      }
      await this.updateProgress(job, i + 1, tickers.length, ticker);
    }
    this.logger.log(`✅ Scan xong: ${scanned} ok, ${errors} lỗi`);
    return { scanned, errors };
  }

  private async handleAnalyzeHistoryAll(
    job: Job<{ from?: string }>,
  ): Promise<{ totalSaved: number; totalDays: number }> {
    const { from } = job.data;
    const tickers = await this.watchlistService.getActiveTickers();
    let totalSaved = 0;
    let totalDays = 0;

    for (let i = 0; i < tickers.length; i++) {
      const ticker = tickers[i];
      try {
        const r = await this.signalService.analyzeAllHistory(ticker, from);
        totalSaved += r.saved;
        totalDays += r.analyzed;
      } catch (e) {
        this.logger.error(
          `analyzeHistory lỗi ${ticker}: ${(e as Error).message}`,
        );
      }
      await this.updateProgress(job, i + 1, tickers.length, ticker);
    }
    this.logger.log(
      `✅ analyzeHistory xong: ${totalDays} ngày-mã, ${totalSaved} tín hiệu mới`,
    );
    return { totalSaved, totalDays };
  }

  private async handleAnalyzeHistoryTicker(
    job: Job<{ ticker: string; from?: string }>,
  ): Promise<{ analyzed: number; saved: number }> {
    const { ticker, from } = job.data;
    const r = await this.signalService.analyzeAllHistory(ticker, from);
    await this.updateProgress(job, 1, 1, ticker);
    return r;
  }

  // ─── Helper ────────────────────────────────────────────────────────────────

  private async updateProgress(
    job: Job,
    done: number,
    total: number,
    current: string,
  ): Promise<void> {
    const progress: JobProgress = {
      done,
      total,
      current,
      percent: Math.round((done / total) * 100),
    };
    await job.updateProgress(progress);
  }
}
