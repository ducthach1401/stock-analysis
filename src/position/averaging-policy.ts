import {
  Recommendation,
  RecommendationResult,
} from '../signal/dto/recommendation.dto';
import {
  Signal,
  SignalDirection,
  SignalType,
} from '../signal/entities/signal.entity';

/** Minervini: không trung bình giá khi lỗ. */
export const MAX_AVERAGE_DOWN_LEGS = 0;

/**
 * Sau khi đóng lệnh, không mở lại cùng mã trong N ngày lịch (giống PositionService).
 * Backtest dùng cùng quy tắc với `asOfYmd` = ngày nến đang xét.
 */
export const POSITION_REENTRY_COOLDOWN_DAYS = 5;

/** Cộng trừ ngày lịch trên chuỗi YYYY-MM-DD (UTC, không DST VN). */
export function addCalendarDaysYmd(ymd: string, deltaDays: number): string {
  const s = ymd.slice(0, 10);
  const [y, m, d] = s.split('-').map((x) => parseInt(x, 10));
  const t = Date.UTC(y, m - 1, d) + deltaDays * 86400000;
  const u = new Date(t);
  const yy = u.getUTCFullYear();
  const mm = String(u.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(u.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

/**
 * Còn trong cửa sổ cooldown: ngày đóng gần đây ≥ (asOf − cooldownDays).
 * Trùng logic `PositionService.tryOpenFirst` (so sánh chuỗi YYYY-MM-DD).
 */
export function isInReentryCooldown(
  lastCloseYmd: string | null | undefined,
  asOfYmd: string,
  cooldownDays: number = POSITION_REENTRY_COOLDOWN_DAYS,
): boolean {
  if (cooldownDays <= 0) return false;
  if (!lastCloseYmd) return false;
  const close = String(lastCloseYmd).slice(0, 10);
  const threshold = addCalendarDaysYmd(asOfYmd.slice(0, 10), -cooldownDays);
  return close >= threshold;
}

/**
 * Quy ước khối lượng TB: lệnh đầu = `BASE_POSITION_UNITS` đơn vị;
 * mỗi lần TBG chỉ mua thêm `UNITS_PER_AVERAGE_LEG` đơn (vd. lần 1–3 TB đều +1 đơn).
 * Giá TB = trung bình gia quyền; tỷ lệ khối đang nắm : lần mua mới tại TB thứ k là
 * (k : 1) với k = 1, 2, 3… (1:1 → 2:1 → 3:1…).
 */
export const BASE_POSITION_UNITS = 1;
export const UNITS_PER_AVERAGE_LEG = 1;

/**
 * TB khi lỗ **ít nhất** bấy nhiêu % so với giá vào bình quân (long) — tránh TB khi lỗ còn nông (dưới ~10%).
 * Không giới hạn trên: lỗ sâu vẫn có thể TB nếu đủ nền hoặc hồi phục + khuyến nghị cho phép (kể cả HOLD).
 */
export const AVERAGE_DOWN_MIN_LOSS_PCT = 10;

/** % lỗ so với giá TB (long). Giá ≥ entry → 0. */
export function lossPercentBelowWeightedEntryLong(
  weightedEntryPrice: number,
  currentPrice: number,
): number {
  const e = Number(weightedEntryPrice);
  const p = Number(currentPrice);
  if (!Number.isFinite(e) || e <= 0 || !Number.isFinite(p) || p >= e) return 0;
  return ((e - p) / e) * 100;
}

/** Giá vào bình quân sau một lần mua TB (mỗi lần `UNITS_PER_AVERAGE_LEG` đơn tại `addPrice`). */
export function weightedEntryAfterAverageDown(
  weightedEntryPrice: number,
  completedAverageLegCount: number,
  addPrice: number,
): number {
  const unitsBefore =
    BASE_POSITION_UNITS + completedAverageLegCount * UNITS_PER_AVERAGE_LEG;
  const addUnits = UNITS_PER_AVERAGE_LEG;
  return (
    (weightedEntryPrice * unitsBefore + addPrice * addUnits) /
    (unitsBefore + addUnits)
  );
}

/**
 * Suy ngược giá lệnh mua đầu từ giá TB cuối và các lần TB (cùng quy ước khối lượng).
 * Dùng khi DB chỉ lưu `entryPrice` = TB sau mỗi lần, không lưu riêng giá đầu.
 */
export function firstLegPriceFromWeightedAverage(
  finalWeightedEntry: number,
  averageDownLegs: { price: number }[],
): number {
  let e = Number(finalWeightedEntry);
  const n = averageDownLegs.length;
  for (let i = n; i >= 1; i--) {
    const legPrice = Number(averageDownLegs[i - 1].price);
    const unitsBefore = BASE_POSITION_UNITS + (i - 1) * UNITS_PER_AVERAGE_LEG;
    e =
      (e * (unitsBefore + UNITS_PER_AVERAGE_LEG) -
        legPrice * UNITS_PER_AVERAGE_LEG) /
      unitsBefore;
  }
  return e;
}

const GOOD_BASE_TYPES = new Set<string>([
  SignalType.MINERVINI_TREND_TEMPLATE,
  SignalType.MINERVINI_VCP_BASE,
]);

const RECOVERY_TYPES = new Set<string>([
  SignalType.MINERVINI_PIVOT_BREAKOUT,
  SignalType.MINERVINI_VOLUME_CONFIRM,
  SignalType.MINERVINI_BUY_ZONE,
]);

/** Các loại tín hiệu BULLISH trong ngày (backtest / API thô). */
export function bullishTypesFromSignals(signals: Signal[]): Set<string> {
  return new Set(
    signals
      .filter((s) => s.direction === SignalDirection.BULLISH)
      .map((s) => s.type),
  );
}

function typesFromResult(r: RecommendationResult): Set<string> {
  return new Set(r.bullishSignals.map((s) => s.type));
}

export function hasGoodBaseFromTypes(t: Set<string>): boolean {
  return [...GOOD_BASE_TYPES].every((x) => t.has(x));
}

export function hasBreakoutFromTypes(t: Set<string>): boolean {
  return (
    t.has(SignalType.MINERVINI_PIVOT_BREAKOUT) &&
    t.has(SignalType.MINERVINI_VOLUME_CONFIRM) &&
    t.has(SignalType.MINERVINI_BUY_ZONE)
  );
}

export function hasRecoveryFromTypes(t: Set<string>): boolean {
  for (const x of RECOVERY_TYPES) {
    if (t.has(x)) return true;
  }
  return false;
}

/** Nền ổn / cấu trúc tích lũy / squeeze. */
export function hasGoodBaseSignals(r: RecommendationResult): boolean {
  return hasGoodBaseFromTypes(typesFromResult(r));
}

/** Break kháng cự — có thể là mua mạnh khi nền đã chín. */
export function hasBreakoutSignal(r: RecommendationResult): boolean {
  return hasBreakoutFromTypes(typesFromResult(r));
}

/** Tín hiệu phục hồi / tăng trở lại (để TB khi đang lỗ). */
export function hasRecoverySignals(r: RecommendationResult): boolean {
  return hasRecoveryFromTypes(typesFromResult(r));
}

/** Mở vị thế lần đầu: STRONG_BUY + (nền tốt hoặc break). */
export function allowsFirstPositionEntry(r: RecommendationResult): boolean {
  if (r.recommendation !== Recommendation.STRONG_BUY) return false;
  const t = typesFromResult(r);
  return hasGoodBaseFromTypes(t) || hasBreakoutFromTypes(t);
}

/** Cùng điều kiện `allowsFirstPositionEntry` nhưng từ mảng Signal (backtest). */
export function allowsFirstPositionEntryFromSignals(
  signals: Signal[],
  rec: Recommendation,
): boolean {
  if (rec !== Recommendation.STRONG_BUY) return false;
  const t = bullishTypesFromSignals(signals);
  return hasGoodBaseFromTypes(t) || hasBreakoutFromTypes(t);
}

export function averageReasonLabel(
  r: RecommendationResult,
): 'NỀN_TỐT' | 'HỒI_PHỤC' | 'NỀN_VÀ_HỒI' {
  const t = typesFromResult(r);
  const g = hasGoodBaseFromTypes(t) || hasBreakoutFromTypes(t);
  const h = hasRecoveryFromTypes(t);
  if (g && h) return 'NỀN_VÀ_HỒI';
  if (g) return 'NỀN_TỐT';
  return 'HỒI_PHỤC';
}

/** Cùng logic `averageReasonLabel` nhưng từ `Signal[]` (backtest). */
export function averageReasonLabelFromSignals(
  signals: Signal[],
): 'NỀN_TỐT' | 'HỒI_PHỤC' | 'NỀN_VÀ_HỒI' {
  const t = bullishTypesFromSignals(signals);
  const g = hasGoodBaseFromTypes(t) || hasBreakoutFromTypes(t);
  const h = hasRecoveryFromTypes(t);
  if (g && h) return 'NỀN_VÀ_HỒI';
  if (g) return 'NỀN_TỐT';
  return 'HỒI_PHỤC';
}

/** Minervini: tắt hẳn trung bình giá khi lỗ. */
export function allowsAverageDown(
  r: RecommendationResult,
  weightedEntryPrice: number,
  currentLegCount: number,
): boolean {
  void r;
  void weightedEntryPrice;
  void currentLegCount;
  return false;
}

/** Minervini: tắt hẳn trung bình giá khi lỗ (backtest). */
export function allowsAverageDownFromSignals(
  signals: Signal[],
  rec: Recommendation,
  weightedEntry: number,
  marketClose: number,
  averageLegCount: number,
): boolean {
  void signals;
  void rec;
  void weightedEntry;
  void marketClose;
  void averageLegCount;
  return false;
}
