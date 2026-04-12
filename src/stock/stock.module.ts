import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module';
import { SignalModule } from '../signal/signal.module';
import { TelegramModule } from '../telegram/telegram.module';
import { DnseService } from './dnse.service';
import { StockPrice } from './entities/stock-price.entity';
import { StockController } from './stock.controller';
import { StockService } from './stock.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([StockPrice]),
    TelegramModule,
    AuthModule,
    SignalModule,
  ],
  controllers: [StockController],
  providers: [StockService, DnseService],
  exports: [StockService, DnseService],
})
export class StockModule {}
