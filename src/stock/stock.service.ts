import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { TelegramService } from '../telegram/telegram.service';
import { StockPriceResponseDto } from './dto/stock-query.dto';
import { DNSE_EARLIEST_FROM, DnseService } from './dnse.service';
import { StockPrice } from './entities/stock-price.entity';

@Injectable()
export class StockService {
  private readonly logger = new Logger(StockService.name);

  constructor(
    @InjectRepository(StockPrice)
    private readonly stockPriceRepo: Repository<StockPrice>,
    private readonly telegramService: TelegramService,
    private readonly dnseService: DnseService,
  ) {}

  // Lấy dữ liệu giá lịch sử từ DNSE LightSpeed API
  async fetchHistory(
    ticker: string,
    from?: string,
    to?: string,
  ): Promise<StockPriceResponseDto[]> {
    const toDate = to ? new Date(to) : new Date();
    const fromDate = from
      ? new Date(from)
      : new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);

    return this.dnseService.fetchOhlc(ticker, fromDate, toDate);
  }

  /** Lịch sử tối đa từ DNSE (từ ~2000 / ngày IPO trên hệ thống) đến `to`. */
  async fetchFullHistory(
    ticker: string,
    to?: string,
  ): Promise<StockPriceResponseDto[]> {
    const toDate = to ? new Date(to) : new Date();
    return this.dnseService.fetchOhlcFullHistory(
      ticker,
      DNSE_EARLIEST_FROM,
      toDate,
    );
  }

  // Lấy giá phiên gần nhất (thay thế intraday khi không có auth DNSE)
  async fetchLatestBar(ticker: string): Promise<StockPriceResponseDto | null> {
    return this.dnseService.fetchLatestBar(ticker);
  }

  // Sync lịch sử vào MySQL (INSERT IGNORE theo ticker + tradingDate)
  async syncHistory(
    ticker: string,
    from?: string,
    to?: string,
  ): Promise<number> {
    this.logger.log(`Syncing history for ${ticker}...`);
    const bars = await this.fetchHistory(ticker, from, to);
    return this.persistPriceBars(ticker, bars);
  }

  /**
   * Sync toàn bộ năm có trên DNSE (từ mốc 2000-01-01 → nay).
   * Dữ liệu thực tế bắt đầu từ ngày mã niêm yết; INSERT IGNORE giữ bản ghi cũ.
   */
  async syncHistoryFull(ticker: string, to?: string): Promise<number> {
    const toLabel = to ?? 'nay';
    this.logger.log(
      `Syncing FULL history for ${ticker} (từ ${DNSE_EARLIEST_FROM.toISOString().slice(0, 10)} → ${toLabel})...`,
    );
    const bars = await this.fetchFullHistory(ticker, to);
    return this.persistPriceBars(ticker, bars);
  }

  private async persistPriceBars(
    ticker: string,
    bars: StockPriceResponseDto[],
  ): Promise<number> {
    if (!bars.length) return 0;

    const COLS =
      '(`ticker`, `tradingDate`, `open`, `high`, `low`, `close`, `volume`, `foreignBuyVolume`, `foreignSellVolume`)';
    let saved = 0;
    const CHUNK = 50;

    for (let i = 0; i < bars.length; i += CHUNK) {
      const chunk = bars.slice(i, i + CHUNK);
      const placeholders = chunk.map(() => '(?,?,?,?,?,?,?,?,?)').join(',');
      const params = chunk.flatMap((b) => [
        b.ticker,
        b.tradingDate,
        b.open,
        b.high,
        b.low,
        b.close,
        b.volume,
        b.foreignBuyVolume,
        b.foreignSellVolume,
      ]);
      const result: { affectedRows?: number } = await this.stockPriceRepo.query(
        `INSERT IGNORE INTO stock_prices ${COLS} VALUES ${placeholders}`,
        params,
      );
      saved += result?.affectedRows ?? 0;
    }

    this.logger.log(`Saved ${saved}/${bars.length} new records for ${ticker}`);
    return saved;
  }

  // Kiểm tra biến động so với phiên trước và gửi cảnh báo Telegram
  async checkAndAlert(ticker: string, threshold = 3): Promise<void> {
    const latest = await this.dnseService.fetchLatestBar(ticker);
    if (!latest) return;

    // Lấy phiên trước đó từ DB để so sánh
    const prev = await this.stockPriceRepo.findOne({
      where: { ticker: ticker.toUpperCase() },
      order: { tradingDate: 'DESC' },
    });

    if (!prev) return;

    const prevClose = Number(prev.close);
    if (!prevClose) return;

    const changePercent = ((latest.close - prevClose) / prevClose) * 100;
    if (Math.abs(changePercent) >= threshold) {
      const direction = changePercent >= 0 ? '🟢 Tăng' : '🔴 Giảm';
      const fmt = (n: number) =>
        (n / 1000).toLocaleString('vi-VN', { maximumFractionDigits: 1 }) + 'k';
      await this.telegramService.sendStockAlert(
        ticker,
        `${direction} <b>${Math.abs(changePercent).toFixed(2)}%</b>\n` +
          `Giá: <b>${fmt(latest.close)}đ</b> (hôm qua: ${fmt(prevClose)}đ)\n` +
          `Cao: ${fmt(latest.high)}đ | Thấp: ${fmt(latest.low)}đ\n` +
          `KL: ${latest.volume.toLocaleString('vi-VN')}`,
      );
    }
  }

  async getStoredHistory(
    ticker: string,
    from?: string,
    to?: string,
  ): Promise<StockPrice[]> {
    const qb = this.stockPriceRepo
      .createQueryBuilder('sp')
      .where('sp.ticker = :ticker', { ticker: ticker.toUpperCase() })
      .orderBy('sp.tradingDate', 'DESC');

    if (from) qb.andWhere('sp.tradingDate >= :from', { from });
    if (to) qb.andWhere('sp.tradingDate <= :to', { to });

    return qb.getMany();
  }

  // Seed dữ liệu mẫu — dùng khi DNSE không có dữ liệu hoặc test offline
  async seedTestData(
    ticker: string,
    bars = 120,
    basePrice?: number,
  ): Promise<{ saved: number; ticker: string; currentPrice: number }> {
    const symbol = ticker.toUpperCase();

    await this.stockPriceRepo.delete({ ticker: symbol });

    const records: Partial<StockPrice>[] = [];
    const targetClose = basePrice
      ? basePrice * 1000
      : 50000 + Math.random() * 50000;
    let close = targetClose * (0.85 + Math.random() * 0.3);
    const today = new Date();

    for (let i = bars; i >= 0; i--) {
      const date = new Date(today);
      date.setDate(today.getDate() - i);
      if (date.getDay() === 0 || date.getDay() === 6) continue;

      const pullToTarget = (targetClose - close) * 0.02;
      const noise = close * (Math.random() * 0.04 - 0.02);
      close = Math.max(1000, close + noise + pullToTarget);

      const open = close * (1 + (Math.random() * 0.02 - 0.01));
      const high = Math.max(open, close) * (1 + Math.random() * 0.02);
      const low = Math.min(open, close) * (1 - Math.random() * 0.02);
      const isHammer = i % 20 === 0;
      const isEngulfing = i % 15 === 0;

      records.push(
        this.stockPriceRepo.create({
          ticker: symbol,
          tradingDate: date.toISOString().split('T')[0],
          open: Math.round(isHammer ? close * 0.98 : open),
          high: Math.round(isHammer ? close * 0.99 : high),
          low: Math.round(isHammer ? close * 0.93 : low),
          close: Math.round(close),
          volume: Math.floor(500000 + Math.random() * 2000000),
          foreignBuyVolume: Math.floor(Math.random() * 200000),
          foreignSellVolume: Math.floor(Math.random() * 200000),
        }),
      );

      if (i < bars / 3 && i > bars / 4) close *= 0.985;
      if (i === 5) {
        const last = records[records.length - 1];
        if (last) last.volume = 5000000;
      }
      if (isEngulfing && records.length >= 2) {
        const prev = records[records.length - 2];
        if (prev) {
          prev.open = Math.round(close * 1.02);
          prev.close = Math.round(close * 0.99);
        }
      }
    }

    if (basePrice && records.length > 0) {
      const last = records[records.length - 1];
      if (last) {
        const exact = basePrice * 1000;
        last.close = exact;
        const newOpen = Math.round(exact * (1 + (Math.random() * 0.02 - 0.01)));
        last.open = newOpen;
        last.high = Math.round(
          Math.max(newOpen, exact) * (1 + Math.random() * 0.01),
        );
        last.low = Math.round(
          Math.min(newOpen, exact) * (1 - Math.random() * 0.01),
        );
      }
    }

    await this.stockPriceRepo.save(records);
    const finalClose = Number(records[records.length - 1]?.close ?? 0);
    this.logger.log(
      `Seeded ${records.length} bars for ${symbol}, close=${finalClose.toLocaleString('vi-VN')}đ`,
    );
    return { saved: records.length, ticker: symbol, currentPrice: finalClose };
  }
}
