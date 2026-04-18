import {
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { QueueService } from './queue.service';

@Controller('queue')
export class QueueController {
  constructor(private readonly queueService: QueueService) {}

  // GET /queue/stats — trạng thái queue (public)
  @Get('stats')
  getStats() {
    return this.queueService.getQueueStats();
  }

  // GET /queue/jobs/:id — trạng thái + tiến độ job (public — để frontend poll)
  @Get('jobs/:id')
  async getJob(@Param('id') id: string) {
    const job = await this.queueService.getJobStatus(id);
    if (!job) throw new NotFoundException(`Job ${id} không tìm thấy`);
    return job;
  }

  // POST /queue/sync?from=YYYY-MM-DD&full=true — sync toàn watchlist (full = từ mốc sớm → nay)
  @UseGuards(JwtAuthGuard)
  @Post('sync')
  async syncAll(@Query('from') from?: string, @Query('full') full?: string) {
    const fullSync = full === 'true' || full === '1';
    const job = await this.queueService.enqueueSyncAll(from, fullSync);
    return { jobId: job.id, status: 'queued', name: job.name };
  }

  // POST /queue/sync/:ticker?from=YYYY-MM-DD&full=true — sync 1 mã
  // POST /queue/sync/VN30?windowDays=31 — chỉ nến ngày trong ~31 ngày lịch (phái sinh / bổ sung gần đây)
  @UseGuards(JwtAuthGuard)
  @Post('sync/:ticker')
  async syncTicker(
    @Param('ticker') ticker: string,
    @Query('from') from?: string,
    @Query('full') full?: string,
    @Query('windowDays') windowDays?: string,
  ) {
    const fullSync = full === 'true' || full === '1';
    let wd: number | undefined;
    if (windowDays != null && windowDays !== '') {
      const n = parseInt(windowDays, 10);
      if (Number.isFinite(n) && n > 0) {
        wd = Math.min(n, 400);
      }
    }
    const job = await this.queueService.enqueueSyncTicker(
      ticker,
      from,
      fullSync,
      wd,
    );
    return { jobId: job.id, status: 'queued', name: job.name };
  }

  // POST /queue/scan — quét tín hiệu toàn watchlist
  @UseGuards(JwtAuthGuard)
  @Post('scan')
  async scanAll() {
    const job = await this.queueService.enqueueScanAll();
    return { jobId: job.id, status: 'queued', name: job.name };
  }

  // POST /queue/analyze-history?from=YYYY-MM-DD — phân tích lịch sử toàn watchlist
  @UseGuards(JwtAuthGuard)
  @Post('analyze-history')
  async analyzeHistoryAll(@Query('from') from?: string) {
    const job = await this.queueService.enqueueAnalyzeHistoryAll(from);
    return { jobId: job.id, status: 'queued', name: job.name };
  }

  // POST /queue/analyze-history/:ticker — phân tích lịch sử 1 mã
  @UseGuards(JwtAuthGuard)
  @Post('analyze-history/:ticker')
  async analyzeHistoryTicker(
    @Param('ticker') ticker: string,
    @Query('from') from?: string,
  ) {
    const job = await this.queueService.enqueueAnalyzeHistoryTicker(
      ticker,
      from,
    );
    return { jobId: job.id, status: 'queued', name: job.name };
  }
}
