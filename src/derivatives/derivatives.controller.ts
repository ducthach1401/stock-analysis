import { Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { DERIVATIVES_QUEUE, JobName } from '../queue/queue.constants';
import { DerivativesService } from './derivatives.service';
import { BacktestParams, Vn30BacktestService } from './vn30-backtest.service';
import {
  listUpcomingVn30FuturesContracts,
  nearestVn30FuturesContract,
} from './vn30-contracts.util';

@Controller('derivatives')
export class DerivativesController {
  constructor(
    private readonly derivativesService: DerivativesService,
    private readonly backtestService: Vn30BacktestService,
    @InjectQueue(DERIVATIVES_QUEUE) private readonly derivQueue: Queue,
  ) {}

  @Get('vn30/contracts')
  getVn30Contracts() {
    const contracts = listUpcomingVn30FuturesContracts(10);
    const nearest = nearestVn30FuturesContract();
    return {
      priceTicker: 'VN30F1M',
      priceSourceNote:
        'Nến và tín hiệu dùng HĐTL VN30F1M (Entrade /ohlcs/derivative) — giá & volume của chính hợp đồng tháng gần, không phải chỉ số VN30. `nearest` chỉ để tham chiếu kỳ đáo hạn.',
      nearest,
      contracts,
    };
  }

  @Get('vn30/decision/latest')
  latestVn30Decision() {
    return this.derivativesService.latestDecision();
  }

  @Get('vn30/decisions')
  recentVn30Decisions(@Query('limit') limit?: string) {
    return this.derivativesService.recentDecisions(Number(limit ?? 50));
  }

  @UseGuards(JwtAuthGuard)
  @Post('vn30/scan')
  scanVn30(@Query('notify') notify?: string) {
    return this.derivativesService.scanVn30({
      forceNotify: notify === '1' || notify === 'true',
      source: 'manual',
    });
  }

  /**
   * GET /derivatives/vn30/live-series — lấy BacktestSeries từ lệnh thực tế trong DB (V3).
   * Dùng để overlay lên chart backtest so sánh giả lập vs live.
   */
  @Get('vn30/live-series')
  async getVn30LiveSeries(
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    const params = this.resolveParams(from, to);
    const series = await this.derivativesService.buildLiveSeries(params.from, params.to);
    return { series };
  }

  /**
   * GET /derivatives/vn30/backtest — đọc kết quả từ cache.
   * Trả { status: 'pending' } nếu chưa có cache (job chưa xong).
   */
  @Get('vn30/backtest')
  async getVn30Backtest(
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('trailing') trailing?: string,
    @Query('rsicap') rsicap?: string,
  ) {
    const params = this.resolveParams(from, to, trailing, rsicap);
    const key = this.backtestService.cacheKey(params);
    const cached = await this.backtestService.getCached(key);
    if (!cached) return { status: 'pending' as const, cacheKey: key };
    return { status: 'ready' as const, ...cached };
  }

  /**
   * POST /derivatives/vn30/backtest/run — enqueue job tính toán.
   * Job chạy trong background, kết quả ghi vào Redis.
   * Frontend poll GET /backtest cho đến khi status = 'ready'.
   */
  @UseGuards(JwtAuthGuard)
  @Post('vn30/backtest/run')
  async enqueueVn30Backtest(
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('trailing') trailing?: string,
    @Query('rsicap') rsicap?: string,
  ) {
    const params = this.resolveParams(from, to, trailing, rsicap);
    const job = await this.derivQueue.add(JobName.BACKTEST_VN30, params, {
      jobId: this.backtestService.cacheKey(params).replace(/:/g, '-'), // dedup cùng params, BullMQ không cho phép ':'
      removeOnComplete: true,
      removeOnFail: 50,
    });
    return { queued: true, jobId: job.id, params };
  }

  private resolveParams(
    from?: string,
    to?: string,
    trailing?: string,
    rsicap?: string,
  ): BacktestParams {
    const toDate = to
      ? new Date(to + 'T23:59:59')
      : (() => {
          const now = new Date();
          return new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);
        })();
    const fromDate = from
      ? new Date(from + 'T00:00:00')
      : new Date(toDate.getFullYear() - 1, toDate.getMonth(), 1);
    return {
      from: fromDate.toISOString().slice(0, 10),
      to: toDate.toISOString().slice(0, 10),
      trailing: trailing !== 'off',
      rsicap: rsicap !== 'off',
    };
  }
}
