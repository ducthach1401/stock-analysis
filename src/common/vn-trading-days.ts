/**
 * Quy ước thanh toán cổ phiếu VN: mua xong phải qua đủ 2 phiên (T+2) mới được bán
 * (đếm phiên T2–T6, bỏ T7/CN; không trừ ngày lễ — có thể bổ sung sau).
 */

/** Số phiên giao dịch tối thiểu sau ngày mua trước khi được bán (T+2). */
export const MIN_TRADING_SESSIONS_AFTER_ENTRY = 2;

/**
 * Đếm số phiên T2–T6 từ ngày liền sau ngày mua đến ngày bán (bao gồm ngày bán).
 * Ví dụ: mua thứ 2 → bán sớm nhất thứ 4 (2 phiên: thứ 3, thứ 4).
 */
export function tradingSessionsAfterEntryDate(
  entryDate: string,
  exitDate: string,
): number {
  const start = new Date(entryDate + 'T12:00:00');
  const end = new Date(exitDate + 'T12:00:00');
  if (end < start) return 0;
  const d = new Date(start);
  d.setDate(d.getDate() + 1);
  let count = 0;
  while (d <= end) {
    const wd = d.getDay();
    if (wd !== 0 && wd !== 6) count++;
    d.setDate(d.getDate() + 1);
  }
  return count;
}

export function canSellAfterT2(entryDate: string, exitDate: string): boolean {
  return (
    tradingSessionsAfterEntryDate(entryDate, exitDate) >=
    MIN_TRADING_SESSIONS_AFTER_ENTRY
  );
}
