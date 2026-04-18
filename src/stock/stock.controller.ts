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
import { SignalService } from '../signal/signal.service';
import { shouldRunAnalyzeAllHistoryAfterSync } from '../common/sync-analyze-policy';
import { StockService } from './stock.service';

@Controller('stocks')
export class StockController {
  constructor(
    private readonly stockService: StockService,
    private readonly signalService: SignalService,
  ) {}

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

  /**
   * GET /stocks/VN30/intraday-index?resolution=5|15|1H|4H|1D&from=&to=
   * Nến chỉ số đa khung (Entrade; 4H gộp từ 1H), không lưu DB.
   */
  @Get(':ticker/intraday-index')
  getIntradayIndex(
    @Param('ticker') ticker: string,
    @Query('resolution') resolution?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.stockService.fetchIntradayIndexOhlc(ticker, resolution, from, to);
  }

  // GET /stocks/:ticker/stored?from=&to=&limit=500&before=YYYY-MM-DD
  // limit: chỉ lấy N bản ghi mới nhất (DESC). before: tradingDate < before (tải trang cũ hơn).
  @Get(':ticker/stored')
  getStoredHistory(
    @Param('ticker') ticker: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('limit') limitStr?: string,
    @Query('before') before?: string,
  ) {
    const parsed = limitStr ? parseInt(limitStr, 10) : NaN;
    const limit =
      !Number.isNaN(parsed) && parsed > 0 ? Math.min(parsed, 5000) : undefined;
    return this.stockService.getStoredHistory(ticker, from, to, {
      limit,
      before,
    });
  }

  // POST /stocks/:ticker/sync?from=2024-01-01 — sau sync tự chạy phân tích + lịch sử tín hiệu
  @UseGuards(JwtAuthGuard)
  @Post(':ticker/sync')
  async syncHistory(
    @Param('ticker') ticker: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('full') full?: string,
  ) {
    const isFull = full === '1' || full === 'true';
    let saved: number;
    let mode: string;
    if (isFull) {
      saved = await this.stockService.syncHistoryFull(ticker, to);
      mode = 'full';
    } else {
      const r = await this.stockService.syncHistorySmart(ticker, from, to);
      saved = r.saved;
      mode = r.mode;
    }
    try {
      await this.signalService.analyze(ticker);
      if (
        shouldRunAnalyzeAllHistoryAfterSync({
          isFullPriceSync: isFull,
          smartMode: mode,
          savedBarCount: saved,
        })
      ) {
        await this.signalService.analyzeAllHistory(ticker, from);
      }
    } catch {
      /* analyze* đã log trong SignalService */
    }
    return { saved, mode };
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
