import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module';
import { DERIVATIVES_QUEUE } from '../queue/queue.constants';
import { StockModule } from '../stock/stock.module';
import { TelegramModule } from '../telegram/telegram.module';
import { DerivativesJobProcessor } from './derivatives-job.processor';
import { DerivativesController } from './derivatives.controller';
import { DerivativesService } from './derivatives.service';
import { DerivativeDecision } from './entities/derivative-decision.entity';
import { Vn30BacktestService } from './vn30-backtest.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([DerivativeDecision]),
    BullModule.registerQueue({ name: DERIVATIVES_QUEUE }),
    AuthModule,
    StockModule,
    TelegramModule,
  ],
  controllers: [DerivativesController],
  providers: [DerivativesService, Vn30BacktestService, DerivativesJobProcessor],
  exports: [DerivativesService],
})
export class DerivativesModule {}
