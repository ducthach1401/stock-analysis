import { Recommendation } from './dto/recommendation.dto';

/**
 * Context thị trường tại ngày đánh giá — dùng để gate market timing và RS filter.
 * Optional: nếu không cung cấp, các check này tự động pass (backward compatible).
 */
export interface MarketContext {
  /** Giá đóng cửa VNINDEX ngày đó */
  vnindexClose: number;
  /** SMA50 VNINDEX — null nếu chưa đủ 50 nến */
  vnindexSma50: number | null;
  /** % tăng trưởng cổ phiếu 63 phiên (~3 tháng) — null nếu chưa đủ */
  stockReturn3M: number | null;
  /** % tăng trưởng VNINDEX 63 phiên (~3 tháng) — null nếu chưa đủ */
  vnindexReturn3M: number | null;
}

export interface MinerviniBar {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  tradingDate?: string;
}

export interface MinerviniEvaluation {
  recommendation: Recommendation;
  score: number;
  trendOk: boolean;
  baseOk: boolean;
  breakoutOk: boolean;
  volumeOk: boolean;
  buyZoneOk: boolean;
  extended: boolean;
  nearPivot: boolean;
  rsAvailable: boolean;
  /** VNINDEX đang trên SMA50 — true khi không có MarketContext (pass-through) */
  marketTimingOk: boolean;
  /** Cổ phiếu tăng mạnh hơn VNINDEX 3 tháng — true khi không có MarketContext (pass-through) */
  rsOk: boolean;
  pivot: number | null;
  baseLow: number | null;
  baseDepthPct: number | null;
  volumeRatio: number | null;
  closePosition: number | null;
  stopLoss: number | null;
  targetPrice: number | null;
  riskReward: number | null;
  reasons: string[];
}

export const MINERVINI_STOP_PCT = 0.07;
export const MINERVINI_MIN_TARGET_PCT = 0.2;
export const MINERVINI_DEFAULT_TARGET_PCT = 0.25;
export const MINERVINI_MAX_BUY_ZONE_PCT = 0.05;
export const MINERVINI_MAX_MA50_EXTENSION_PCT = 0.15;
export const MINERVINI_PROFIT_LOCK_PCT = 0.2;

function sma(
  values: number[],
  endIndex: number,
  length: number,
): number | null {
  if (length <= 0 || endIndex + 1 < length) return null;
  let sum = 0;
  const start = endIndex - length + 1;
  for (let i = start; i <= endIndex; i++) sum += values[i];
  return sum / length;
}

function min(values: number[]): number | null {
  if (!values.length) return null;
  return Math.min(...values);
}

function max(values: number[]): number | null {
  if (!values.length) return null;
  return Math.max(...values);
}

function avg(values: number[]): number | null {
  if (!values.length) return null;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

export function minerviniTargetPctFromEnv(): number {
  const raw = process.env.MINERVINI_TARGET_PCT;
  const parsed = raw == null || raw === '' ? NaN : parseFloat(raw);
  const pct = Number.isFinite(parsed)
    ? parsed / 100
    : MINERVINI_DEFAULT_TARGET_PCT;
  return Math.max(MINERVINI_MIN_TARGET_PCT, pct);
}

function findBaseBeforeLast(bars: MinerviniBar[]): {
  ok: boolean;
  pivot: number | null;
  low: number | null;
  depthPct: number | null;
  length: number | null;
} {
  if (bars.length < 70) {
    return { ok: false, pivot: null, low: null, depthPct: null, length: null };
  }

  for (let len = 15; len <= 65; len++) {
    if (bars.length < len + 1) break;
    const base = bars.slice(-(len + 1), -1);
    const highs = base.map((b) => b.high);
    const lows = base.map((b) => b.low);
    const volumes = base.map((b) => b.volume);
    const high = max(highs);
    const low = min(lows);
    if (high == null || low == null || high <= 0) continue;

    const depth = (high - low) / high;
    if (depth > 0.3) continue;

    const half = Math.floor(base.length / 2);
    const firstHalf = base.slice(0, half);
    const secondHalf = base.slice(half);
    const firstRangeHigh = max(firstHalf.map((b) => b.high));
    const firstRangeLow = min(firstHalf.map((b) => b.low));
    const secondRangeHigh = max(secondHalf.map((b) => b.high));
    const secondRangeLow = min(secondHalf.map((b) => b.low));
    if (
      firstRangeHigh == null ||
      firstRangeLow == null ||
      secondRangeHigh == null ||
      secondRangeLow == null
    ) {
      continue;
    }
    const firstRange = firstRangeHigh - firstRangeLow;
    const secondRange = secondRangeHigh - secondRangeLow;
    const rangeContracting = firstRange > 0 && secondRange <= firstRange * 0.95;

    const firstVol = avg(volumes.slice(0, half));
    const lastVol = avg(volumes.slice(-Math.max(5, Math.floor(len / 3))));
    const volumeDrying =
      firstVol != null && lastVol != null && lastVol <= firstVol;

    if (rangeContracting || volumeDrying) {
      return {
        ok: true,
        pivot: high,
        low,
        depthPct: Number((depth * 100).toFixed(2)),
        length: len,
      };
    }
  }

  return { ok: false, pivot: null, low: null, depthPct: null, length: null };
}

export function evaluateMinervini(
  bars: MinerviniBar[],
  ctx?: MarketContext,
): MinerviniEvaluation {
  // Market timing: VNINDEX > SMA50. True nếu không có ctx (backward compat).
  const marketTimingOk =
    ctx == null ||
    ctx.vnindexSma50 == null ||
    ctx.vnindexClose > ctx.vnindexSma50;

  // RS filter: cổ phiếu tăng mạnh hơn VNINDEX 3 tháng. True nếu không có ctx.
  const rsOk =
    ctx == null ||
    ctx.stockReturn3M == null ||
    ctx.vnindexReturn3M == null ||
    ctx.stockReturn3M > ctx.vnindexReturn3M;

  const reasons: string[] = [];
  const lastIndex = bars.length - 1;
  const last = bars[lastIndex];
  if (!last || bars.length < 220) {
    return {
      recommendation: Recommendation.HOLD,
      score: 0,
      trendOk: false,
      baseOk: false,
      breakoutOk: false,
      volumeOk: false,
      buyZoneOk: false,
      extended: false,
      nearPivot: false,
      rsAvailable: false,
      marketTimingOk,
      rsOk,
      pivot: null,
      baseLow: null,
      baseDepthPct: null,
      volumeRatio: null,
      closePosition: null,
      stopLoss: null,
      targetPrice: null,
      riskReward: null,
      reasons: [
        'Chưa đủ dữ liệu cho Strict Minervini (cần tối thiểu ~220 phiên)',
      ],
    };
  }

  const closes = bars.map((b) => b.close);
  const volumes = bars.map((b) => b.volume);
  const close = last.close;
  const sma50 = sma(closes, lastIndex, 50);
  const sma150 = sma(closes, lastIndex, 150);
  const sma200 = sma(closes, lastIndex, 200);
  const sma200Prev20 = sma(closes, lastIndex - 20, 200);
  const lookback52w = bars.slice(Math.max(0, bars.length - 252));
  const low52w = min(lookback52w.map((b) => b.low));
  const high52w = max(lookback52w.map((b) => b.high));

  const trendOk =
    sma50 != null &&
    sma150 != null &&
    sma200 != null &&
    sma200Prev20 != null &&
    low52w != null &&
    high52w != null &&
    close > sma50 &&
    sma50 > sma150 &&
    sma150 > sma200 &&
    sma200 > sma200Prev20 &&
    close >= low52w * 1.3 &&
    close >= high52w * 0.75;
  if (trendOk) reasons.push('Trend template đạt');

  const base = findBaseBeforeLast(bars);
  const baseOk = base.ok;
  if (baseOk) {
    reasons.push(
      `Nền/VCP đạt (${base.length} phiên, depth ${base.depthPct?.toFixed(1)}%)`,
    );
  }

  const avgVol50 = avg(volumes.slice(-51, -1));
  const volumeRatio =
    avgVol50 != null && avgVol50 > 0 ? last.volume / avgVol50 : null;
  const volumeOk = volumeRatio != null && volumeRatio >= 1.4;
  const pivot = base.pivot;
  const breakoutOk = pivot != null && close > pivot;
  const buyZoneOk =
    pivot != null &&
    close > pivot &&
    close <= pivot * (1 + MINERVINI_MAX_BUY_ZONE_PCT);
  const nearPivot =
    pivot != null && close >= pivot * 0.97 && close <= pivot * 1.005;
  const range = last.high - last.low;
  const closePosition = range > 0 ? (last.close - last.low) / range : null;
  const closeStrong = closePosition != null && closePosition >= 0.5;
  const extended =
    sma50 != null && close > sma50 * (1 + MINERVINI_MAX_MA50_EXTENSION_PCT);

  if (breakoutOk)
    reasons.push(`Break pivot ${Math.round(pivot).toLocaleString('vi-VN')}đ`);
  if (volumeOk && volumeRatio != null)
    reasons.push(`Volume ${volumeRatio.toFixed(1)}x MA50`);
  if (buyZoneOk) reasons.push('Giá trong buy zone <=5% trên pivot');
  if (extended) reasons.push('Giá quá xa MA50');

  const stopLoss = Math.round(close * (1 - MINERVINI_STOP_PCT));
  const targetPrice = Math.round(close * (1 + minerviniTargetPctFromEnv()));
  const risk = close - stopLoss;
  const riskReward =
    risk > 0 ? Number(((targetPrice - close) / risk).toFixed(2)) : null;

  if (!marketTimingOk)
    reasons.push('Market timing: VNINDEX < SMA50 — thị trường chưa vào uptrend');
  if (!rsOk)
    reasons.push('RS yếu: cổ phiếu tăng chậm hơn VNINDEX 3 tháng qua');

  let recommendation = Recommendation.HOLD;
  if (
    trendOk &&
    baseOk &&
    breakoutOk &&
    volumeOk &&
    buyZoneOk &&
    closeStrong &&
    !extended &&
    marketTimingOk &&
    rsOk
  ) {
    recommendation = Recommendation.STRONG_BUY;
  } else if (trendOk && baseOk && nearPivot && !extended) {
    recommendation = Recommendation.BUY;
  }

  const score =
    (trendOk ? 2 : 0) +
    (baseOk ? 2 : 0) +
    (breakoutOk ? 2 : 0) +
    (volumeOk ? 1.5 : 0) +
    (buyZoneOk ? 1.5 : 0) +
    (closeStrong ? 1 : 0) -
    (extended ? 2 : 0) -
    (!marketTimingOk ? 1 : 0) -
    (!rsOk ? 0.5 : 0);

  return {
    recommendation,
    score: Number(Math.max(0, Math.min(10, score)).toFixed(2)),
    trendOk,
    baseOk,
    breakoutOk,
    volumeOk,
    buyZoneOk,
    extended,
    nearPivot,
    rsAvailable: false,
    marketTimingOk,
    rsOk,
    pivot,
    baseLow: base.low,
    baseDepthPct: base.depthPct,
    volumeRatio: volumeRatio == null ? null : Number(volumeRatio.toFixed(2)),
    closePosition:
      closePosition == null ? null : Number(closePosition.toFixed(2)),
    stopLoss,
    targetPrice,
    riskReward,
    reasons,
  };
}

export function minerviniReasonText(e: MinerviniEvaluation): string {
  if (e.recommendation === Recommendation.STRONG_BUY) {
    return `Strict Minervini: ${e.reasons.join(' · ')}.`;
  }
  if (e.recommendation === Recommendation.BUY) {
    return `Theo dõi mua: trend template + nền/VCP đạt, chờ breakout pivot với volume xác nhận.`;
  }
  return `Chưa đủ setup Strict Minervini. ${e.reasons.length ? e.reasons.join(' · ') : ''}`.trim();
}
