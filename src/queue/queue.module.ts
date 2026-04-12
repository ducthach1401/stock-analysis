import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AuthModule } from '../auth/auth.module';
import { SignalModule } from '../signal/signal.module';
import { StockModule } from '../stock/stock.module';
import { WatchlistModule } from '../watchlist/watchlist.module';
import { QueueController } from './queue.controller';
import { QueueService } from './queue.service';
import { STOCK_QUEUE } from './queue.constants';
import { StockJobProcessor } from './stock-job.processor';

@Module({
  imports: [
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connection: {
          host: config.get('REDIS_HOST', 'redis'),
          port: config.get<number>('REDIS_PORT', 6379),
        },
      }),
    }),
    BullModule.registerQueue({ name: STOCK_QUEUE }),
    AuthModule,
    StockModule,
    SignalModule,
    WatchlistModule,
  ],
  controllers: [QueueController],
  providers: [QueueService, StockJobProcessor],
  exports: [QueueService],
})
export class QueueModule {}
