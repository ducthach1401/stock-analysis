import { Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { DerivativesService } from './derivatives.service';
import { Vn30BacktestService } from './vn30-backtest.service';
import {
  listUpcomingVn30FuturesContracts,
  nearestVn30FuturesContract,
} from './vn30-contracts.util';

@Controller('derivatives')
export class DerivativesController {
  constructor(
    private readonly derivativesService: DerivativesService,
    private readonly backtestService: Vn30BacktestService,
  ) {}

  /**
   * Danh sách kỳ hạn tham chiếu + mã nguồn giá (VN30) — không có OHLC từng HĐTL trên API Entrade công khai.
   */
  @Get('vn30/contracts')
  getVn30Contracts() {
    const contracts = listUpcomingVn30FuturesContracts(10);
    const nearest = nearestVn30FuturesContract();
    return {
      priceTicker: 'VN30',
      priceSourceNote:
        'Nến và tín hiệu dùng chỉ số VN30 (Entrade). Hợp đồng gần nhất chỉ để tham chiếu kỳ đáo hạn; không phải giá từng mã HĐTL.',
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
   * So sánh 3 chiến lược LONG (bình thường / siết / tắt) trên cùng dữ liệu lịch sử.
   * ?from=YYYY-MM-DD  ?to=YYYY-MM-DD  ?trailing=off  ?rsicap=off
   */
  @Get('vn30/backtest')
  runVn30Backtest(
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('trailing') trailing?: string,
    @Query('rsicap') rsicap?: string,
  ) {
    const toDate = to ? new Date(to + 'T23:59:59') : new Date();
    const fromDate = from
      ? new Date(from + 'T00:00:00')
      : new Date(toDate.getTime() - 180 * 24 * 60 * 60 * 1000);
    return this.backtestService.runCompare(fromDate, toDate, {
      trailing: trailing !== 'off',
      rsicap: rsicap !== 'off',
    });
  }
}
