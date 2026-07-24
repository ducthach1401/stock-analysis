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
// HĐTL phái sinh — chỉ nhận ký hiệu liên tục VN30F1M (tháng gần) / VN30F2M (tháng kế),
// KHÔNG nhận mã kỳ hạn cụ thể (VN30F2508 → invalid symbol). Không cần auth.
const DNSE_CHART_DERIVATIVE =
  'https://services.entrade.com.vn/chart-api/v2/ohlcs/derivative';

/** Nhận diện ký hiệu HĐTL phái sinh liên tục mà Entrade hỗ trợ. */
const DERIVATIVE_TICKER_RE = /^VN30F(1M|2M)$/;
export function isDerivativeTicker(ticker: string): boolean {
  return DERIVATIVE_TICKER_RE.test(ticker.toUpperCase());
}

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
    const apiRes = u === '1D' ? '1D' : u === '1H' || u === '60' ? '1H' : res;
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

  /**
   * Nến HĐTL phái sinh VN30F1M / VN30F2M từ endpoint `derivative` (giá & volume của chính hợp đồng,
   * khác chỉ số VN30 — basis dao động tới ~±8đ/ngày). Resolution: `5`, `15`, `1H`, `1D` như index.
   */
  /**
   * `includeForming`: CHỈ dùng cho hiển thị chart (UX chuẩn: thấy nến cuối chạy sống). Quyết định
   * giao dịch (`derivatives.service.ts`) KHÔNG được truyền true — luôn giữ mặc định false để không
   * bao giờ tính EMA/RSI/ATR/breakout trên một nến chưa đóng (tránh tín hiệu giả/lookahead).
   */
  async fetchIntradayDerivativeOhlc(
    symbol: string,
    resolution: string,
    from: Date,
    to: Date,
    includeForming = false,
  ): Promise<IntradayIndexBarDto[]> {
    const sym = symbol.toUpperCase();
    if (!isDerivativeTicker(sym)) {
      this.logger.warn(
        `${sym}: fetchIntradayDerivativeOhlc chỉ cho VN30F1M/VN30F2M`,
      );
      return [];
    }
    const res = (resolution || '5').trim();
    const u = res.toUpperCase();
    const apiRes = u === '1D' ? '1D' : u === '1H' || u === '60' ? '1H' : res;
    const native = await this.fetchDerivativeOhlcRaw(sym, apiRes, from, to);
    // Endpoint 5m của Entrade publish trễ hơn 1m ~1 nến (nến 5m chỉ xuất hiện sau khi bucket đóng +
    // delay xử lý). Với khung 5m, bù đuôi bằng nến 1m gộp về 5m → chart & bot bớt trễ ~5-8 phút.
    if (u === '5') {
      const { closedTail, forming } = await this.fiveMinFromOneMin(
        sym,
        to,
        includeForming,
      );
      let merged = closedTail.length
        ? this.mergeBarsByTime(native, closedTail)
        : native;
      // Nến đang hình thành APPEND SAU CÙNG, không qua mergeBarsByTime (không được lẫn với dữ liệu
      // đã đóng) — chỉ chart mới nhận được nó.
      if (forming) merged = [...merged, forming];
      return merged;
    }
    return native;
  }

  private async fetchDerivativeOhlcRaw(
    symbol: string,
    resolution: string,
    from: Date,
    to: Date,
  ): Promise<IntradayIndexBarDto[]> {
    const fromTs = Math.floor(from.getTime() / 1000);
    const toTs = Math.floor(to.getTime() / 1000);
    const { data } = await axios.get<DnseOhlcResponse>(DNSE_CHART_DERIVATIVE, {
      params: { symbol, resolution, from: fromTs, to: toTs },
      headers: { 'User-Agent': 'Mozilla/5.0 Chrome/124.0' },
      timeout: 60000,
    });
    return this.mapToIntradayBars(symbol, data);
  }

  /**
   * Gộp nến 1m gần nhất (~45 phút) thành nến 5m — MỘT lần fetch 1m, tách 2 kết quả:
   * - `closedTail`: bucket ĐÃ ĐÓNG (start+300s ≤ now) — dùng bù độ trễ publish của endpoint 5m,
   *   an toàn cho cả decision lẫn chart.
   * - `forming`: bucket đang chạy (nếu `includeForming`, có ≥60s dữ liệu) — CHỈ để chart hiển thị
   *   nến sống, KHÔNG bao giờ lẫn vào closedTail/decision.
   * Lỗi mạng → trả rỗng cả 2 (fallback về native).
   */
  private async fiveMinFromOneMin(
    symbol: string,
    to: Date,
    includeForming: boolean,
  ): Promise<{
    closedTail: IntradayIndexBarDto[];
    forming: IntradayIndexBarDto | null;
  }> {
    try {
      const from = new Date(to.getTime() - 45 * 60 * 1000);
      const oneMin = await this.fetchDerivativeOhlcRaw(symbol, '1', from, to);
      if (!oneMin.length) return { closedTail: [], forming: null };
      const nowSec = Math.floor(Date.now() / 1000);
      const buckets = new Map<number, IntradayIndexBarDto>();
      for (const b of oneMin.sort((a, c) => a.time - c.time)) {
        const start = Math.floor(b.time / 300) * 300;
        const cur = buckets.get(start);
        if (!cur) {
          buckets.set(start, { ...b, time: start });
        } else {
          cur.high = Math.max(cur.high, b.high);
          cur.low = Math.min(cur.low, b.low);
          cur.close = b.close;
          cur.volume = (cur.volume ?? 0) + (b.volume ?? 0);
        }
      }
      const closedTail = [...buckets.values()].filter(
        (b) => b.time + 300 <= nowSec,
      );
      let forming: IntradayIndexBarDto | null = null;
      // Chỉ tính forming khi `to` gần "hiện tại" thật (không áp cho các trang phân trang lịch sử cũ).
      if (includeForming && Date.now() - to.getTime() < 5 * 60 * 1000) {
        const curStart = Math.floor(nowSec / 300) * 300;
        const cur = buckets.get(curStart);
        // Cần ≥60s dữ liệu mới hiển thị — tránh nến gần như rỗng ngay khi bucket vừa mở.
        if (cur && nowSec - curStart >= 60) forming = cur;
      }
      return { closedTail, forming };
    } catch (e) {
      this.logger.debug(
        `${symbol}: bù đuôi 1m→5m lỗi, dùng native — ${(e as Error).message}`,
      );
      return { closedTail: [], forming: null };
    }
  }

  /** Union theo `time`; khi trùng bucket, ưu tiên `primary` (native — giá đóng chính thức). */
  private mergeBarsByTime(
    primary: IntradayIndexBarDto[],
    extra: IntradayIndexBarDto[],
  ): IntradayIndexBarDto[] {
    const byTime = new Map<number, IntradayIndexBarDto>();
    for (const b of extra) byTime.set(b.time, b);
    for (const b of primary) byTime.set(b.time, b); // native ghi đè extra khi trùng
    return [...byTime.values()].sort((a, b) => a.time - b.time);
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
