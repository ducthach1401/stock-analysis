/**
 * Logic backtest VN30 5m — dùng chung cho script CLI và Vn30BacktestService.
 * Chỉ chứa hàm thuần (pure), không import NestJS / không side-effect.
 */
import { isVnFuturesSessionOpen } from '../common/vn-trading-days';

// ── Constants ──────────────────────────────────────────────────────────────
export const MIN_BARS = 60;
export const ATR_PERIOD = 14;
export const RISK_ATR_MULT = 1.2;
export const REWARD_ATR_MULT = 2;
export const MIN_ATR_POINTS = 1.5;
export const NO_TRADE_AFTER_HHMM = 1415;
export const MAX_DAILY_LOSSES = 2;
export const RSI_MAX_LONG = 75;
export const RSI_MIN_SHORT = 25;
export const RSI_MIN_LONG_TIGHT = 58;
export const RSI_MAX_LONG_TIGHT = 72;
export const BREAKEVEN_TRIGGER_R = 1;
export const TRAIL_AFTER_R = 1;
export const SETTLE_AFTER_BARS = 12;
export const LOOKBACK_BARS = 120;

// ── Types ──────────────────────────────────────────────────────────────────
export type Bar = {
  time: number; // unix seconds
  o: number; // raw * 1000
  h: number;
  l: number;
  c: number;
  v: number;
};

export type LongMode = 'normal' | 'tight' | 'off';

export type BacktestFlags = {
  ema50: boolean;
  trailing: boolean;
  rsicap: boolean;
  long: LongMode;
};

export type Trade = {
  side: 'LONG' | 'SHORT';
  entry: number;
  pnl: number;
  rsi: number | null;
  outcome: 'WIN' | 'LOSS' | 'NEUTRAL';
  date: string;
};

export type BacktestSeriesStats = {
  trades: number;
  wins: number;
  losses: number;
  neutrals: number;
  wr: number;
  net: number;
  pf: number | null;
  exp: number;
  longTrades: number;
  longNet: number;
  shortTrades: number;
  shortNet: number;
};

export type BacktestSeries = {
  label: string;
  color: string;
  stats: BacktestSeriesStats;
  equity: { date: string; value: number }[];
  monthly: { month: string; net: number; longNet: number; shortNet: number }[];
};

export type BacktestResult = {
  from: string;
  to: string;
  bars: number;
  series: BacktestSeries[];
};

// ── Date helpers (memoized — module-level cache) ───────────────────────────
const _dateFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Ho_Chi_Minh',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
const _hhmmFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Asia/Ho_Chi_Minh',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});
const _dateCache = new Map<number, string>();
const _hhmmCache = new Map<number, number>();

export function vnDate(unixSec: number): string {
  let v = _dateCache.get(unixSec);
  if (v === undefined) {
    v = _dateFmt.format(new Date(unixSec * 1000));
    _dateCache.set(unixSec, v);
  }
  return v;
}

export function vnHhmm(unixSec: number): number {
  let v = _hhmmCache.get(unixSec);
  if (v === undefined) {
    v = parseInt(
      _hhmmFmt.format(new Date(unixSec * 1000)).replace(':', ''),
      10,
    );
    _hhmmCache.set(unixSec, v);
  }
  return v;
}

// ── Indicators ─────────────────────────────────────────────────────────────
const toPrice = (v: number) => v / 1000;
const r2 = (v: number) => Math.round((v + Number.EPSILON) * 100) / 100;

export function calcEma(values: number[], period: number): number[] {
  if (!values.length) return [];
  const k = 2 / (period + 1);
  const seed = Math.min(period, values.length);
  const out = new Array<number>(values.length);
  let sum = 0;
  for (let i = 0; i < seed; i++) {
    sum += values[i];
    out[i] = sum / (i + 1);
  }
  for (let i = seed; i < values.length; i++) {
    out[i] = values[i] * k + out[i - 1] * (1 - k);
  }
  return out;
}

export function calcRsi(
  values: number[],
  period: number,
): Array<number | null> {
  const out = new Array<number | null>(values.length).fill(null);
  if (values.length <= period) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = values[i] - values[i - 1];
    if (d >= 0) gain += d;
    else loss -= d;
  }
  let ag = gain / period;
  let al = loss / period;
  const rsiVal = (g: number, l: number) =>
    l === 0 ? 100 : 100 - 100 / (1 + g / l);
  out[period] = rsiVal(ag, al);
  for (let i = period + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    ag = (ag * (period - 1) + Math.max(d, 0)) / period;
    al = (al * (period - 1) + Math.max(-d, 0)) / period;
    out[i] = rsiVal(ag, al);
  }
  return out;
}

export function calcAtr(bars: Bar[], period: number): Array<number | null> {
  const out = new Array<number | null>(bars.length).fill(null);
  if (bars.length <= period) return out;
  const tr: number[] = [];
  for (let i = 0; i < bars.length; i++) {
    const high = toPrice(bars[i].h);
    const low = toPrice(bars[i].l);
    const pc = i > 0 ? toPrice(bars[i - 1].c) : high;
    tr.push(Math.max(high - low, Math.abs(high - pc), Math.abs(low - pc)));
  }
  let avg = tr.slice(1, period + 1).reduce((a, b) => a + b, 0) / period;
  out[period] = avg;
  for (let i = period + 1; i < tr.length; i++) {
    avg = (avg * (period - 1) + tr[i]) / period;
    out[i] = avg;
  }
  return out;
}

type Snap = {
  close: number;
  ema9: number;
  ema21: number;
  ema50: number;
  emaSlope: number;
  rsi14: number | null;
  atr14: number | null;
  vwap: number;
  prevHigh12: number;
  prevLow12: number;
};

export function snapshotAt(bars: Bar[]): Snap {
  const closes = bars.map((b) => toPrice(b.c));
  const e9 = calcEma(closes, 9),
    e21 = calcEma(closes, 21),
    e50 = calcEma(closes, 50);
  const r = calcRsi(closes, 14),
    a = calcAtr(bars, ATR_PERIOD);
  const i = bars.length - 1;
  const ymd = vnDate(bars[i].time);
  const day = bars.filter((b) => vnDate(b.time) === ymd);
  let pv = 0,
    vol = 0;
  for (const b of day) {
    const v = b.v || 0;
    pv += ((toPrice(b.h) + toPrice(b.l) + toPrice(b.c)) / 3) * v;
    vol += v;
  }
  const vwap = vol > 0 ? pv / vol : closes[i];
  const prior = bars.slice(Math.max(0, i - 12), i);
  return {
    close: closes[i],
    ema9: e9[i],
    ema21: e21[i],
    ema50: e50[i],
    emaSlope: e9[i] - e9[Math.max(0, i - 5)],
    rsi14: r[i],
    atr14: a[i],
    vwap,
    prevHigh12: prior.length
      ? Math.max(...prior.map((b) => toPrice(b.h)))
      : toPrice(bars[i].h),
    prevLow12: prior.length
      ? Math.min(...prior.map((b) => toPrice(b.l)))
      : toPrice(bars[i].l),
  };
}

export function decide(s: Snap, f: BacktestFlags): 'LONG' | 'SHORT' | null {
  if (s.atr14 == null || s.atr14 < MIN_ATR_POINTS) return null;

  const rsiForLong =
    f.long === 'tight'
      ? s.rsi14 != null &&
        s.rsi14 >= RSI_MIN_LONG_TIGHT &&
        s.rsi14 <= RSI_MAX_LONG_TIGHT
      : s.rsi14 != null &&
        s.rsi14 >= 50 &&
        (!f.rsicap || s.rsi14 <= RSI_MAX_LONG);

  const longChecks = [
    s.close > s.vwap,
    s.ema9 > s.ema21,
    s.emaSlope > 0,
    rsiForLong,
    s.close > s.prevHigh12,
  ];
  const shortChecks = [
    s.close < s.vwap,
    s.ema9 < s.ema21,
    s.emaSlope < 0,
    s.rsi14 != null && s.rsi14 <= 50 && (!f.rsicap || s.rsi14 >= RSI_MIN_SHORT),
    s.close < s.prevLow12,
  ];
  if (f.ema50) {
    longChecks.push(s.close > s.ema50);
    shortChecks.push(s.close < s.ema50);
  }
  const longNeed =
    f.long === 'tight' ? longChecks.length : longChecks.length - 1;
  const shortNeed = shortChecks.length - 1;
  const ls = f.long !== 'off' ? longChecks.filter(Boolean).length : 0;
  const ss = shortChecks.filter(Boolean).length;
  if (ls >= longNeed && ls > ss) return 'LONG';
  if (ss >= shortNeed && ss > ls) return 'SHORT';
  return null;
}

export function settle(
  bars: Bar[],
  startIdx: number,
  side: 'LONG' | 'SHORT',
  entry: number,
  atr14: number,
  f: BacktestFlags,
): { pnl: number; outcome: Trade['outcome']; exitIdx: number } {
  const isLong = side === 'LONG';
  const risk = RISK_ATR_MULT * atr14;
  const tp = isLong
    ? entry + REWARD_ATR_MULT * atr14
    : entry - REWARD_ATR_MULT * atr14;
  let trailStop = isLong ? entry - risk : entry + risk;
  let movedBE = false;
  let exitPrice: number | null = null;
  let exitIdx = startIdx;
  const last = Math.min(bars.length - 1, startIdx + SETTLE_AFTER_BARS);
  for (let i = startIdx + 1; i <= bars.length - 1; i++) {
    const high = toPrice(bars[i].h),
      low = toPrice(bars[i].l);
    exitIdx = i;
    if (isLong) {
      if (low <= trailStop) {
        exitPrice = trailStop;
        break;
      }
      if (high >= tp) {
        exitPrice = tp;
        break;
      }
      const fav = high - entry;
      if (f.trailing && !movedBE && fav >= BREAKEVEN_TRIGGER_R * risk) {
        trailStop = Math.max(trailStop, entry);
        movedBE = true;
      }
      if (f.trailing && fav >= (TRAIL_AFTER_R + 1) * risk)
        trailStop = Math.max(trailStop, high - TRAIL_AFTER_R * risk);
    } else {
      if (high >= trailStop) {
        exitPrice = trailStop;
        break;
      }
      if (low <= tp) {
        exitPrice = tp;
        break;
      }
      const fav = entry - low;
      if (f.trailing && !movedBE && fav >= BREAKEVEN_TRIGGER_R * risk) {
        trailStop = Math.min(trailStop, entry);
        movedBE = true;
      }
      if (f.trailing && fav >= (TRAIL_AFTER_R + 1) * risk)
        trailStop = Math.min(trailStop, low + TRAIL_AFTER_R * risk);
    }
    if (i >= last) {
      exitPrice = toPrice(bars[i].c);
      break;
    }
  }
  if (exitPrice == null) exitPrice = toPrice(bars[exitIdx].c);
  const pnl = isLong ? exitPrice - entry : entry - exitPrice;
  const outcome: Trade['outcome'] =
    pnl > 0.01 ? 'WIN' : pnl < -0.01 ? 'LOSS' : 'NEUTRAL';
  return { pnl, outcome, exitIdx };
}

export function runBacktest(bars: Bar[], f: BacktestFlags): Trade[] {
  const trades: Trade[] = [];
  const lossesByDay = new Map<string, number>();
  let i = MIN_BARS - 1;
  while (i < bars.length) {
    const window = bars.slice(Math.max(0, i + 1 - LOOKBACK_BARS), i + 1);
    const day = vnDate(bars[i].time);
    const inSession = isVnFuturesSessionOpen(new Date(bars[i].time * 1000));
    const late = vnHhmm(bars[i].time) >= NO_TRADE_AFTER_HHMM;
    const dayLosses = lossesByDay.get(day) ?? 0;
    if (!inSession || late || dayLosses >= MAX_DAILY_LOSSES) {
      i++;
      continue;
    }
    const s = snapshotAt(window);
    const side = decide(s, f);
    if (!side || s.atr14 == null) {
      i++;
      continue;
    }
    const entry = s.close;
    const res = settle(bars, i, side, entry, s.atr14, f);
    trades.push({
      side,
      entry,
      pnl: res.pnl,
      rsi: s.rsi14,
      outcome: res.outcome,
      date: day,
    });
    if (res.outcome === 'LOSS') lossesByDay.set(day, dayLosses + 1);
    i = res.exitIdx + 1;
  }
  return trades;
}

export function buildSeries(
  label: string,
  color: string,
  trades: Trade[],
): BacktestSeries {
  const wins = trades.filter((t) => t.outcome === 'WIN').length;
  const losses = trades.filter((t) => t.outcome === 'LOSS').length;
  const neutrals = trades.filter((t) => t.outcome === 'NEUTRAL').length;
  const decided = wins + losses;
  const net = r2(trades.reduce((a, t) => a + t.pnl, 0));
  const gp = trades.filter((t) => t.pnl > 0).reduce((a, t) => a + t.pnl, 0);
  const gl = trades.filter((t) => t.pnl < 0).reduce((a, t) => a + t.pnl, 0);
  const longTrades = trades.filter((t) => t.side === 'LONG');
  const shortTrades = trades.filter((t) => t.side === 'SHORT');

  // Equity curve (cumulative after each trade, keyed to trade date)
  let cum = 0;
  const equity: BacktestSeries['equity'] = trades.map((t) => {
    cum += t.pnl;
    return { date: t.date, value: r2(cum) };
  });

  // Monthly aggregation
  const monthMap = new Map<
    string,
    { net: number; longNet: number; shortNet: number }
  >();
  for (const t of trades) {
    const m = t.date.slice(0, 7);
    const e = monthMap.get(m) ?? { net: 0, longNet: 0, shortNet: 0 };
    e.net += t.pnl;
    if (t.side === 'LONG') e.longNet += t.pnl;
    else e.shortNet += t.pnl;
    monthMap.set(m, e);
  }
  const monthly = [...monthMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, v]) => ({
      month,
      net: r2(v.net),
      longNet: r2(v.longNet),
      shortNet: r2(v.shortNet),
    }));

  return {
    label,
    color,
    stats: {
      trades: trades.length,
      wins,
      losses,
      neutrals,
      wr: decided ? r2((wins / decided) * 100) : 0,
      net,
      pf: gl !== 0 ? r2(gp / Math.abs(gl)) : null,
      exp: trades.length ? r2(net / trades.length) : 0,
      longTrades: longTrades.length,
      longNet: r2(longTrades.reduce((a, t) => a + t.pnl, 0)),
      shortTrades: shortTrades.length,
      shortNet: r2(shortTrades.reduce((a, t) => a + t.pnl, 0)),
    },
    equity,
    monthly,
  };
}
