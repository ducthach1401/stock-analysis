import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosError } from 'axios';

export interface TelegramMessage {
  text: string;
  parseMode?: 'HTML' | 'Markdown' | 'MarkdownV2';
  chatId?: string;
}

const MAX_TEXT_LENGTH = 4000; // Telegram limit = 4096, để thêm buffer
const MAX_RETRIES = 3;
const RETRY_DELAYS_MS = [2000, 5000, 10000]; // backoff: 2s → 5s → 10s
const QUEUE_INTERVAL_MS = 1100; // 1 msg/giây per chat (Telegram TOS)

@Injectable()
export class TelegramService {
  private readonly logger = new Logger(TelegramService.name);
  private readonly botToken: string;
  private readonly defaultChatId: string;
  private readonly apiUrl: string;

  // Queue để tránh vượt rate limit
  private queue: Array<() => Promise<void>> = [];
  private processing = false;

  constructor(private readonly configService: ConfigService) {
    this.botToken = this.configService.getOrThrow<string>('TELEGRAM_BOT_TOKEN');
    this.defaultChatId =
      this.configService.getOrThrow<string>('TELEGRAM_CHAT_ID');
    this.apiUrl = `https://api.telegram.org/bot${this.botToken}`;
  }

  async sendMessage(message: TelegramMessage): Promise<void> {
    return new Promise((resolve, reject) => {
      this.queue.push(async () => {
        try {
          await this.sendWithRetry(message);
          resolve();
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
      this.processQueue();
    });
  }

  private async processQueue(): Promise<void> {
    if (this.processing) return;
    this.processing = true;

    while (this.queue.length > 0) {
      const task = this.queue.shift();
      if (task) {
        await task();
        if (this.queue.length > 0) {
          // Đợi QUEUE_INTERVAL_MS trước khi gửi tin tiếp
          await this.sleep(QUEUE_INTERVAL_MS);
        }
      }
    }

    this.processing = false;
  }

  private async sendWithRetry(
    message: TelegramMessage,
    attempt = 0,
  ): Promise<void> {
    const chatId = message.chatId ?? this.defaultChatId;
    const text = this.truncate(message.text);
    const parse_mode = message.parseMode ?? 'HTML';

    try {
      await axios.post(
        `${this.apiUrl}/sendMessage`,
        { chat_id: chatId, text, parse_mode },
        { timeout: 15000 },
      );
      this.logger.log(`Message sent to chat ${chatId}`);
    } catch (err) {
      const error = err as AxiosError<{
        description?: string;
        error_code?: number;
      }>;
      const status = error.response?.status;
      const tgDesc = error.response?.data?.description ?? error.message;
      const tgCode = error.response?.data?.error_code;

      this.logger.warn(
        `Telegram gửi thất bại (lần ${attempt + 1}/${MAX_RETRIES + 1}) ` +
          `status=${status ?? 'N/A'} code=${tgCode ?? 'N/A'}: ${tgDesc}`,
      );

      // 429 = rate limit → bắt buộc phải retry
      // 5xx = server error Telegram → nên retry
      // 400 HTML parse error → thử lại với plain text
      const shouldRetry =
        attempt < MAX_RETRIES &&
        (status === 429 || (status !== undefined && status >= 500) || !status);

      if (status === 429) {
        // Telegram trả về retry_after trong header
        const retryAfter =
          Number(error.response?.headers?.['retry-after'] ?? 5) * 1000 + 500;
        this.logger.warn(`Rate limited — chờ ${retryAfter}ms rồi thử lại`);
        await this.sleep(retryAfter);
        return this.sendWithRetry(message, attempt + 1);
      }

      if (status === 400 && tgDesc?.includes("can't parse entities")) {
        // HTML bị lỗi → gửi lại bằng plain text
        this.logger.warn(`HTML parse lỗi, thử lại với plain text`);
        return this.sendWithRetry(
          { ...message, parseMode: undefined, text: this.stripHtml(text) },
          attempt + 1,
        );
      }

      if (shouldRetry) {
        const delay = RETRY_DELAYS_MS[attempt] ?? 10000;
        this.logger.warn(`Thử lại sau ${delay}ms...`);
        await this.sleep(delay);
        return this.sendWithRetry(message, attempt + 1);
      }

      // Hết retry → log lỗi nhưng không crash toàn bộ scan
      this.logger.error(
        `Telegram gửi thất bại hoàn toàn sau ${attempt + 1} lần: ${tgDesc}`,
      );
    }
  }

  async sendStockAlert(symbol: string, message: string): Promise<void> {
    await this.sendMessage({
      text: `📈 <b>Stock Alert: ${symbol}</b>\n\n${message}`,
      parseMode: 'HTML',
    });
  }

  async sendErrorAlert(context: string, error: string): Promise<void> {
    await this.sendMessage({
      text: `🚨 <b>Error in ${context}</b>\n\n<code>${this.escapeHtml(error)}</code>`,
      parseMode: 'HTML',
    });
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private truncate(text: string): string {
    if (text.length <= MAX_TEXT_LENGTH) return text;
    return text.slice(0, MAX_TEXT_LENGTH) + '\n…<i>(đã cắt bớt)</i>';
  }

  private stripHtml(text: string): string {
    return text
      .replace(/<[^>]*>/g, '')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&');
  }

  private escapeHtml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
