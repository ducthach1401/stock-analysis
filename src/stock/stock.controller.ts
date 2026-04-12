import {
  Controller,
  DefaultValuePipe,
  Get,
  Param,
  ParseFloatPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { StockService } from './stock.service';

@Controller('stocks')
export class StockController {
  constructor(private readonly stockService: StockService) {}

  // GET /stocks/:ticker/history?from=2024-01-01&to=2024-12-31
  @Get(':ticker/history')
  fetchHistory(
    @Param('ticker') ticker: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('full') full?: string,
  ) {
    if (full === '1' || full === 'true')
      return this.stockService.fetchFullHistory(ticker, to);
    return this.stockService.fetchHistory(ticker, from, to);
  }

  // GET /stocks/:ticker/latest — giá phiên gần nhất từ DNSE
  @Get(':ticker/latest')
  fetchLatestBar(@Param('ticker') ticker: string) {
    return this.stockService.fetchLatestBar(ticker);
  }

  // GET /stocks/:ticker/stored?from=2024-01-01&to=2024-12-31
  @Get(':ticker/stored')
  getStoredHistory(
    @Param('ticker') ticker: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.stockService.getStoredHistory(ticker, from, to);
  }

  // POST /stocks/:ticker/sync?from=2024-01-01
  @UseGuards(JwtAuthGuard)
  @Post(':ticker/sync')
  syncHistory(
    @Param('ticker') ticker: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('full') full?: string,
  ) {
    if (full === '1' || full === 'true')
      return this.stockService.syncHistoryFull(ticker, to);
    return this.stockService.syncHistory(ticker, from, to);
  }

  // POST /stocks/:ticker/seed?bars=120 — tạo dữ liệu mẫu để test
  @UseGuards(JwtAuthGuard)
  @Post(':ticker/seed')
  seedTestData(
    @Param('ticker') ticker: string,
    @Query('bars') bars?: string,
    @Query('price') price?: string,
  ) {
    return this.stockService.seedTestData(
      ticker,
      bars ? parseInt(bars) : 120,
      price ? parseFloat(price) : undefined,
    );
  }

  // POST /stocks/:ticker/alert?threshold=3
  @UseGuards(JwtAuthGuard)
  @Post(':ticker/alert')
  checkAndAlert(
    @Param('ticker') ticker: string,
    @Query('threshold', new DefaultValuePipe(3), ParseFloatPipe)
    threshold: number,
  ) {
    return this.stockService.checkAndAlert(ticker, threshold);
  }
}
