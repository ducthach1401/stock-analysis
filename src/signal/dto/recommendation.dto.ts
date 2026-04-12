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
  entryPrice: number; // Vùng mua vào hợp lý
  targetPrice: number; // Giá chốt lời
  /** Chiến lược ôm dài hạn — không đặt mức cắt lỗ tự động; luôn null. */
  stopLoss: number | null;
  /** R:R tham chiếu (lợi nhuận mục tiêu / 8% vốn) — không phải rủi ro SL. */
  riskReward: number;
  upside: number; // % lãi kỳ vọng nếu đúng
  downside: number; // 0 khi không dùng SL
  atr: number; // ATR 14 phiên (đo độ biến động)
  support: number; // Vùng hỗ trợ (low 20 phiên)
  resistance: number; // Vùng kháng cự (high 20 phiên)
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
 * Chỉ mở vị thế tự động khi **STRONG_BUY** (điểm tổng ≥ 6).
 * `BUY` + HIGH vẫn có thể là nhiễu (nhiều chỉ báo nhỏ chưa đủ xác nhận xu hướng).
 */
export function shouldOpenLivePosition(r: RecommendationResult): boolean {
  return r.recommendation === Recommendation.STRONG_BUY;
}
