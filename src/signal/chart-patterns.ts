/**
 * Heuristic daily chart pattern — chỉ gợi ý khi cấu trúc tương đối rõ (xu hướng nền,
 * khoảng cách đỉnh/đáy, độ sâu neckline). Không thay thế xác nhận thủ công.
 */
import { MACD, RSI } from 'technicalindicators';
import type { PatternLevel } from './dto/recommendation.dto';

export type Ohlcv = {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

export type OhlcvBar = Ohlcv & { tradingDate?: string };

export interface PatternAnalysis {
  summary: string;
  levels: PatternLevel[];
}

/** Pivot rộng hơn → ít đỉnh/đáy hơn nhưng nét M/W rõ hơn trên daily */
const PIVOT_SWING = 4;

function swingHighIndices(bars: Ohlcv[], pivot: number): number[] {
  const out: number[] = [];
  for (let i = pivot; i < bars.length - pivot; i++) {
    let ok = true;
    const h = bars[i].high;
    for (let k = i - pivot; k <= i + pivot; k++) {
      if (k !== i && bars[k].high >= h) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

function swingLowIndices(bars: Ohlcv[], pivot: number): number[] {
  const out: number[] = [];
  for (let i = pivot; i < bars.length - pivot; i++) {
    let ok = true;
    const lo = bars[i].low;
    for (let k = i - pivot; k <= i + pivot; k++) {
      if (k !== i && bars[k].low <= lo) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

function minLow(bars: Ohlcv[], from: number, to: number): number {
  let m = Infinity;
  for (let i = from; i <= to && i < bars.length; i++) {
    m = Math.min(m, bars[i].low);
  }
  return m;
}

function maxHigh(bars: Ohlcv[], from: number, to: number): number {
  let m = -Infinity;
  for (let i = from; i <= to && i < bars.length; i++) {
    m = Math.max(m, bars[i].high);
  }
  return m;
}

function idxOfMinLow(bars: Ohlcv[], from: number, to: number): number {
  let j = from;
  let v = bars[from].low;
  for (let i = from; i <= to; i++) {
    if (bars[i].low < v) {
      v = bars[i].low;
      j = i;
    }
  }
  return j;
}

function idxOfMaxHigh(bars: Ohlcv[], from: number, to: number): number {
  let j = from;
  let v = bars[from].high;
  for (let i = from; i <= to; i++) {
    if (bars[i].high > v) {
      v = bars[i].high;
      j = i;
    }
  }
  return j;
}

function barDate(bars: OhlcvBar[], i: number): string | undefined {
  const d = bars[i]?.tradingDate;
  return typeof d === 'string' && d.length ? d : undefined;
}

function level(
  role: string,
  price: number,
  bars: OhlcvBar[],
  i: number,
): PatternLevel {
  const date = barDate(bars, i);
  return date ? { role, price, date } : { role, price };
}

const RSI_PERIOD = 14;

function rsiSeries(closes: number[]): number[] {
  return RSI.calculate({ values: closes, period: RSI_PERIOD });
}

function rsiAtBar(rsi: number[], barIdx: number): number {
  const j = barIdx - (RSI_PERIOD - 1);
  if (j < 0 || j >= rsi.length) return NaN;
  return rsi[j];
}

function macdHistSeries(closes: number[]): number[] {
  const m = MACD.calculate({
    values: closes,
    fastPeriod: 12,
    slowPeriod: 26,
    signalPeriod: 9,
    SimpleMAOscillator: false,
    SimpleMASignal: false,
  });
  return m.map((x) =>
    x.MACD !== undefined && x.signal !== undefined
      ? x.MACD - x.signal
      : NaN,
  );
}

function fmtK(n: number): string {
  return `${(n / 1000).toFixed(1)}k`;
}

function avgVol(bars: Ohlcv[], from: number, to: number): number {
  let s = 0;
  let c = 0;
  for (let i = from; i < to && i < bars.length; i++) {
    s += bars[i].volume;
    c++;
  }
  return c ? s / c : 0;
}

function detectDoubleTopForming(
  bars: OhlcvBar[],
  rsiFull: number[],
  lastHist: number,
  volNote: string,
): PatternAnalysis | null {
  const highs = swingHighIndices(bars, PIVOT_SWING);
  if (highs.length < 2) return null;

  const tol = 0.015;
  const minGap = 28;
  const maxRecentBars = 38;

  for (let a = highs.length - 1; a >= 1; a--) {
    const i2 = highs[a];
    if (bars.length - 1 - i2 > maxRecentBars) continue;

    const p2 = bars[i2].high;
    for (let b = a - 1; b >= 0; b--) {
      const i1 = highs[b];
      if (i2 - i1 < minGap) continue;
      const p1 = bars[i1].high;
      const mid = Math.max(p1, p2);
      if (Math.abs(p1 - p2) / mid > tol) continue;

      const loBetween = Math.min(
        ...bars.slice(i1, i2 + 1).map((x) => x.low),
      );
      const peakAvg = (p1 + p2) / 2;
      const neckDepth = (peakAvg - loBetween) / peakAvg;
      if (neckDepth < 0.045) continue;

      const t0 = Math.max(0, i1 - 52);
      const lowBeforePeak1 = minLow(bars, t0, i1);
      const priorUptrend = (p1 - lowBeforePeak1) / p1;
      if (priorUptrend < 0.1) continue;

      const last = bars[bars.length - 1].close;
      if (last <= loBetween * 1.002) continue;

      const neckIdx = idxOfMinLow(bars, i1, i2);

      const r1 = rsiAtBar(rsiFull, i1);
      const r2 = rsiAtBar(rsiFull, i2);

      let extra = '';
      if (Number.isFinite(r1) && Number.isFinite(r2) && r2 < r1 - 3) {
        extra = ` Phân kỳ RSI rõ: đỉnh sau yếu hơn (${r1.toFixed(0)} → ${r2.toFixed(0)}).`;
      }
      if (lastHist < 0) {
        extra += ` MACD histogram < 0.`;
      }

      const levels: PatternLevel[] = [
        level('Đỉnh 1', p1, bars, i1),
        level('Đỉnh 2', p2, bars, i2),
        level('Neckline (đáy giữa)', bars[neckIdx].low, bars, neckIdx),
      ];

      const summary =
        `Mô hình 2 đỉnh (M) khá rõ: hai đỉnh gần ${fmtK(peakAvg)}, đáy giữa ~${fmtK(loBetween)} — giá trên neckline; theo dõi phá vỡ đáy giữa.${extra} ${volNote}`;

      return { summary, levels };
    }
  }
  return null;
}

function detectDoubleBottomForming(
  bars: OhlcvBar[],
  rsiFull: number[],
  lastHist: number,
  volNote: string,
): PatternAnalysis | null {
  const lows = swingLowIndices(bars, PIVOT_SWING);
  if (lows.length < 2) return null;

  const tol = 0.015;
  const minGap = 28;
  const maxRecentBars = 38;

  for (let a = lows.length - 1; a >= 1; a--) {
    const i2 = lows[a];
    if (bars.length - 1 - i2 > maxRecentBars) continue;

    const p2 = bars[i2].low;
    for (let b = a - 1; b >= 0; b--) {
      const i1 = lows[b];
      if (i2 - i1 < minGap) continue;
      const p1 = bars[i1].low;
      const midP = Math.max(p1, p2);
      if (Math.abs(p1 - p2) / midP > tol) continue;

      const hiBetween = Math.max(
        ...bars.slice(i1, i2 + 1).map((x) => x.high),
      );
      const botAvg = (p1 + p2) / 2;
      const neckRally = (hiBetween - botAvg) / botAvg;
      if (neckRally < 0.045) continue;

      const t0 = Math.max(0, i1 - 52);
      const highBeforeBot1 = maxHigh(bars, t0, i1);
      const priorDn = (highBeforeBot1 - p1) / highBeforeBot1;
      if (priorDn < 0.1) continue;

      const last = bars[bars.length - 1].close;
      if (last >= hiBetween * 0.998) continue;

      const neckIdx = idxOfMaxHigh(bars, i1, i2);

      const r1 = rsiAtBar(rsiFull, i1);
      const r2 = rsiAtBar(rsiFull, i2);
      let extra = '';
      if (Number.isFinite(r1) && Number.isFinite(r2) && r2 > r1 + 3) {
        extra = ` Phân kỳ RSI rõ: đáy sau cao hơn (${r1.toFixed(0)} → ${r2.toFixed(0)}).`;
      }
      if (lastHist > 0) {
        extra += ` MACD histogram > 0.`;
      }

      const levels: PatternLevel[] = [
        level('Đáy 1', p1, bars, i1),
        level('Đáy 2', p2, bars, i2),
        level('Neckline (đỉnh giữa)', bars[neckIdx].high, bars, neckIdx),
      ];

      const summary =
        `Mô hình 2 đáy (W) khá rõ: hai đáy quanh ${fmtK(botAvg)}, đỉnh giữa ~${fmtK(hiBetween)} — chờ bứt lên neckline.${extra} ${volNote}`;

      return { summary, levels };
    }
  }
  return null;
}

function detectCupHandleForming(
  bars: OhlcvBar[],
  lastHist: number,
  volNote: string,
): PatternAnalysis | null {
  if (bars.length < 100) return null;
  const n = bars.length;
  const cupZoneEnd = Math.floor(n * 0.68);
  const cupZoneStart = Math.floor(n * 0.14);
  let cupLowIdx = cupZoneStart;
  let cupLow = bars[cupZoneStart].low;
  for (let i = cupZoneStart + 1; i < cupZoneEnd; i++) {
    if (bars[i].low < cupLow) {
      cupLow = bars[i].low;
      cupLowIdx = i;
    }
  }
  if (cupLowIdx < n * 0.18 || cupLowIdx > n * 0.62) return null;

  const leftSliceEnd = Math.max(8, Math.floor(cupLowIdx * 0.82));
  let leftRim = 0;
  let leftRimIdx = 0;
  for (let i = 0; i < leftSliceEnd && i < bars.length; i++) {
    if (bars[i].high > leftRim) {
      leftRim = bars[i].high;
      leftRimIdx = i;
    }
  }

  const afterCup = bars.slice(cupLowIdx + 1, n - 6);
  if (afterCup.length < 18) return null;
  let rimRecover = 0;
  let rimRecoverIdx = cupLowIdx + 1;
  for (let j = 0; j < afterCup.length; j++) {
    if (afterCup[j].high > rimRecover) {
      rimRecover = afterCup[j].high;
      rimRecoverIdx = cupLowIdx + 1 + j;
    }
  }
  const rimTol = 0.025;
  if (
    rimRecover < leftRim * (1 - rimTol) ||
    rimRecover > leftRim * (1 + rimTol)
  ) {
    return null;
  }
  const cupDepth = leftRim - cupLow;
  if (cupDepth / leftRim < 0.12) return null;

  const tail = bars.slice(-22);
  let recentHigh = 0;
  let recentHighIdx = n - 1;
  for (let i = 0; i < tail.length; i++) {
    if (tail[i].high > recentHigh) {
      recentHigh = tail[i].high;
      recentHighIdx = n - tail.length + i;
    }
  }
  const last = bars[n - 1];
  const handlePullback = (recentHigh - last.close) / recentHigh;
  if (handlePullback < 0.02 || handlePullback > 0.075) return null;

  const volRise = avgVol(bars, cupLowIdx, cupLowIdx + 28);
  const volHandle = avgVol(bars, n - 14, n);
  if (volRise <= 0 || volHandle >= volRise * 0.88) return null;

  let mExtra = '';
  if (lastHist > 0) {
    mExtra = ' MACD histogram dương — theo dõi breakout tay cầm.';
  }

  const levels: PatternLevel[] = [
    level('Mép trái (cốc)', leftRim, bars, leftRimIdx),
    level('Đáy cốc', cupLow, bars, cupLowIdx),
    level('Mép phải (hồi)', rimRecover, bars, rimRecoverIdx),
    level('Đỉnh vùng tay cầm', recentHigh, bars, recentHighIdx),
  ];

  const summary =
    `Mô hình cốc–tay cầm khá rõ: đáy cốc ~${fmtK(cupLow)}, mép ~${fmtK(rimRecover)}; tay cầm ~${(handlePullback * 100).toFixed(1)}%, KL tay cầm thấp hơn giai đoạn hồi.${mExtra} ${volNote}`;

  return { summary, levels };
}

/**
 * Phân tích mô hình + danh sách đỉnh/đáy tham chiếu (có ngày nếu bar có tradingDate).
 */
export function buildPatternAnalysis(bars: OhlcvBar[]): PatternAnalysis | null {
  if (bars.length < 80) return null;

  const closes = bars.map((b) => b.close);
  const rsiF = rsiSeries(closes);
  if (rsiF.length < 5) return null;
  const hist = macdHistSeries(closes);
  const lastHist = hist[hist.length - 1] ?? 0;

  const v20 = avgVol(bars, bars.length - 20, bars.length);
  const v60 = avgVol(bars, bars.length - 60, bars.length);
  let volNote = '';
  if (v60 > 0) {
    const r = v20 / v60;
    if (r < 0.75) {
      volNote =
        'KL 20 phiên thấp hơn trung bình 60 phiên — thanh khoản đang tĩnh.';
    } else if (r > 1.35) {
      volNote = 'KL 20 phiên cao hơn trung bình 60 phiên — cần xem kèm hướng giá.';
    } else {
      volNote = 'KL gần đây tương đương trung bình.';
    }
  }

  const cup = detectCupHandleForming(bars, lastHist, volNote);
  const dt = detectDoubleTopForming(bars, rsiF, lastHist, volNote);
  const db = detectDoubleBottomForming(bars, rsiF, lastHist, volNote);

  if (cup) return cup;
  if (dt && db) {
    return dt.summary.length >= db.summary.length ? dt : db;
  }
  if (dt) return dt;
  if (db) return db;
  return null;
}

/** @deprecated Dùng buildPatternAnalysis */
export function buildPatternSummary(bars: OhlcvBar[]): string | null {
  return buildPatternAnalysis(bars)?.summary ?? null;
}
