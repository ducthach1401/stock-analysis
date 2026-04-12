import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module';
import { SignalModule } from '../signal/signal.module';
import { StockModule } from '../stock/stock.module';
import { WatchlistItem } from './entities/watchlist-item.entity';
import { WatchlistController } from './watchlist.controller';
import { WatchlistService } from './watchlist.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([WatchlistItem]),
    SignalModule,
    StockModule,
    AuthModule,
  ],
  controllers: [WatchlistController],
  providers: [WatchlistService],
  exports: [WatchlistService],
})
export class WatchlistModule {}
