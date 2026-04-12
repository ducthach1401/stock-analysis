/**
 * Khi lãi ≥ mức này (%) so với giá vào: ưu tiên gồng (không chốt chỉ vì đạt target);
 * sau khi đã từng vượt ngưỡng này, **sàn lãi** có thể cao hơn nếu đỉnh chạy xa (xem `effectiveProfitFloorPnl`).
 */
export const PROFIT_RUN_PCT = 20;

/**
 * % pullback tính từ **giá đỉnh** (không phải % điểm lãi): đỉnh càng cao thì sàn lãi tối thiểu càng được **nâng**
 * để không trả lại hết lãi khi chỉ giữ mức cố định 20%.
 */
export const PROFIT_TRAIL_FROM_PEAK_PCT = 20;

/**
 * % lãi tối thiểu phải còn sau khi đã từng trên `PROFIT_RUN_PCT` và giá quay đầu:
 * `max(PROFIT_RUN_PCT, (peak/entry)×(1−trail) − 1)`.
 */
export function effectiveProfitFloorPnl(
  entryPrice: number,
  peakPrice: number,
): number {
  const e = Number(entryPrice);
  const peak = Number(peakPrice);
  if (!Number.isFinite(e) || e <= 0 || !Number.isFinite(peak) || peak < e) {
    return PROFIT_RUN_PCT;
  }
  const fromPeak =
    ((peak / e) * (1 - PROFIT_TRAIL_FROM_PEAK_PCT / 100) - 1) * 100;
  return Math.max(PROFIT_RUN_PCT, fromPeak);
}
