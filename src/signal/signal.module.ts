import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module';
import { StockPrice } from '../stock/entities/stock-price.entity';
import { TelegramModule } from '../telegram/telegram.module';
import { BacktestRun } from './entities/backtest-run.entity';
import { Signal } from './entities/signal.entity';
import { SimulatedTrade } from './entities/simulated-trade.entity';
import { RecommendationService } from './recommendation.service';
import { SignalBacktestService } from './signal-backtest.service';
import { SignalController } from './signal.controller';
import { SignalService } from './signal.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Signal, StockPrice, BacktestRun, SimulatedTrade]),
    TelegramModule,
    AuthModule,
  ],
  controllers: [SignalController],
  providers: [SignalService, RecommendationService, SignalBacktestService],
  exports: [SignalService, RecommendationService, SignalBacktestService],
})
export class SignalModule {}
