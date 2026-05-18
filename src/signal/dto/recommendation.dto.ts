export enum Recommendation {
  STRONG_BUY = 'STRONG_BUY',
  BUY = 'BUY',
  HOLD = 'HOLD',
  SELL = 'SELL',
  STRONG_SELL = 'STRONG_SELL',
}

export interface SignalWeight {
  type: string;
  direction: string;
  weight: number;
  description: string | null;
}

/** Điểm tham chiếu trên mô hình giá (đỉnh/đáy/neckline) */
export interface PatternLevel {
  role: string;
  /** Giá (đồng) */
  price: number;
  /** Ngày giao dịch của nến tham chiếu (YYYY-MM-DD), nếu có */
  date?: string;
}

export interface PriceTarget {
  currentPrice: number; // Giá đóng cửa gần nhất
  /** Giá đóng cửa phiên tín hiệu — trùng logic mở vị thế (`dayBar.close` / `currentPrice`). */
  entryPrice: number;
  /** Mức giá gợi ý (limit / nền / giá break — tùy `suggestedPullbackMode`). */
  suggestedPullbackPrice: number;
  /** Câu giải thích ngắn (tiếng Việt) vì sao limit gợi ý bằng mức đó. */
  suggestedPullbackNote: string;
  /**
   * `pullback` — HOLD: max đáy 20p / đóng−0,3×ATR.
   * `dip_rally_ma20` — MUA: đã thấy pha chạm EMA20 + rút chân + đóng trên MA → mua theo xác nhận phiên.
   * `dip_rally_retest` — MUA: retest cản đã break rồi bật → mua theo xác nhận.
   * `wait_retest_break` — có break kháng cự nhưng chưa thấy retest + nến bật → chờ pha đó.
   * `wait_dip_rally` — có tín hiệu mua, chờ **một pha** backtest kiểu giảm–tăng (MA20 hoặc retest), không cố định «chờ nền 20p».
   * `wait_base` / `breakout_entry` — tương thích dữ liệu cũ.
   * `support_base` — khi bán: tham chiếu mua lại = đáy 20p.
   */
  suggestedPullbackMode:
    | 'pullback'
    | 'dip_rally_ma20'
    | 'dip_rally_retest'
    | 'wait_retest_break'
    | 'wait_dip_rally'
    | 'wait_base'
    | 'breakout_entry'
    | 'support_base';
  targetPrice: number; // Giá chốt lời
  /** Stop Minervini tham chiếu (~7% dưới entry). */
  stopLoss: number | null;
  /** R:R Minervini = lợi nhuận mục tiêu / rủi ro tới stop. */
  riskReward: number;
  upside: number; // % lãi kỳ vọng nếu đúng
  downside: number; // 0 khi không dùng SL
  atr: number; // ATR 14 phiên (đo độ biến động)
  support: number; // Vùng hỗ trợ (low 20 phiên)
  resistance: number; // Vùng kháng cự (high 20 phiên)
  /**
   * Giá hiện tại đang nằm quanh nền (đáy 20p) — UI hiển thị vùng nền ở cột giá mua cho dễ đọc.
   * Khi có, dùng `baseZoneLow` / `baseZoneHigh` làm dải tham chiếu.
   */
  priceAtBase?: boolean;
  baseZoneLow?: number;
  baseZoneHigh?: number;
}

export interface RecommendationResult {
  ticker: string;
  tradingDate: string;
  recommendation: Recommendation;
  score: number;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  priceTarget: PriceTarget | null;
  /** Mô hình giá (2 đỉnh / 2 đáy / cốc tay cầm) + bối cảnh RSI·MACD·KL — null nếu không nhận dạng */
  patternSummary: string | null;
  /** Đỉnh/đáy/neckline cụ thể khi có mô hình — để hiển thị danh sách */
  patternLevels: PatternLevel[] | null;
  bullishSignals: SignalWeight[];
  bearishSignals: SignalWeight[];
  neutralSignals: SignalWeight[];
  reasoning: string;
  action: string;
}

/**
 * Chỉ mở vị thế tự động khi **STRONG_BUY** Strict Minervini.
 * `BUY` là setup theo dõi/chờ breakout, không mở vị thế tự động.
 */
export function shouldOpenLivePosition(r: RecommendationResult): boolean {
  return r.recommendation === Recommendation.STRONG_BUY;
}
