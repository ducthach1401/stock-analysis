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
