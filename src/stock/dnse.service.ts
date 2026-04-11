import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { StockPriceResponseDto } from './dto/stock-query.dto';

// DNSE LightSpeed — chart API không cần auth
const DNSE_CHART_BASE =
  'https://services.entrade.com.vn/chart-api/v2/ohlcs/stock';

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
   * Lấy lịch sử OHLCV từ DNSE LightSpeed API (miễn phí, không cần auth).
   * Giá trả về từ DNSE đơn vị là nghìn đồng (vd: 62.8 = 62,800đ),
   * service này nhân ×1000 trước khi trả về để đồng nhất với DB.
   */
  async fetchOhlc(
    ticker: string,
    from: Date,
    to: Date,
  ): Promise<StockPriceResponseDto[]> {
    const symbol = ticker.toUpperCase();
    const fromTs = Math.floor(from.getTime() / 1000);
    const toTs = Math.floor(to.getTime() / 1000);

    const { data } = await axios.get<DnseOhlcResponse>(DNSE_CHART_BASE, {
      params: { symbol, resolution: '1D', from: fromTs, to: toTs },
      headers: { 'User-Agent': 'Mozilla/5.0 Chrome/124.0' },
      timeout: 15000,
    });

    const t = data?.t ?? [];
    const o = data?.o ?? [];
    const h = data?.h ?? [];
    const l = data?.l ?? [];
    const c = data?.c ?? [];
    const v = data?.v ?? [];

    if (!t.length) {
      this.logger.warn(`DNSE trả về 0 bars cho ${symbol}`);
      return [];
    }

    return t.map((ts, i) => {
      const date = new Date(ts * 1000);
      const yyyy = date.getFullYear();
      const mm = String(date.getMonth() + 1).padStart(2, '0');
      const dd = String(date.getDate()).padStart(2, '0');

      // DNSE giá đơn vị nghìn đồng → nhân 1000 lấy VND
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

  /**
   * Lấy bar mới nhất (giá hiện tại / phiên gần đây nhất).
   */
  async fetchLatestBar(ticker: string): Promise<StockPriceResponseDto | null> {
    const to = new Date();
    const from = new Date(to.getTime() - 7 * 24 * 60 * 60 * 1000); // 7 ngày trước
    const bars = await this.fetchOhlc(ticker, from, to);
    return bars.length ? (bars[bars.length - 1] ?? null) : null;
  }
}
