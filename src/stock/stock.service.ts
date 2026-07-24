import {
  BadRequestException,
  Injectable,
  Logger,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import Redis from 'ioredis';
import { Repository } from 'typeorm';
import { vnCalendarTodayYmd } from '../common/vn-trading-days';
import { isMarketIndexTicker } from '../scanner/watchlist';
import { TelegramNotifyPolicyService } from '../telegram/telegram-notify-policy.service';
import { TelegramService } from '../telegram/telegram.service';
import { IntradayIndexBarDto } from './dto/intraday-bar.dto';
import { StockPriceResponseDto } from './dto/stock-query.dto';
import {
  DNSE_EARLIEST_FROM,
  DnseService,
  isDerivativeTicker,
} from './dnse.service';
import { StockPrice } from './entities/stock-price.entity';

/** Ngày lịch chồng lên nến cũ nhất khi sync tiếp (bắt gap + chỉnh nhẹ). */
export const SYNC_OVERLAP_CALENDAR_DAYS = 7;

/**
 * |close_api - close_db| / close_db trên khoảng overlap vượt ngưỡng → coi như chỉnh tỉ lệ/cổ tức,
 * xóa giá local và sync lại full IPO.
 */
export const SYNC_PRICE_REVISION_RELATIVE = 0.025;

const ANALYZE_FROM_AFTER_FULL_RESYNC = '2010-01-01';

@Injectable()
export class StockService implements OnModuleDestroy {
  private readonly logger = new Logger(StockService.name);
  private readonly redisClient: Redis | null;
  private readonly intradayCacheEnabled: boolean;

  constructor(
    @InjectRepository(StockPrice)
    private readonly stockPriceRepo: Repository<StockPrice>,
    private readonly telegramService: TelegramService,
    private readonly telegramNotifyPolicy: TelegramNotifyPolicyService,
    private readonly dnseService: DnseService,
    private readonly config: ConfigService,
  ) {
    const host = this.config.get<string>('REDIS_HOST', '').trim();
    const port = Number(this.config.get<number>('REDIS_PORT', 6379));
    if (!host || !Number.isFinite(port) || port <= 0) {
      this.redisClient = null;
      this.intradayCacheEnabled = false;
      return;
    }
    this.redisClient = new Redis({
      host,
      port,
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
    });
    this.intradayCacheEnabled = true;
  }

  async onModuleDestroy() {
    if (!this.redisClient) return;
    try {
      await this.redisClient.quit();
    } catch {
      this.redisClient.disconnect();
    }
  }

  async deleteAllPricesForTicker(ticker: string): Promise<void> {
    await this.stockPriceRepo.delete({ ticker: ticker.toUpperCase() });
  }

  /**
   * MAX(tradingDate) từ MySQL/TypeORM có thể trả `Date` hoặc string — không được nối chuỗi trực tiếp
   * (sẽ ra `Invalid time value` trong subtractCalendarDays).
   */
  private normalizeSqlDate(value: unknown): string | null {
    if (value == null) return null;
    if (typeof value === 'string') {
      const m = /^(\d{4}-\d{2}-\d{2})/.exec(value.trim());
      if (m) return m[1];
      const d = new Date(value);
      if (Number.isNaN(d.getTime())) return null;
      return this.ymdFromLocalDate(d);
    }
    if (value instanceof Date) {
      if (Number.isNaN(value.getTime())) return null;
      return this.ymdFromLocalDate(value);
    }
    return null;
  }

  private ymdFromLocalDate(d: Date): string {
    const y = d.getFullYear();
    const mo = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${mo}-${day}`;
  }

  /** Ngày giao dịch mới nhất đang có trong DB (YYYY-MM-DD), hoặc null. */
  async getLatestTradingDateInDb(ticker: string): Promise<string | null> {
    const row = await this.stockPriceRepo
      .createQueryBuilder('sp')
      .select('MAX(sp.tradingDate)', 'mx')
      .where('sp.ticker = :t', { t: ticker.toUpperCase() })
      .getRawOne<{ mx: unknown }>();
    return this.normalizeSqlDate(row?.mx);
  }

  subtractCalendarDays(isoDate: string | Date, days: number): string {
    const s = this.normalizeSqlDate(isoDate);
    if (!s) {
      throw new BadRequestException(
        `Ngày không hợp lệ khi lùi lịch sync: ${String(isoDate)}`,
      );
    }
    const d = new Date(s + 'T12:00:00.000Z');
    if (Number.isNaN(d.getTime())) {
      throw new BadRequestException(`Không parse được ngày: ${s}`);
    }
    d.setUTCDate(d.getUTCDate() - days);
    return d.toISOString().slice(0, 10);
  }

  /**
   * So khớp giá đóng API vs DB trong cùng các ngày có trong `apiBars`.
   * Trả true nếu có ngày trùng mà lệch quá SYNC_PRICE_REVISION_RELATIVE.
   */
  private async pricesDivergedVersusDb(
    ticker: string,
    apiBars: StockPriceResponseDto[],
  ): Promise<boolean> {
    if (!apiBars.length) return false;
    const t = ticker.toUpperCase();
    const dates = [...new Set(apiBars.map((b) => b.tradingDate))].sort();
    const rows = await this.stockPriceRepo
      .createQueryBuilder('sp')
      .where('sp.ticker = :t', { t })
      .andWhere('sp.tradingDate IN (:...d)', { d: dates })
      .getMany();
    const dbCloseByDate = new Map(
      rows.map((r) => [r.tradingDate, Number(r.close)]),
    );
    for (const bar of apiBars) {
      const dbClose = dbCloseByDate.get(bar.tradingDate);
      if (dbClose == null || !Number.isFinite(dbClose) || dbClose <= 0)
        continue;
      const apiClose = Number(bar.close);
      if (!Number.isFinite(apiClose) || apiClose <= 0) continue;
      const rel = Math.abs(apiClose - dbClose) / dbClose;
      if (rel > SYNC_PRICE_REVISION_RELATIVE) {
        this.logger.warn(
          `${t} ${bar.tradingDate}: close DB=${dbClose} vs API=${apiClose} (lệch ${(rel * 100).toFixed(2)}%)`,
        );
        return true;
      }
    }
    return false;
  }

  /**
   * Đồng bộ “thông minh”: DB trống → ~1 năm; đã có nến → overlap ~7 ngày.
   * Lệch giá lớn trên overlap → xóa giá + `syncHistoryFull` (IPO → nay trên DNSE).
   */
  async syncHistorySmart(
    ticker: string,
    defaultFrom?: string,
    to?: string,
  ): Promise<{
    saved: number;
    mode: 'initial_window' | 'incremental' | 'full_resync_corporate_action';
    /**
     * Mốc giá vừa fetch lại (overlap / full resync) — chỉ để log / API.
     * Không dùng để giới hạn `analyzeAllHistory` (sẽ bỏ sót tín hiệu năm cũ).
     */
    analyzeFrom?: string;
  }> {
    const t = ticker.toUpperCase();
    const maxDb = await this.getLatestTradingDateInDb(t);

    if (!maxDb) {
      const saved = await this.syncHistory(t, defaultFrom, to);
      return { saved, mode: 'initial_window', analyzeFrom: defaultFrom };
    }

    const overlapStart = this.subtractCalendarDays(
      maxDb,
      SYNC_OVERLAP_CALENDAR_DAYS,
    );
    const apiOverlapBars = await this.fetchHistory(t, overlapStart, maxDb);
    const diverged = await this.pricesDivergedVersusDb(t, apiOverlapBars);
    if (diverged) {
      this.logger.warn(
        `${t}: overlap ${overlapStart}→${maxDb} lệch lớn so với DNSE — xóa stock_prices & sync full IPO`,
      );
      await this.deleteAllPricesForTicker(t);
      const saved = await this.syncHistoryFull(t, to);
      return {
        saved,
        mode: 'full_resync_corporate_action',
        analyzeFrom: ANALYZE_FROM_AFTER_FULL_RESYNC,
      };
    }

    const incrementalFrom = this.subtractCalendarDays(
      maxDb,
      SYNC_OVERLAP_CALENDAR_DAYS,
    );
    this.logger.log(
      `${t}: sync tăng dần từ ${incrementalFrom} (overlap ${SYNC_OVERLAP_CALENDAR_DAYS} ngày)`,
    );
    const saved = await this.syncHistory(t, incrementalFrom, to);
    return { saved, mode: 'incremental', analyzeFrom: incrementalFrom };
  }

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

    const bars = await this.dnseService.fetchOhlc(ticker, fromDate, toDate);
    return bars.sort((a, b) => a.tradingDate.localeCompare(b.tradingDate));
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

  /** Khung được phép cho GET intraday-index (Entrade; 4H = gộp từ 1H trên server). */
  private static readonly INDEX_CHART_RESOLUTIONS = new Set([
    '5',
    '15',
    '1H',
    '4H',
    '1D',
  ]);

  /**
   * Nến chỉ số VN30/VNINDEX — Entrade: 5m, 15m, 1H, 4H (gộp 1H), 1D. Không lưu DB.
   */
  async fetchIntradayIndexOhlc(
    ticker: string,
    resolution?: string,
    from?: string,
    to?: string,
    noCache = false,
  ): Promise<IntradayIndexBarDto[]> {
    const upper = ticker.toUpperCase();
    if (!isMarketIndexTicker(upper)) {
      throw new BadRequestException(
        'intraday-index chỉ hỗ trợ VNINDEX hoặc VN30',
      );
    }
    const raw = (resolution || '5').trim();
    const resU = raw.toUpperCase();
    const res = StockService.INDEX_CHART_RESOLUTIONS.has(resU) ? resU : '5';

    const toD = to ? new Date(to) : new Date();
    /** Khi client không gửi `from`, mặc định ~1 tháng — khớp chart phái sinh / đồng bộ windowDays=31. */
    let defaultDays = 31;
    if (res === '1H') defaultDays = 45;
    else if (res === '4H') defaultDays = 120;
    else if (res === '1D') defaultDays = 800;

    const fromD = from
      ? new Date(from)
      : new Date(toD.getTime() - defaultDays * 24 * 60 * 60 * 1000);
    const cacheKey = this.intradayCacheKey(upper, res, fromD, toD);
    if (!noCache) {
      const cached = await this.readIntradayCache(cacheKey);
      if (cached) return cached;
    }
    const fresh = await this.dnseService.fetchIntradayIndexOhlc(
      upper,
      res,
      fromD,
      toD,
    );
    if (!noCache) {
      await this.writeIntradayCache(cacheKey, fresh, toD);
    }
    return fresh;
  }

  /**
   * Nến HĐTL phái sinh VN30F1M / VN30F2M (giá & volume của chính hợp đồng, không phải chỉ số VN30).
   * Cùng cơ chế cache như intraday index; validate ticker phái sinh trước khi gọi DNSE.
   *
   * `includeForming`: CHỈ dùng cho route chart (`StockController`). Lời gọi nội bộ từ
   * `DerivativesService.fetchRecentFiveMinuteBars` KHÔNG được truyền true — decision-making phải
   * luôn dựa trên nến đã đóng (xem ghi chú an toàn trong `DnseService.fetchIntradayDerivativeOhlc`).
   */
  async fetchIntradayDerivativeOhlc(
    ticker: string,
    resolution?: string,
    from?: string,
    to?: string,
    noCache = false,
    includeForming = false,
  ): Promise<IntradayIndexBarDto[]> {
    const upper = ticker.toUpperCase();
    if (!isDerivativeTicker(upper)) {
      throw new BadRequestException(
        'intraday-derivative chỉ hỗ trợ VN30F1M hoặc VN30F2M',
      );
    }
    const raw = (resolution || '5').trim();
    const resU = raw.toUpperCase();
    const res = StockService.INDEX_CHART_RESOLUTIONS.has(resU) ? resU : '5';

    const toD = to ? new Date(to) : new Date();
    let defaultDays = 31;
    if (res === '1H') defaultDays = 45;
    else if (res === '4H') defaultDays = 120;
    else if (res === '1D') defaultDays = 800;

    const fromD = from
      ? new Date(from)
      : new Date(toD.getTime() - defaultDays * 24 * 60 * 60 * 1000);
    // Namespace cache riêng khi includeForming — nến sống đổi liên tục, không được lẫn với cache
    // "chỉ đóng" (TTL 90s vẫn đủ ngắn để không thấy dữ liệu forming cũ trôi nổi lâu).
    const cacheKey =
      this.intradayCacheKey(upper, res, fromD, toD) +
      (includeForming ? ':forming' : '');
    if (!noCache) {
      const cached = await this.readIntradayCache(cacheKey);
      if (cached) return cached;
    }
    const fresh = await this.dnseService.fetchIntradayDerivativeOhlc(
      upper,
      res,
      fromD,
      toD,
      includeForming,
    );
    if (!noCache) {
      await this.writeIntradayCache(cacheKey, fresh, toD);
    }
    return fresh;
  }

  private intradayCacheKey(
    ticker: string,
    resolution: string,
    from: Date,
    to: Date,
  ): string {
    return `intraday:index:${ticker}:${resolution}:${this.bucketIso(from)}:${this.bucketIso(to)}`;
  }

  private bucketIso(d: Date): string {
    const ms = d.getTime();
    if (!Number.isFinite(ms)) return 'invalid';
    const minuteBucket = Math.floor(ms / 60000) * 60000;
    return new Date(minuteBucket).toISOString();
  }

  private intradayCacheTtlSeconds(to: Date): number {
    const ageMs = Date.now() - to.getTime();
    if (ageMs > 2 * 24 * 60 * 60 * 1000) return 12 * 60 * 60;
    if (ageMs > 12 * 60 * 60 * 1000) return 60 * 60;
    return 90;
  }

  private async readIntradayCache(
    key: string,
  ): Promise<IntradayIndexBarDto[] | null> {
    if (!this.intradayCacheEnabled || !this.redisClient) return null;
    try {
      if (this.redisClient.status === 'wait') await this.redisClient.connect();
      const raw = await this.redisClient.get(key);
      if (!raw) return null;
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as IntradayIndexBarDto[]) : null;
    } catch (e) {
      this.logger.debug(
        `Redis intraday cache miss/error (${key}): ${(e as Error).message}`,
      );
      return null;
    }
  }

  private async writeIntradayCache(
    key: string,
    bars: IntradayIndexBarDto[],
    to: Date,
  ): Promise<void> {
    if (!this.intradayCacheEnabled || !this.redisClient || !bars?.length)
      return;
    try {
      if (this.redisClient.status === 'wait') await this.redisClient.connect();
      await this.redisClient.set(
        key,
        JSON.stringify(bars),
        'EX',
        this.intradayCacheTtlSeconds(to),
      );
    } catch (e) {
      this.logger.debug(
        `Redis intraday cache write fail (${key}): ${(e as Error).message}`,
      );
    }
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
   * Đồng bộ nến **ngày** trong cửa sổ lịch [to − calendarDays, to] (vd. 31 ≈ một tháng).
   * Dùng cho VN30 / tham chiếu phái sinh: bổ sung DB không cần full IPO.
   */
  async syncHistoryCalendarWindow(
    ticker: string,
    calendarDays: number,
    toYmd?: string,
  ): Promise<{ saved: number; from: string; to: string }> {
    const t = ticker.toUpperCase();
    const to = toYmd ?? vnCalendarTodayYmd();
    const d = Math.min(Math.max(Math.floor(calendarDays), 1), 400);
    const from = this.subtractCalendarDays(to, d);
    this.logger.log(`${t}: sync cửa sổ lịch ${from} → ${to} (${d} ngày)`);
    const saved = await this.syncHistory(t, from, to);
    return { saved, from, to };
  }

  /**
   * Cron trong phiên: chỉ fetch nến **ngày giao dịch VN hiện tại** (không overlap 7 ngày).
   * Dùng `ON DUPLICATE KEY UPDATE` để cập nhật OHLC/KL khi nến ngày đã có trong DB.
   * Điều chỉnh cổ tức / sync đầy đủ vẫn do `syncHistorySmart` (vd. 15:30).
   */
  async syncIntradaySessionBar(
    ticker: string,
    to?: string,
  ): Promise<{ saved: number }> {
    const t = ticker.toUpperCase();
    const today = vnCalendarTodayYmd();
    const bars = await this.fetchHistory(t, today, to);
    const saved = await this.persistPriceBarsUpsert(t, bars);
    return { saved };
  }

  /**
   * Sync full IPO → nay: **xóa toàn bộ nến local** rồi tải lại từ DNSE (từ mốc sớm → `to`).
   * Trước đây dùng INSERT IGNORE trên dữ liệu cũ — các phiên đã có không được ghi đè, nên “full” trông như sync nông.
   */
  async syncHistoryFull(ticker: string, to?: string): Promise<number> {
    const t = ticker.toUpperCase();
    const toLabel = to ?? 'nay';
    this.logger.log(
      `Syncing FULL history for ${t} (xóa DB → từ ${DNSE_EARLIEST_FROM.toISOString().slice(0, 10)} → ${toLabel})...`,
    );
    await this.deleteAllPricesForTicker(t);
    const bars = await this.fetchFullHistory(t, to);
    const saved = await this.persistPriceBars(t, bars);
    return saved;
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

  /** Ghi / cập nhật nến (khớp UNIQUE ticker+tradingDate) — dùng trong phiên. */
  private async persistPriceBarsUpsert(
    ticker: string,
    bars: StockPriceResponseDto[],
  ): Promise<number> {
    if (!bars.length) return 0;

    const COLS =
      '(`ticker`, `tradingDate`, `open`, `high`, `low`, `close`, `volume`, `foreignBuyVolume`, `foreignSellVolume`)';
    let touched = 0;

    for (const b of bars) {
      const params = [
        b.ticker,
        b.tradingDate,
        b.open,
        b.high,
        b.low,
        b.close,
        b.volume,
        b.foreignBuyVolume,
        b.foreignSellVolume,
      ];
      await this.stockPriceRepo.query(
        `INSERT INTO stock_prices ${COLS} VALUES (?,?,?,?,?,?,?,?,?)
         ON DUPLICATE KEY UPDATE
           \`open\`=VALUES(\`open\`),
           \`high\`=VALUES(\`high\`),
           \`low\`=VALUES(\`low\`),
           \`close\`=VALUES(\`close\`),
           \`volume\`=VALUES(\`volume\`),
           \`foreignBuyVolume\`=VALUES(\`foreignBuyVolume\`),
           \`foreignSellVolume\`=VALUES(\`foreignSellVolume\`)`,
        params,
      );
      touched++;
    }

    this.logger.debug(`Intraday upsert ${touched} nến cho ${ticker}`);
    return touched;
  }

  // Kiểm tra biến động so với phiên trước và gửi cảnh báo Telegram
  async checkAndAlert(
    ticker: string,
    threshold = 3,
    forceNotify = false,
  ): Promise<void> {
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
      const direction = changePercent >= 0 ? 'up' : 'down';
      if (
        !this.telegramNotifyPolicy.shouldSend({
          type: 'stock_alert',
          force: forceNotify,
          ticker: ticker.toUpperCase(),
          dedupeKey: `${ticker.toUpperCase()}|${vnCalendarTodayYmd()}|${threshold}|${direction}`,
        })
      ) {
        return;
      }
      const directionLabel = changePercent >= 0 ? '🟢 Tăng' : '🔴 Giảm';
      const fmt = (n: number) =>
        (n / 1000).toLocaleString('vi-VN', { maximumFractionDigits: 1 }) + 'k';
      await this.telegramService.sendStockAlert(
        ticker,
        `${directionLabel} <b>${Math.abs(changePercent).toFixed(2)}%</b>\n` +
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
    opts?: { limit?: number; before?: string },
  ): Promise<StockPrice[]> {
    const qb = this.stockPriceRepo
      .createQueryBuilder('sp')
      .where('sp.ticker = :ticker', { ticker: ticker.toUpperCase() })
      .orderBy('sp.tradingDate', 'DESC');

    if (from) qb.andWhere('sp.tradingDate >= :from', { from });
    if (to) qb.andWhere('sp.tradingDate <= :to', { to });
    if (opts?.before)
      qb.andWhere('sp.tradingDate < :before', { before: opts.before });

    const lim = opts?.limit;
    if (lim != null && lim > 0) qb.take(Math.min(lim, 5000));

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
