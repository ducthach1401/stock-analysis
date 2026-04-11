import { Module } from '@nestjs/common';
import { SignalModule } from '../signal/signal.module';
import { StockModule } from '../stock/stock.module';
import { TelegramModule } from '../telegram/telegram.module';
import { PositionModule } from '../position/position.module';
import { ScannerController } from './scanner.controller';
import { ScannerService } from './scanner.service';

@Module({
  imports: [StockModule, SignalModule, TelegramModule, PositionModule],
  controllers: [ScannerController],
  providers: [ScannerService],
})
export class ScannerModule {}
