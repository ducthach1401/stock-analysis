import { Module, forwardRef } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { QueueModule } from '../queue/queue.module';
import { SignalModule } from '../signal/signal.module';
import { StockModule } from '../stock/stock.module';
import { TelegramModule } from '../telegram/telegram.module';
import { PositionModule } from '../position/position.module';
import { WatchlistModule } from '../watchlist/watchlist.module';
import { ScannerController } from './scanner.controller';
import { ScannerService } from './scanner.service';

@Module({
  imports: [
    StockModule,
    SignalModule,
    TelegramModule,
    PositionModule,
    WatchlistModule,
    AuthModule,
    forwardRef(() => QueueModule),
  ],
  controllers: [ScannerController],
  providers: [ScannerService],
  exports: [ScannerService],
})
export class ScannerModule {}
