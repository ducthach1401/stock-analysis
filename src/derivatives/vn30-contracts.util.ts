import { vnCalendarTodayYmd } from '../common/vn-trading-days';

export type Vn30FuturesContractMeta = {
  /** Ví dụ 2026-04 — tháng niêm yết */
  id: string;
  /** Hiển thị tiếng Việt */
  labelVi: string;
  /** Ngày đáo hạn tham chiếu (thứ Năm thứ 3 của tháng, theo múi VN) */
  expiryYmd: string;
};

/**
 * Thứ Năm thứ ba của tháng (chuẩn tham chiếu kỳ hạn VN30 thường gặp).
 * So sánh ngày theo chuỗi YYYY-MM-DD (Asia/Ho_Chi_Minh).
 */
export function thirdThursdayOfMonthYmd(
  year: number,
  month: number,
): string | null {
  let thCount = 0;
  for (let dom = 1; dom <= 31; dom++) {
    const iso = `${year}-${String(month).padStart(2, '0')}-${String(dom).padStart(2, '0')}`;
    const dt = new Date(`${iso}T12:00:00+07:00`);
    if (dt.getMonth() + 1 !== month) break;
    if (dt.getDay() !== 4) continue;
    thCount++;
    if (thCount === 3) {
      const y = dt.getFullYear();
      const m = String(dt.getMonth() + 1).padStart(2, '0');
      const d = String(dt.getDate()).padStart(2, '0');
      return `${y}-${m}-${d}`;
    }
  }
  return null;
}

function addMonth(y: number, m: number): [number, number] {
  if (m === 12) return [y + 1, 1];
  return [y, m + 1];
}

/**
 * Các kỳ hạn VN30 sắp tới (theo tháng), dùng chọn HĐTL gần nhất trên UI.
 * Giá OHLC vẫn lấy từ chỉ số VN30 (API công khai không có từng mã HĐTL).
 */
export function listUpcomingVn30FuturesContracts(
  max = 8,
  todayYmd: string = vnCalendarTodayYmd(),
): Vn30FuturesContractMeta[] {
  const segs = todayYmd.split('-');
  const y0 = Number(segs[0]);
  const m0 = Number(segs[1]);
  if (!Number.isFinite(y0) || !Number.isFinite(m0)) {
    return [];
  }
  let y = y0;
  let m = m0;
  const out: Vn30FuturesContractMeta[] = [];

  for (let i = 0; i < 36 && out.length < max; i++) {
    const exp = thirdThursdayOfMonthYmd(y, m);
    if (exp && exp >= todayYmd) {
      const id = `${y}-${String(m).padStart(2, '0')}`;
      const [yy, mm, dd] = exp.split('-');
      out.push({
        id,
        expiryYmd: exp,
        labelVi: `VN30 — kỳ đáo hạn ${dd}/${mm}/${yy} (T5 tuần 3)`,
      });
    }
    [y, m] = addMonth(y, m);
  }

  return out;
}

export function nearestVn30FuturesContract(
  todayYmd?: string,
): Vn30FuturesContractMeta | null {
  const list = listUpcomingVn30FuturesContracts(
    1,
    todayYmd ?? vnCalendarTodayYmd(),
  );
  return list[0] ?? null;
}

/**
 * True khi `ymd` nằm trong "cửa sổ roll" của VN30F1M: chính ngày đáo hạn (T5 tuần 3 —
 * hợp đồng cũ hội tụ về spot, dễ nhiễu khi settle) HOẶC ngày lịch kế tiếp (T6 — F1M đã nhảy
 * sang tháng mới nên chuỗi nến 120-bar còn chứa gap giá giữa 2 hợp đồng, làm méo EMA/ATR/RSI/break).
 * Dùng để chặn mở lệnh mới trong cửa sổ này (xem gate trong derivatives.service.ts).
 */
export function isVn30FuturesRollWindow(
  ymd: string = vnCalendarTodayYmd(),
): boolean {
  const [y, m] = ymd.split('-').map(Number);
  if (!Number.isFinite(y) || !Number.isFinite(m)) return false;
  const expiry = thirdThursdayOfMonthYmd(y, m);
  if (!expiry) return false;
  if (ymd === expiry) return true;
  // Ngày lịch kế tiếp sau đáo hạn (thường là T6) — gap roll vẫn còn trong cửa sổ lookback.
  const next = new Date(`${expiry}T12:00:00+07:00`);
  next.setDate(next.getDate() + 1);
  const yy = next.getFullYear();
  const mm = String(next.getMonth() + 1).padStart(2, '0');
  const dd = String(next.getDate()).padStart(2, '0');
  return ymd === `${yy}-${mm}-${dd}`;
}
