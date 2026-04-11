import { Controller, Get, Post } from '@nestjs/common';
import { WATCHLIST } from './watchlist';
import { ScannerService } from './scanner.service';
import { SignalService } from '../signal/signal.service';

@Controller('scanner')
export class ScannerController {
  constructor(
    private readonly scannerService: ScannerService,
    private readonly signalService: SignalService,
  ) {}

  // GET /scanner/watchlist — xem danh sách theo dõi
  @Get('watchlist')
  getWatchlist() {
    return WATCHLIST;
  }

  // GET /scanner/signals-summary — tín hiệu mới nhất của toàn bộ watchlist
  @Get('signals-summary')
  getSignalsSummary() {
    const tickers = WATCHLIST.map((s) => s.ticker);
    return this.signalService.getSignalsSummary(tickers);
  }

  // POST /scanner/sync — sync giá tất cả 50 mã thủ công
  @Post('sync')
  syncAll() {
    return this.scannerService.syncAll();
  }

  // POST /scanner/scan — quét tín hiệu + gửi Telegram thủ công
  @Post('scan')
  scanAll() {
    return this.scannerService.scanAll();
  }

  // POST /scanner/alert — kiểm tra biến động intraday thủ công
  @Post('alert')
  alertAll() {
    return this.scannerService.intradayAlertAll();
  }

  // POST /scanner/recommend — gửi khuyến nghị toàn bộ watchlist lên Telegram
  @Post('recommend')
  recommendAll() {
    return this.scannerService.recommendAll();
  }
}
