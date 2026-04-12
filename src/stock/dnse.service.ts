import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { StockPriceResponseDto } from './dto/stock-query.dto';

// DNSE LightSpeed — chart API không cần auth
const DNSE_CHART_BASE =
  'https://services.entrade.com.vn/chart-api/v2/ohlcs/stock';

/** Mốc sớm an toàn trước mọi IPO hợp lệ trên sàn VN (DNSE chỉ có dữ liệu từ khi mã niêm yết). */
export const DNSE_EARLIEST_FROM = new Date('2000-01-01T00:00:00.000Z');

interface DnseOhlcResponse {
  t: number[] | null;
  o: number[] | null;
  h: number[] | null;
  l: number[] | null;
  c: number[] | null;
  v: number[] | null;
  nextTime: number;
}

@Injectable()
export class DnseService {
  private readonly logger = new Logger(DnseService.name);

  /**
   * Một request đơn — dùng cho range nhỏ / incremental.
   */
  async fetchOhlc(
    ticker: string,
    from: Date,
    to: Date,
  ): Promise<StockPriceResponseDto[]> {
    const symbol = ticker.toUpperCase();
    const fromTs = Math.floor(from.getTime() / 1000);
    const toTs = Math.floor(to.getTime() / 1000);
    const { data } = await this.requestPage(symbol, fromTs, toTs);
    return this.mapToBars(symbol, data);
  }

  /**
   * Toàn bộ lịch sử có trên DNSE từ mốc sớm (≈ IPO) đến `to`.
   * Gộp nhiều request nếu API trả `nextTime` (giới hạn số nến mỗi lần).
   */
  async fetchOhlcFullHistory(
    ticker: string,
    from: Date = DNSE_EARLIEST_FROM,
    to: Date = new Date(),
  ): Promise<StockPriceResponseDto[]> {
    const symbol = ticker.toUpperCase();
    const fromTs = Math.floor(from.getTime() / 1000);
    let toTs = Math.floor(to.getTime() / 1000);
    const byDate = new Map<string, StockPriceResponseDto>();
    const maxPages = 120;

    for (let page = 0; page < maxPages; page++) {
      const { data } = await this.requestPage(symbol, fromTs, toTs);
      const chunk = this.mapToBars(symbol, data);
      for (const b of chunk) byDate.set(b.tradingDate, b);

      const nextTime = data?.nextTime ?? 0;
      if (!nextTime || nextTime <= fromTs) break;

      // Trang tiếp theo: lấy nến cũ hơn (to = nextTime theo convention UDF)
      if (nextTime >= toTs) {
        this.logger.warn(
          `${symbol}: nextTime=${nextTime} không giảm, dừng phân trang`,
        );
        break;
      }
      toTs = nextTime;
    }

    const merged = [...byDate.values()].sort((a, b) =>
      a.tradingDate.localeCompare(b.tradingDate),
    );
    this.logger.log(
      `${symbol}: full history ${merged.length} nến (${merged[0]?.tradingDate ?? '—'} → ${merged[merged.length - 1]?.tradingDate ?? '—'})`,
    );
    return merged;
  }

  /**
   * Lấy bar mới nhất (giá hiện tại / phiên gần đây nhất).
   */
  async fetchLatestBar(ticker: string): Promise<StockPriceResponseDto | null> {
    const to = new Date();
    const from = new Date(to.getTime() - 7 * 24 * 60 * 60 * 1000);
    const bars = await this.fetchOhlc(ticker, from, to);
    return bars.length ? (bars[bars.length - 1] ?? null) : null;
  }

  // ─── Internal ──────────────────────────────────────────────────────────────

  private async requestPage(
    symbol: string,
    fromTs: number,
    toTs: number,
  ): Promise<{ data: DnseOhlcResponse }> {
    return axios.get<DnseOhlcResponse>(DNSE_CHART_BASE, {
      params: { symbol, resolution: '1D', from: fromTs, to: toTs },
      headers: { 'User-Agent': 'Mozilla/5.0 Chrome/124.0' },
      timeout: 30000,
    });
  }

  private mapToBars(
    symbol: string,
    data: DnseOhlcResponse,
  ): StockPriceResponseDto[] {
    const t = data?.t ?? [];
    const o = data?.o ?? [];
    const h = data?.h ?? [];
    const l = data?.l ?? [];
    const c = data?.c ?? [];
    const v = data?.v ?? [];

    if (!t.length) return [];

    return t.map((ts, i) => {
      const date = new Date(ts * 1000);
      const yyyy = date.getFullYear();
      const mm = String(date.getMonth() + 1).padStart(2, '0');
      const dd = String(date.getDate()).padStart(2, '0');

      return {
        ticker: symbol,
        tradingDate: `${yyyy}-${mm}-${dd}`,
        open: Math.round((o[i] ?? 0) * 1000),
        high: Math.round((h[i] ?? 0) * 1000),
        low: Math.round((l[i] ?? 0) * 1000),
        close: Math.round((c[i] ?? 0) * 1000),
        volume: Math.round(v[i] ?? 0),
        foreignBuyVolume: null,
        foreignSellVolume: null,
      };
    });
  }
}
