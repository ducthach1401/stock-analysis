import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { isMarketIndexTicker } from '../scanner/watchlist';
import { IntradayIndexBarDto } from './dto/intraday-bar.dto';
import { StockPriceResponseDto } from './dto/stock-query.dto';

// Entrade chart API — không cần auth (`stock` = cổ phiếu, `index` = VNINDEX / VN30 …)
const DNSE_CHART_STOCK =
  'https://services.entrade.com.vn/chart-api/v2/ohlcs/stock';
const DNSE_CHART_INDEX =
  'https://services.entrade.com.vn/chart-api/v2/ohlcs/index';

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
    /**
     * API Entrade thường giới hạn số nến mỗi request; chỉ số (VNINDEX/VN30) đôi khi chỉ ~10–20 nến/trang.
     * maxPages=120 → dừng sớm quanh 2019–2021 dù vẫn còn nextTime. Tăng mạnh + cảnh báo khi chạm trần.
     */
    const maxPages = 2000;
    let page = 0;
    let lastNextTime = 0;

    for (; page < maxPages; page++) {
      const { data } = await this.requestPage(symbol, fromTs, toTs);
      const chunk = this.mapToBars(symbol, data);
      for (const b of chunk) byDate.set(b.tradingDate, b);

      const nextTime = data?.nextTime ?? 0;
      lastNextTime = nextTime;
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
    if (page >= maxPages && lastNextTime > fromTs) {
      this.logger.warn(
        `${symbol}: đạt giới hạn ${maxPages} request phân trang (nextTime còn=${lastNextTime}, nến cũ nhất=${merged[0]?.tradingDate ?? '—'}). Có thể tăng maxPages trong dnse.service.`,
      );
    }
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

  /**
   * Nến chỉ số VN30 / VNINDEX — Entrade: `5`, `15`, `1H`, `1D` (phút hoặc khung ngày).
   * `4H`: API không có — lấy `1H` rồi gộp 4 nến liên tiếp (OHLC + volume).
   */
  async fetchIntradayIndexOhlc(
    symbol: string,
    resolution: string,
    from: Date,
    to: Date,
  ): Promise<IntradayIndexBarDto[]> {
    const sym = symbol.toUpperCase();
    if (!isMarketIndexTicker(sym)) {
      this.logger.warn(`${sym}: fetchIntradayIndexOhlc chỉ cho VNINDEX/VN30`);
      return [];
    }
    const res = (resolution || '5').trim();
    const u = res.toUpperCase();
    if (u === '4H') {
      const hourly = await this.fetchIndexOhlcRaw(sym, '1H', from, to);
      return this.aggregate1HTo4H(hourly);
    }
    const apiRes =
      u === '1D' ? '1D' : u === '1H' || u === '60' ? '1H' : res;
    return this.fetchIndexOhlcRaw(sym, apiRes, from, to);
  }

  private async fetchIndexOhlcRaw(
    symbol: string,
    resolution: string,
    from: Date,
    to: Date,
  ): Promise<IntradayIndexBarDto[]> {
    const fromTs = Math.floor(from.getTime() / 1000);
    const toTs = Math.floor(to.getTime() / 1000);
    const { data } = await axios.get<DnseOhlcResponse>(DNSE_CHART_INDEX, {
      params: { symbol, resolution, from: fromTs, to: toTs },
      headers: { 'User-Agent': 'Mozilla/5.0 Chrome/124.0' },
      timeout: 60000,
    });
    return this.mapToIntradayBars(symbol, data);
  }

  /** Gộp 4 nến 1H liên tiếp (theo thứ tự thời gian) → một nến 4H. */
  private aggregate1HTo4H(bars: IntradayIndexBarDto[]): IntradayIndexBarDto[] {
    if (!bars.length) return [];
    const sorted = [...bars].sort((a, b) => a.time - b.time);
    const out: IntradayIndexBarDto[] = [];
    const ticker = sorted[0].ticker;
    for (let i = 0; i < sorted.length; i += 4) {
      const chunk = sorted.slice(i, i + 4);
      const first = chunk[0];
      const last = chunk[chunk.length - 1];
      out.push({
        ticker,
        time: first.time,
        open: first.open,
        high: Math.max(...chunk.map((b) => b.high)),
        low: Math.min(...chunk.map((b) => b.low)),
        close: last.close,
        volume: chunk.reduce((s, b) => s + (b.volume ?? 0), 0),
      });
    }
    return out;
  }

  // ─── Internal ──────────────────────────────────────────────────────────────

  private chartUrlForSymbol(symbol: string): string {
    return isMarketIndexTicker(symbol) ? DNSE_CHART_INDEX : DNSE_CHART_STOCK;
  }

  private async requestPage(
    symbol: string,
    fromTs: number,
    toTs: number,
  ): Promise<{ data: DnseOhlcResponse }> {
    const url = this.chartUrlForSymbol(symbol);
    return axios.get<DnseOhlcResponse>(url, {
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

  private mapToIntradayBars(
    symbol: string,
    data: DnseOhlcResponse,
  ): IntradayIndexBarDto[] {
    const t = data?.t ?? [];
    const o = data?.o ?? [];
    const h = data?.h ?? [];
    const l = data?.l ?? [];
    const c = data?.c ?? [];
    const v = data?.v ?? [];
    if (!t.length) return [];

    return t.map((ts, i) => ({
      ticker: symbol,
      time: ts,
      open: Math.round((o[i] ?? 0) * 1000),
      high: Math.round((h[i] ?? 0) * 1000),
      low: Math.round((l[i] ?? 0) * 1000),
      close: Math.round((c[i] ?? 0) * 1000),
      volume: Math.round(v[i] ?? 0),
    }));
  }
}
