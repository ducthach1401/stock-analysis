import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import {
  LIQUIDITY_MIN_AVG_VOLUME,
  LIQUIDITY_MIN_BARS,
  LIQUIDITY_MIN_TRADING_DAYS,
  LIQUIDITY_WINDOW_DAYS,
  SignalService,
} from '../signal/signal.service';
import { WatchlistService } from './watchlist.service';

@Controller('watchlist')
export class WatchlistController {
  constructor(
    private readonly watchlistService: WatchlistService,
    private readonly signalService: SignalService,
  ) {}

  // GET /watchlist — toàn bộ (kể cả inactive)
  @Get()
  findAll() {
    return this.watchlistService.findAll();
  }

  // GET /watchlist/active — chỉ active
  @Get('active')
  findActive() {
    return this.watchlistService.findActive();
  }

  // GET /watchlist/ticker-picker — danh sách đầy đủ cho ô tìm mã (file WATCHLIST + DB)
  @Get('ticker-picker')
  tickerPickerUniverse() {
    return this.watchlistService.getTickerPickerUniverse();
  }

  // GET /watchlist/liquidity-candidates?excludeDb=1 — mã trong DB đạt ngưỡng thanh khoản như checkLiquidity, chưa có trong list chuẩn (và tùy chọn loại cả mã đã có trong bảng watchlist)
  @UseGuards(JwtAuthGuard)
  @Get('liquidity-candidates')
  async liquidityCandidates(@Query('excludeDb') excludeDb?: string) {
    const extraExclude =
      excludeDb === '1' || excludeDb === 'true'
        ? (await this.watchlistService.findAll()).map((i) => i.ticker)
        : [];
    const tickers =
      await this.signalService.findLiquidityOkOutsideCanonicalWatchlist({
        extraExcludeTickers: extraExclude,
      });
    return {
      criteria: {
        windowDays: LIQUIDITY_WINDOW_DAYS,
        minBars: LIQUIDITY_MIN_BARS,
        minAvgVolume: LIQUIDITY_MIN_AVG_VOLUME,
        minTradingDays: LIQUIDITY_MIN_TRADING_DAYS,
      },
      excludeDbWatchlist: extraExclude.length > 0,
      count: tickers.length,
      tickers,
    };
  }

  // POST /watchlist — thêm mã mới
  @UseGuards(JwtAuthGuard)
  @Post()
  add(@Body() body: { ticker: string; name: string; sector: string }) {
    return this.watchlistService.add(body.ticker, body.name, body.sector);
  }

  // PUT /watchlist/:ticker/activate — kích hoạt lại
  @UseGuards(JwtAuthGuard)
  @Put(':ticker/activate')
  activate(@Param('ticker') ticker: string) {
    return this.watchlistService.activate(ticker);
  }

  // PUT /watchlist/:ticker/deactivate — tắt thủ công
  @UseGuards(JwtAuthGuard)
  @Put(':ticker/deactivate')
  deactivate(@Param('ticker') ticker: string) {
    return this.watchlistService.deactivate(ticker, 'MANUAL');
  }

  // DELETE /watchlist/:id — xoá hẳn
  @UseGuards(JwtAuthGuard)
  @Delete(':id')
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.watchlistService.remove(id);
  }

  // POST /watchlist/check-liquidity — đồng bộ mã từ danh sách chuẩn + kiểm tra thanh khoản (cùng cron)
  @UseGuards(JwtAuthGuard)
  @Post('check-liquidity')
  checkLiquidity() {
    return this.watchlistService.runWatchlistAutoRules();
  }
}
