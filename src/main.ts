import { NestFactory } from '@nestjs/core';
import { AppModule } from './app/app.module';
import { TelegramService } from './telegram/telegram.service';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const port = process.env.PORT ?? 3000;
  await app.listen(port);

  const telegram = app.get(TelegramService);
  const env = process.env.NODE_ENV ?? 'development';
  const hostname = process.env.HOSTNAME ?? 'localhost';

  await telegram
    .sendMessage({
      text:
        `🚀 <b>Stock Analysis Server</b> đã khởi động\n\n` +
        `🌍 Env: <code>${env}</code>\n` +
        `🖥️ Host: <code>${hostname}</code>\n` +
        `🔌 Port: <code>${port}</code>\n` +
        `🕐 Time: <code>${new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })}</code>`,
    })
    .catch(() => {
      // Không để lỗi Telegram làm crash server
    });
}

bootstrap();
