import { Injectable } from '@nestjs/common';
import { DnseService } from '../stock/dnse.service';
import {
  BacktestFlags,
  BacktestResult,
  Bar,
  MIN_BARS,
  buildSeries,
  runBacktest,
  vnDate,
} from './vn30-backtest-core'

@Injectable()
export class Vn30BacktestService {
  constructor(private readonly dnse: DnseService) {}

  async runCompare(
    from: Date,
    to: Date,
    flags: { trailing: boolean; rsicap: boolean },
  ): Promise<BacktestResult> {
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
      return {
        from: bars[0] ? vnDate(bars[0].time) : from.toISOString().slice(0, 10),
        to: bars[0]
          ? vnDate(bars[bars.length - 1].time)
          : to.toISOString().slice(0, 10),
        bars: bars.length,
        series: [],
      };
    }

    const base: Omit<BacktestFlags, 'long'> = {
      ema50: false,
      trailing: flags.trailing,
      rsicap: flags.rsicap,
    };

    const normalTrades = runBacktest(bars, { ...base, long: 'normal' });
    const tightTrades = runBacktest(bars, { ...base, long: 'tight' });
    const offTrades = runBacktest(bars, { ...base, long: 'off' });

    return {
      from: vnDate(bars[0].time),
      to: vnDate(bars[bars.length - 1].time),
      bars: bars.length,
      series: [
        buildSeries('LONG bình thường (4/5)', '#3b82f6', normalTrades),
        buildSeries('LONG siết (5/5, RSI 58-72)', '#10b981', tightTrades),
        buildSeries('SHORT only (tắt LONG)', '#f59e0b', offTrades),
      ],
    };
  }
}
