import { Module } from '@nestjs/common';
import { TelegramNotifyPolicyService } from './telegram-notify-policy.service';
import { TelegramService } from './telegram.service';

@Module({
  providers: [TelegramService, TelegramNotifyPolicyService],
  exports: [TelegramService, TelegramNotifyPolicyService],
})
export class TelegramModule {}
