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
    return this.watchlistService.findActive();
  }

  // GET /scanner/signals-summary — tín hiệu mới nhất của toàn bộ watchlist
  @Get('signals-summary')
  async getSignalsSummary() {
    const items = await this.watchlistService.findActive();
    const tickers = items.map((s) => s.ticker);
    return this.signalService.getSignalsSummary(tickers);
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
    return { jobId: job.id, status: 'queued', message: 'Đang quét tín hiệu toàn watchlist' };
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
    const job = await this.queueService.enqueueAnalyzeHistoryAll(from ?? '2025-01-01');
    return { jobId: job.id, status: 'queued', message: `Phân tích lịch sử từ ${from ?? '2025-01-01'}` };
  }
}
