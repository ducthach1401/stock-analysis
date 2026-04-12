/**
 * Chuẩn hóa ngày giao dịch cho chart / nhóm theo phiên.
 * MySQL `DATE` qua TypeORM đôi khi là `Date` hoặc chuỗi ISO dài — nếu không gộp sẽ tạo nhiều key
 * cho cùng một phiên → chart vẽ chồng nhiều marker giống nhau (vd. 5× "EMA DEATH CROSS").
 */
export function toChartTradingDateString(value: unknown): string {
  if (value == null || value === '') return '';
  if (typeof value === 'string') {
    const m = /^(\d{4}-\d{2}-\d{2})/.exec(value.trim());
    if (m) return m[1];
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) {
      const y = d.getFullYear();
      const mo = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      return `${y}-${mo}-${day}`;
    }
    return '';
  }
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return '';
    const y = value.getFullYear();
    const mo = String(value.getMonth() + 1).padStart(2, '0');
    const day = String(value.getDate()).padStart(2, '0');
    return `${y}-${mo}-${day}`;
  }
  return '';
}
