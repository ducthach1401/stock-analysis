import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { StockPrice } from '../stock/entities/stock-price.entity';
import { TelegramModule } from '../telegram/telegram.module';
import { Signal } from './entities/signal.entity';
import { RecommendationService } from './recommendation.service';
import { SignalController } from './signal.controller';
import { SignalService } from './signal.service';

@Module({
  imports: [TypeOrmModule.forFeature([Signal, StockPrice]), TelegramModule],
  controllers: [SignalController],
  providers: [SignalService, RecommendationService],
  exports: [SignalService, RecommendationService],
})
export class SignalModule {}
