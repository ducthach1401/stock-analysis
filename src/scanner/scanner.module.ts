import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module';
import { QueueModule } from '../queue/queue.module';
import { SignalModule } from '../signal/signal.module';
import { StockModule } from '../stock/stock.module';
import { TelegramModule } from '../telegram/telegram.module';
import { PositionModule } from '../position/position.module';
import { WatchlistModule } from '../watchlist/watchlist.module';
import { Signal } from '../signal/entities/signal.entity';
import { StockPrice } from '../stock/entities/stock-price.entity';
import { ScannerController } from './scanner.controller';
import { ScannerService } from './scanner.service';
import { IntradayBreakoutNotifyService } from './intraday-breakout-notify.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([StockPrice, Signal]),
    StockModule,
    SignalModule,
    TelegramModule,
    PositionModule,
    WatchlistModule,
    AuthModule,
    forwardRef(() => QueueModule),
  ],
  controllers: [ScannerController],
  providers: [ScannerService, IntradayBreakoutNotifyService],
  exports: [ScannerService],
})
export class ScannerModule {}
