import { Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { QueueService } from '../queue/queue.service';
import { WatchlistService } from '../watchlist/watchlist.service';
import { ScannerService } from './scanner.service';
import { SignalService } from '../signal/signal.service';

@Controller('scanner')
export class ScannerController {
  constructor(
    private readonly scannerService: ScannerService,
    private readonly signalService: SignalService,
    private readonly watchlistService: WatchlistService,
    private readonly queueService: QueueService,
  ) {}

  // GET /scanner/watchlist — danh sách active từ DB
  @Get('watchlist')
  async getWatchlist() {
    return this.watchlistService.findActiveSortedByPriority();
  }

  // GET /scanner/signals-summary — tín hiệu mới nhất; orderedTickers = ưu tiên vốn hoá + thanh khoản
  @Get('signals-summary')
  async getSignalsSummary() {
    const items = await this.watchlistService.findActiveSortedByPriority();
    const tickers = items.map((s) => s.ticker);
    const summary = await this.signalService.getSignalsSummary(tickers);
    return { orderedTickers: tickers, summary };
  }

  /** GET /scanner/latest-signals?limit=40 — feed các bản ghi tín hiệu gần nhất (chỉ mã trong watchlist active) */
  @Get('latest-signals')
  async getLatestSignals(@Query('limit') limit?: string) {
    const items = await this.watchlistService.findActiveSortedByPriority();
    const tickers = items.map((s) => s.ticker);
    const n = Math.min(200, Math.max(1, parseInt(limit ?? '40', 10) || 40));
    const signals = await this.signalService.getLatestSignalsForTickers(
      tickers,
      n,
    );
    return { signals };
  }

  /** Heuristic: mã đang «sắp» có tín hiệu (MACD/RSI/EMA/BB) — cần thêm vài nến xác nhận */
  @Get('forming-setups')
  async getFormingSetups() {
    const wl = await this.watchlistService.findActiveSortedByPriority();
    const tickers = wl.map((s) => s.ticker);
    const meta = new Map(
      wl.map((i) => [
        i.ticker.toUpperCase(),
        { name: i.name, sector: i.sector },
      ]),
    );
    const data = await this.signalService.getFormingSetupsForWatchlist(tickers);
    return {
      ...data,
      items: data.items.map((row) => ({
        ...row,
        ...meta.get(row.ticker),
      })),
    };
  }

  // POST /scanner/sync?full=true — enqueue sync giá tất cả mã
  @UseGuards(JwtAuthGuard)
  @Post('sync')
  async syncAll(@Query('from') from?: string, @Query('full') full?: string) {
    const fullSync = full === 'true' || full === '1';
    const job = await this.queueService.enqueueSyncAll(from, fullSync);
    const msg = fullSync
      ? 'Đang sync full (IPO / mốc sớm → nay)'
      : `Đang sync ${from ?? '1 năm gần nhất'}`;
    return { jobId: job.id, status: 'queued', message: msg };
  }

  // POST /scanner/scan — enqueue quét tín hiệu
  @UseGuards(JwtAuthGuard)
  @Post('scan')
  async scanAll() {
    const job = await this.queueService.enqueueScanAll();
    return {
      jobId: job.id,
      status: 'queued',
      message: 'Đang quét tín hiệu toàn watchlist',
    };
  }

  // POST /scanner/alert — kiểm tra biến động intraday (nhẹ, giữ đồng bộ)
  @UseGuards(JwtAuthGuard)
  @Post('alert')
  alertAll() {
    return this.scannerService.intradayAlertAll();
  }

  // POST /scanner/recommend — gửi khuyến nghị Telegram (nhẹ, giữ đồng bộ)
  @UseGuards(JwtAuthGuard)
  @Post('recommend')
  recommendAll() {
    return this.scannerService.recommendAll();
  }

  // POST /scanner/analyze-history?from=YYYY-MM-DD — enqueue phân tích lịch sử
  @UseGuards(JwtAuthGuard)
  @Post('analyze-history')
  async analyzeHistoryAll(@Query('from') from?: string) {
    const job = await this.queueService.enqueueAnalyzeHistoryAll(
      from ?? '2025-01-01',
    );
    return {
      jobId: job.id,
      status: 'queued',
      message: `Phân tích lịch sử từ ${from ?? '2025-01-01'}`,
    };
  }
}
