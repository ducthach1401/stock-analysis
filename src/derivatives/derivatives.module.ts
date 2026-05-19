import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module';
import { StockModule } from '../stock/stock.module';
import { TelegramModule } from '../telegram/telegram.module';
import { DerivativesController } from './derivatives.controller';
import { DerivativesService } from './derivatives.service';
import { DerivativeDecision } from './entities/derivative-decision.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([DerivativeDecision]),
    AuthModule,
    StockModule,
    TelegramModule,
  ],
  controllers: [DerivativesController],
  providers: [DerivativesService],
  exports: [DerivativesService],
})
export class DerivativesModule {}
