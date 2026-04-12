import { OgmaService } from '@ogma/nestjs-module';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app/app.module';
import { TelegramService } from './telegram/telegram.service';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(OgmaService));
  const port = process.env.PORT ?? 3000;
  await app.listen(port);

  const telegram = app.get(TelegramService);
  const env = process.env.NODE_ENV ?? 'development';
  const hostname = process.env.HOSTNAME ?? 'localhost';

  // Gửi sau 5s để Docker network ổn định, không block startup
  setTimeout(() => {
    telegram
      .sendMessage({
        text:
          `🚀 <b>Stock Analysis Server</b> đã khởi động\n\n` +
          `🌍 Env: <code>${env}</code>\n` +
          `🖥️ Host: <code>${hostname}</code>\n` +
          `🔌 Port: <code>${port}</code>\n` +
          `🕐 Time: <code>${new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })}</code>`,
      })
      .catch((err: unknown) => {
        // Không crash server nếu Telegram lỗi lúc startup
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[TelegramService] Startup notification failed: ${msg}`);
      });
  }, 5000);
}

bootstrap();
