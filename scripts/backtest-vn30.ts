/* eslint-disable no-console */
/**
 * Backtest VN30 5m — chạy lại chuỗi giá lịch sử qua logic thuật toán V3 (offline).
 *
 * Chạy:
 *   yarn backtest:vn30 [--from=YYYY-MM-DD] [--to=YYYY-MM-DD]
 *                      [--ema50=off] [--trailing=off] [--rsicap=off]
 *
 * Mục đích: đo expectancy/PF của V3 và TÁCH đóng góp của từng cải tiến
 * (bộ lọc EMA50, trailing stop, trần RSI) trên CÙNG dữ liệu — tránh phán đoán cảm tính.
 *
 * Lưu ý trung thực: đây là backtest xấp xỉ — vào lệnh 1 lần/nến đã đóng (không phải
 * mỗi phút như bot live), fill tại close/SL/TP theo high-low nến, không tính phí/slippage.
 * Dùng để so sánh TƯƠNG ĐỐI giữa các biến thể, không phải P/L tuyệt đối ngoài đời.
 */
import axios from 'axios';
import { isVnFuturesSessionOpen } from '../src/common/vn-trading-days';

const DNSE_CHART_INDEX =
  'https://services.entrade.com.vn/chart-api/v2/ohlcs/index';

// ── Tham số thuật toán (đồng bộ với derivatives.service.ts V3) ──
const MIN_BARS = 60;
const ATR_PERIOD = 14;
const RISK_ATR_MULT = 1.2;
const REWARD_ATR_MULT = 2;
const MIN_ATR_POINTS = 1.5;
const NO_TRADE_AFTER_HHMM = 1415;
const MAX_DAILY_LOSSES = 2;
const RSI_MAX_LONG = 75;
const RSI_MIN_SHORT = 25;
const BREAKEVEN_TRIGGER_R = 1;
const TRAIL_AFTER_R = 1;
const SETTLE_AFTER_BARS = 12;

type Bar = {
  time: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
};
type Flags = { ema50: boolean; trailing: boolean; rsicap: boolean };

const price = (v: number) => v / 1000;
const r2 = (v: number) => Math.round((v + Number.EPSILON) * 100) / 100;
const signed = (v: number) => (v > 0 ? `+${r2(v)}` : `${r2(v)}`);

function vnDate(unixSec: number): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Ho_Chi_Minh',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(unixSec * 1000));
}
function vnHhmm(unixSec: number): number {
  return parseInt(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Ho_Chi_Minh',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    })
      .format(new Date(unixSec * 1000))
      .replace(':', ''),
    10,
  );
}

// ── Indicators (mirror service) ──
function ema(values: number[], period: number): number[] {
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
function rsi(values: number[], period: number): Array<number | null> {
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
function atr(bars: Bar[], period: number): Array<number | null> {
  const out = new Array<number | null>(bars.length).fill(null);
  if (bars.length <= period) return out;
  const tr: number[] = [];
  for (let i = 0; i < bars.length; i++) {
    const high = price(bars[i].h);
    const low = price(bars[i].l);
    const pc = i > 0 ? price(bars[i - 1].c) : high;
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
function snapshotAt(bars: Bar[]): Snap {
  const closes = bars.map((b) => price(b.c));
  const e9 = ema(closes, 9),
    e21 = ema(closes, 21),
    e50 = ema(closes, 50);
  const r = rsi(closes, 14),
    a = atr(bars, ATR_PERIOD);
  const i = bars.length - 1;
  const ymd = vnDate(bars[i].time);
  const day = bars.filter((b) => vnDate(b.time) === ymd);
  let pv = 0,
    vol = 0;
  for (const b of day) {
    const v = b.v || 0;
    pv += ((price(b.h) + price(b.l) + price(b.c)) / 3) * v;
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
      ? Math.max(...prior.map((b) => price(b.h)))
      : price(bars[i].h),
    prevLow12: prior.length
      ? Math.min(...prior.map((b) => price(b.l)))
      : price(bars[i].l),
  };
}

type Side = 'LONG' | 'SHORT';
function decide(s: Snap, f: Flags): Side | null {
  if (s.atr14 == null || s.atr14 < MIN_ATR_POINTS) return null;
  const longChecks = [
    s.close > s.vwap,
    s.ema9 > s.ema21,
    s.emaSlope > 0,
    s.rsi14 != null && s.rsi14 >= 50 && (!f.rsicap || s.rsi14 <= RSI_MAX_LONG),
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
  const need = longChecks.length - 1; // cho phép trượt 1 điều kiện
  const ls = longChecks.filter(Boolean).length;
  const ss = shortChecks.filter(Boolean).length;
  if (ls >= need && ls > ss) return 'LONG';
  if (ss >= need && ss > ls) return 'SHORT';
  return null;
}

type Trade = {
  side: Side;
  entry: number;
  pnl: number;
  rsi: number | null;
  outcome: 'WIN' | 'LOSS' | 'NEUTRAL';
};

function settle(
  bars: Bar[],
  startIdx: number,
  side: Side,
  entry: number,
  atr14: number,
  f: Flags,
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
    const high = price(bars[i].h),
      low = price(bars[i].l);
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
      exitPrice = price(bars[i].c);
      break;
    }
  }
  if (exitPrice == null) {
    exitPrice = price(bars[exitIdx].c);
  }
  const pnl = isLong ? exitPrice - entry : entry - exitPrice;
  const outcome: Trade['outcome'] =
    pnl > 0.01 ? 'WIN' : pnl < -0.01 ? 'LOSS' : 'NEUTRAL';
  return { pnl, outcome, exitIdx };
}

function run(bars: Bar[], f: Flags): Trade[] {
  const trades: Trade[] = [];
  const lossesByDay = new Map<string, number>();
  let i = MIN_BARS - 1;
  while (i < bars.length) {
    const window = bars.slice(0, i + 1);
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
    });
    if (res.outcome === 'LOSS') lossesByDay.set(day, dayLosses + 1);
    i = res.exitIdx + 1; // chỉ 1 vị thế mở tại một thời điểm
  }
  return trades;
}

function report(label: string, trades: Trade[]): void {
  if (!trades.length) {
    console.log(`\n[${label}] không có lệnh`);
    return;
  }
  const w = trades.filter((t) => t.outcome === 'WIN');
  const l = trades.filter((t) => t.outcome === 'LOSS');
  const net = trades.reduce((a, t) => a + t.pnl, 0);
  const gp = trades.filter((t) => t.pnl > 0).reduce((a, t) => a + t.pnl, 0);
  const gl = trades.filter((t) => t.pnl < 0).reduce((a, t) => a + t.pnl, 0);
  const pf = gl !== 0 ? gp / Math.abs(gl) : Infinity;
  const wr = w.length + l.length ? (w.length / (w.length + l.length)) * 100 : 0;
  const lng = trades.filter((t) => t.side === 'LONG');
  const sht = trades.filter((t) => t.side === 'SHORT');
  const sideNet = (a: Trade[]) => a.reduce((x, t) => x + t.pnl, 0);
  console.log(
    `\n[${label}]  ${trades.length} lệnh | WR ${r2(wr)}% | NET ${signed(net)} | ` +
      `PF ${pf === Infinity ? '∞' : r2(pf)} | Exp/lệnh ${signed(net / trades.length)}`,
  );
  console.log(
    `         LONG ${lng.length} (NET ${signed(sideNet(lng))})  |  SHORT ${sht.length} (NET ${signed(sideNet(sht))})`,
  );
}

async function fetchBars(from: Date, to: Date): Promise<Bar[]> {
  const { data } = await axios.get(DNSE_CHART_INDEX, {
    params: {
      symbol: 'VN30',
      resolution: '5',
      from: Math.floor(from.getTime() / 1000),
      to: Math.floor(to.getTime() / 1000),
    },
    headers: { 'User-Agent': 'Mozilla/5.0 Chrome/124.0' },
    timeout: 60000,
  });
  const t: number[] = data?.t ?? [];
  const out: Bar[] = t.map((ts: number, i: number) => ({
    time: ts,
    o: Math.round((data.o[i] ?? 0) * 1000),
    h: Math.round((data.h[i] ?? 0) * 1000),
    l: Math.round((data.l[i] ?? 0) * 1000),
    c: Math.round((data.c[i] ?? 0) * 1000),
    v: Math.round(data.v[i] ?? 0),
  }));
  return out
    .filter((b) =>
      [b.o, b.h, b.l, b.c].every((x) => Number.isFinite(x) && x > 0),
    )
    .sort((a, b) => a.time - b.time);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const get = (k: string) =>
    args.find((a) => a.startsWith(`--${k}=`))?.split('=')[1];
  const to = get('to') ? new Date(get('to') + 'T23:59:59') : new Date();
  const from = get('from')
    ? new Date(get('from') + 'T00:00:00')
    : new Date(to.getTime() - 40 * 24 * 60 * 60 * 1000);

  const bars = await fetchBars(from, to);
  console.log(
    `Nến 5m VN30: ${bars.length} (${vnDate(bars[0]?.time ?? 0)} → ${vnDate(bars[bars.length - 1]?.time ?? 0)})`,
  );
  if (bars.length < MIN_BARS) {
    console.log('Không đủ nến để backtest.');
    return;
  }

  const full: Flags = { ema50: true, trailing: true, rsicap: true };
  report('V3 đầy đủ', run(bars, full));
  report('V3 − bỏ EMA50 filter', run(bars, { ...full, ema50: false }));
  report('V3 − bỏ trailing stop', run(bars, { ...full, trailing: false }));
  report('V3 − bỏ trần RSI', run(bars, { ...full, rsicap: false }));
  report(
    'Trần (không EMA50, không trailing, không RSI cap)',
    run(bars, { ema50: false, trailing: false, rsicap: false }),
  );
}

main().catch((e) => {
  console.error('Backtest lỗi:', e instanceof Error ? e.message : e);
  process.exit(1);
});
