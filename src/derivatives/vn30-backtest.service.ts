import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { DnseService } from '../stock/dnse.service';
import {
  BacktestFlags,
  BacktestResult,
  Bar,
  MIN_BARS,
  buildSeries,
  runBacktest,
  vnDate,
} from './vn30-backtest-core';

export type BacktestParams = {
  from: string; // YYYY-MM-DD
  to: string;
  trailing: boolean;
  rsicap: boolean;
};

@Injectable()
export class Vn30BacktestService implements OnModuleDestroy {
  private readonly logger = new Logger(Vn30BacktestService.name);
  private readonly redisClient: Redis | null;
  private readonly cacheEnabled: boolean;

  constructor(
    private readonly dnse: DnseService,
    private readonly config: ConfigService,
  ) {
    const host = this.config.get<string>('REDIS_HOST', '').trim();
    const port = Number(this.config.get<number>('REDIS_PORT', 6379));
    if (!host || !Number.isFinite(port) || port <= 0) {
      this.redisClient = null;
      this.cacheEnabled = false;
      return;
    }
    this.redisClient = new Redis({
      host,
      port,
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
    });
    this.cacheEnabled = true;
  }

  async onModuleDestroy() {
    if (!this.redisClient) return;
    try {
      await this.redisClient.quit();
    } catch {
      this.redisClient.disconnect();
    }
  }

  // ── Cache helpers ───────────────────────────────────────────────────────────

  private endOfMonthYmd(d: Date): string {
    const last = new Date(d.getFullYear(), d.getMonth() + 1, 0);
    const y = last.getFullYear();
    const m = String(last.getMonth() + 1).padStart(2, '0');
    const day = String(last.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  private startOfMonthYmd(d: Date): string {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    return `${y}-${m}-01`;
  }

  cacheKey(params: BacktestParams): string {
    const from = new Date(params.from + 'T00:00:00');
    const to = new Date(params.to + 'T23:59:59');
    return [
      'backtest:vn30:v2',
      this.startOfMonthYmd(from),
      this.endOfMonthYmd(to),
      params.trailing ? 'trail-on' : 'trail-off',
      params.rsicap ? 'rsi-on' : 'rsi-off',
    ].join(':');
  }

  private cacheTtlSeconds(): number {
    return 15 * 24 * 60 * 60;
  }

  private async redisConnect(): Promise<Redis | null> {
    if (!this.cacheEnabled || !this.redisClient) return null;
    try {
      if (this.redisClient.status === 'wait') await this.redisClient.connect();
      return this.redisClient;
    } catch {
      return null;
    }
  }

  async getCached(key: string): Promise<BacktestResult | null> {
    const redis = await this.redisConnect();
    if (!redis) return null;
    try {
      const raw = await redis.get(key);
      if (!raw) return null;
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return null;
      return parsed as BacktestResult;
    } catch (e) {
      this.logger.debug(`Cache miss (${key}): ${(e as Error).message}`);
      return null;
    }
  }

  private async setCached(key: string, data: BacktestResult): Promise<void> {
    const redis = await this.redisConnect();
    if (!redis) return;
    try {
      await redis.set(key, JSON.stringify(data), 'EX', this.cacheTtlSeconds());
    } catch (e) {
      this.logger.debug(`Cache write fail (${key}): ${(e as Error).message}`);
    }
  }

  // ── Computation (chạy trong job queue) ─────────────────────────────────────

  async computeAndCache(params: BacktestParams): Promise<BacktestResult> {
    const from = new Date(params.from + 'T00:00:00');
    const to = new Date(params.to + 'T23:59:59');
    const key = this.cacheKey(params);

    this.logger.log(
      `Backtest VN30 bắt đầu: ${params.from} → ${params.to} (trailing=${params.trailing}, rsicap=${params.rsicap})`,
    );

    const raw = await this.dnse.fetchIntradayIndexOhlc('VN30', '5', from, to);
    const bars: Bar[] = raw.map((b) => ({
      time: b.time,
      o: b.open,
      h: b.high,
      l: b.low,
      c: b.close,
      v: b.volume ?? 0,
    }));

    if (bars.length < MIN_BARS) {
      const result: BacktestResult = {
        from: bars[0] ? vnDate(bars[0].time) : params.from,
        to: bars[0] ? vnDate(bars[bars.length - 1].time) : params.to,
        bars: bars.length,
        series: [],
      };
      await this.setCached(key, result);
      return result;
    }

    const base: Omit<BacktestFlags, 'long'> = {
      ema50: false,
      trailing: params.trailing,
      rsicap: params.rsicap,
      short: 'normal',
      session: 'all',
      minAtr: 1.5,
    };

    // Chạy tuần tự để không tranh nhau CPU — mỗi series yield mỗi 200 bar
    const normalTrades   = await runBacktest(bars, { ...base, long: 'normal' });
    const tightTrades    = await runBacktest(bars, { ...base, long: 'tight' });
    const shortOnlyTrades = await runBacktest(bars, { ...base, long: 'off' });
    const longOnlyTrades  = await runBacktest(bars, { ...base, long: 'normal', short: 'off' });
    const morningTrades   = await runBacktest(bars, { ...base, long: 'normal', session: 'morning' });
    const highAtrTrades   = await runBacktest(bars, { ...base, long: 'normal', minAtr: 3 });

    const result: BacktestResult = {
      from: vnDate(bars[0].time),
      to: vnDate(bars[bars.length - 1].time),
      bars: bars.length,
      series: [
        buildSeries('LONG bình thường (4/5)', 'LONG',      '#3b82f6', normalTrades),
        buildSeries('LONG siết (5/5, RSI 58-72)', 'LONG siết', '#10b981', tightTrades),
        buildSeries('SHORT only (tắt LONG)',  'SHORT',     '#f59e0b', shortOnlyTrades),
        buildSeries('LONG only (tắt SHORT)',  'LONG only', '#a78bfa', longOnlyTrades),
        buildSeries('Sáng only (<11:30)',     'Sáng',      '#fb923c', morningTrades),
        buildSeries('ATR cao (≥3đ)',          'ATR≥3',     '#e879f9', highAtrTrades),
      ],
    };

    await this.setCached(key, result);
    this.logger.log(
      `Backtest VN30 xong: ${bars.length} nến, ${result.series.reduce((a, s) => a + s.stats.trades, 0)} lệnh tổng`,
    );
    return result;
  }
}
