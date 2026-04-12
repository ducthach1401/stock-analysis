import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module';
import { StockModule } from '../stock/stock.module';
import { TelegramModule } from '../telegram/telegram.module';
import { StockPrice } from '../stock/entities/stock-price.entity';
import { Position } from './entities/position.entity';
import { PositionController } from './position.controller';
import { PositionService } from './position.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Position, StockPrice]),
    StockModule,
    TelegramModule,
    AuthModule,
  ],
  controllers: [PositionController],
  providers: [PositionService],
  exports: [PositionService],
})
export class PositionModule {}
