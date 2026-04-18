import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job } from 'bullmq';
import { mapPool } from '../common/map-pool';
import { shouldRunAnalyzeAllHistoryAfterSync } from '../common/sync-analyze-policy';
import { SignalService } from '../signal/signal.service';
import { StockService } from '../stock/stock.service';
import { WatchlistService } from '../watchlist/watchlist.service';
import { JobName, JobProgress, STOCK_QUEUE } from './queue.constants';

const queueWorkerConcurrency = (() => {
  const n = parseInt(process.env.STOCK_QUEUE_CONCURRENCY ?? '2', 10);
  return Number.isFinite(n) && n >= 1 && n <= 16 ? n : 2;
})();

@Processor(STOCK_QUEUE, { concurrency: queueWorkerConcurrency })
export class StockJobProcessor extends WorkerHost {
  private readonly logger = new Logger(StockJobProcessor.name);

  constructor(
    private readonly stockService: StockService,
    private readonly signalService: SignalService,
    private readonly watchlistService: WatchlistService,
    private readonly config: ConfigService,
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

  private syncPoolSize(): number {
    const n = parseInt(
      this.config.get<string>('SYNC_TICKERS_CONCURRENCY', '4') ?? '4',
      10,
    );
    return Number.isFinite(n) && n >= 1 && n <= 32 ? n : 4;
  }

  private async handleSyncAll(
    job: Job<{ from?: string; full?: boolean }>,
  ): Promise<{ synced: number; errors: number }> {
    const { from, full } = job.data;
    const tickers = await this.watchlistService.getActiveTickers();
    const pool = this.syncPoolSize();
    let synced = 0;
    let errors = 0;

    await mapPool(tickers, pool, async (ticker, i) => {
      try {
        if (full) {
          const saved = await this.stockService.syncHistoryFull(ticker);
          await this.runSignalsAfterSync(ticker, from, {
            isFullPriceSync: true,
            savedBarCount: saved,
          });
        } else {
          const r = await this.stockService.syncHistorySmart(ticker, from);
          await this.runSignalsAfterSync(ticker, from, {
            isFullPriceSync: false,
            smartMode: r.mode,
            savedBarCount: r.saved,
          });
        }
        synced++;
      } catch (e) {
        this.logger.error(`Sync lỗi ${ticker}: ${(e as Error).message}`);
        errors++;
      }
      await this.updateProgress(job, i + 1, tickers.length, ticker);
    });

    this.logger.log(`✅ Sync xong: ${synced} ok, ${errors} lỗi`);
    return { synced, errors };
  }

  private async handleSyncTicker(
    job: Job<{
      ticker: string;
      from?: string;
      full?: boolean;
      windowDays?: number;
    }>,
  ): Promise<{ saved: number; mode?: string }> {
    const { ticker, from, full, windowDays } = job.data;
    let saved: number;
    let mode: string | undefined;
    if (full) {
      saved = await this.stockService.syncHistoryFull(ticker);
      mode = 'full';
      await this.runSignalsAfterSync(ticker, from, {
        isFullPriceSync: true,
        savedBarCount: saved,
      });
    } else if (
      windowDays != null &&
      Number.isFinite(Number(windowDays)) &&
      Number(windowDays) > 0
    ) {
      const r = await this.stockService.syncHistoryCalendarWindow(
        ticker,
        Number(windowDays),
      );
      saved = r.saved;
      mode = 'calendar_window';
      await this.runSignalsAfterSync(ticker, r.from, {
        isFullPriceSync: false,
        smartMode: mode,
        savedBarCount: saved,
      });
    } else {
      const r = await this.stockService.syncHistorySmart(ticker, from);
      saved = r.saved;
      mode = r.mode;
      await this.runSignalsAfterSync(ticker, from, {
        isFullPriceSync: false,
        smartMode: r.mode,
        savedBarCount: r.saved,
      });
    }
    await this.updateProgress(job, 1, 1, ticker);
    return { saved, mode };
  }

  /** Sau sync: `analyze` luôn; `analyzeAllHistory` chỉ khi full hoặc có nến mới / không phải incremental “khô”. */
  private async runSignalsAfterSync(
    ticker: string,
    from?: string,
    sync?: {
      isFullPriceSync: boolean;
      smartMode?: string;
      savedBarCount: number;
    },
  ): Promise<void> {
    try {
      await this.signalService.analyze(ticker);
    } catch (e) {
      this.logger.warn(`analyze ${ticker} sau sync: ${(e as Error).message}`);
    }
    const runFull =
      sync == null ||
      shouldRunAnalyzeAllHistoryAfterSync({
        isFullPriceSync: sync.isFullPriceSync,
        smartMode: sync.smartMode,
        savedBarCount: sync.savedBarCount,
      });
    if (!runFull) {
      this.logger.debug(
        `${ticker}: bỏ qua analyzeAllHistory (incremental, 0 nến mới)`,
      );
      return;
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
    const pool = this.syncPoolSize();
    let scanned = 0;
    let errors = 0;

    await mapPool(tickers, pool, async (ticker, i) => {
      try {
        await this.signalService.analyze(ticker);
        scanned++;
      } catch (e) {
        this.logger.error(`Scan lỗi ${ticker}: ${(e as Error).message}`);
        errors++;
      }
      await this.updateProgress(job, i + 1, tickers.length, ticker);
    });

    this.logger.log(`✅ Scan xong: ${scanned} ok, ${errors} lỗi`);
    return { scanned, errors };
  }

  private async handleAnalyzeHistoryAll(
    job: Job<{ from?: string }>,
  ): Promise<{ totalSaved: number; totalDays: number }> {
    const { from } = job.data;
    const tickers = await this.watchlistService.getActiveTickers();
    const pool = this.syncPoolSize();
    let totalSaved = 0;
    let totalDays = 0;

    await mapPool(tickers, pool, async (ticker, i) => {
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
    });

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
