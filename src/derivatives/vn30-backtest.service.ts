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

  private backtestCacheKey(
    from: Date,
    to: Date,
    flags: { trailing: boolean; rsicap: boolean },
  ): string {
    return [
      'backtest:vn30:v2',
      this.startOfMonthYmd(from),
      this.endOfMonthYmd(to),
      flags.trailing ? 'trail-on' : 'trail-off',
      flags.rsicap ? 'rsi-on' : 'rsi-off',
    ].join(':');
  }

  private backtestCacheTtlSeconds(): number {
    return 15 * 24 * 60 * 60;
  }

  private async readBacktestCache(key: string): Promise<BacktestResult | null> {
    if (!this.cacheEnabled || !this.redisClient) return null;
    try {
      if (this.redisClient.status === 'wait') await this.redisClient.connect();
      const raw = await this.redisClient.get(key);
      if (!raw) return null;
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return null;
      return parsed as BacktestResult;
    } catch (e) {
      this.logger.debug(
        `Redis backtest cache miss/error (${key}): ${(e as Error).message}`,
      );
      return null;
    }
  }

  private async writeBacktestCache(
    key: string,
    data: BacktestResult,
  ): Promise<void> {
    if (!this.cacheEnabled || !this.redisClient) return;
    try {
      if (this.redisClient.status === 'wait') await this.redisClient.connect();
      await this.redisClient.set(
        key,
        JSON.stringify(data),
        'EX',
        this.backtestCacheTtlSeconds(),
      );
    } catch (e) {
      this.logger.debug(
        `Redis backtest cache write fail (${key}): ${(e as Error).message}`,
      );
    }
  }

  async runCompare(
    from: Date,
    to: Date,
    flags: { trailing: boolean; rsicap: boolean; forceRefresh?: boolean },
  ): Promise<BacktestResult> {
    const cacheKey = this.backtestCacheKey(from, to, flags);
    if (!flags.forceRefresh) {
      const cached = await this.readBacktestCache(cacheKey);
      if (cached) return cached;
    }

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
        from: bars[0] ? vnDate(bars[0].time) : from.toISOString().slice(0, 10),
        to: bars[0]
          ? vnDate(bars[bars.length - 1].time)
          : to.toISOString().slice(0, 10),
        bars: bars.length,
        series: [],
      };
      await this.writeBacktestCache(cacheKey, result);
      return result;
    }

    const base: Omit<BacktestFlags, 'long'> = {
      ema50: false,
      trailing: flags.trailing,
      rsicap: flags.rsicap,
    };

    const normalTrades = runBacktest(bars, { ...base, long: 'normal' });
    const tightTrades = runBacktest(bars, { ...base, long: 'tight' });
    const offTrades = runBacktest(bars, { ...base, long: 'off' });

    const result: BacktestResult = {
      from: vnDate(bars[0].time),
      to: vnDate(bars[bars.length - 1].time),
      bars: bars.length,
      series: [
        buildSeries('LONG bình thường (4/5)', '#3b82f6', normalTrades),
        buildSeries('LONG siết (5/5, RSI 58-72)', '#10b981', tightTrades),
        buildSeries('SHORT only (tắt LONG)', '#f59e0b', offTrades),
      ],
    };
    await this.writeBacktestCache(cacheKey, result);
    return result;
  }
}
