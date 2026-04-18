/** Giờ/phút/ngày trong tuần theo Asia/Ho_Chi_Minh (phiên sàn VN). */
export function hoChiMinhTimeParts(d = new Date()): {
  weekday: number;
  hour: number;
  minute: number;
} {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Ho_Chi_Minh',
    weekday: 'short',
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
  });
  const parts = fmt.formatToParts(d);
  const get = (type: string) =>
    parts.find((p) => p.type === type)?.value ?? '';
  const wdStr = get('weekday');
  const wdMap: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  const hour = parseInt(get('hour'), 10);
  const minute = parseInt(get('minute'), 10);
  return {
    weekday: wdMap[wdStr] ?? 0,
    hour: Number.isFinite(hour) ? hour : 0,
    minute: Number.isFinite(minute) ? minute : 0,
  };
}

/** T2–T6, phiên khớp lệnh liên tục: 9:30–11:30 và 13:00–14:45. */
export function isVnCashMarketSessionOpen(d = new Date()): boolean {
  const { weekday, hour, minute } = hoChiMinhTimeParts(d);
  if (weekday === 0 || weekday === 6) return false;
  const inMorning =
    (hour === 9 && minute >= 30) ||
    hour === 10 ||
    (hour === 11 && minute <= 30);
  const inAfternoon = hour === 13 || (hour === 14 && minute <= 45);
  return inMorning || inAfternoon;
}

/**
 * Khuyến nghị tự động / Telegram / mở vị thế chỉ dùng nến ngày đã đóng phiên
 * (sau ATC 14:45 — mặc định từ 14:46 VN trở đi, T2–T6).
 */
export function isVnAfterMarketCloseForDailySignals(d = new Date()): boolean {
  const { weekday, hour, minute } = hoChiMinhTimeParts(d);
  if (weekday === 0 || weekday === 6) return false;
  const t = hour * 60 + minute;
  const afterClose = 14 * 60 + 46;
  return t >= afterClose;
}

/** Ngày lịch VN (YYYY-MM-DD) theo múi giờ Asia/Ho_Chi_Minh — dùng cooldown mở lại vị thế. */
export function vnCalendarTodayYmd(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Ho_Chi_Minh',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

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
