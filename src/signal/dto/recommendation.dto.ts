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

export interface PriceTarget {
  currentPrice: number; // Giá đóng cửa gần nhất
  entryPrice: number; // Vùng mua vào hợp lý
  targetPrice: number; // Giá chốt lời
  stopLoss: number; // Giá cắt lỗ
  riskReward: number; // Tỉ lệ lợi nhuận/rủi ro (R:R)
  upside: number; // % lãi kỳ vọng nếu đúng
  downside: number; // % lỗ tối đa nếu sai
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
  bullishSignals: SignalWeight[];
  bearishSignals: SignalWeight[];
  neutralSignals: SignalWeight[];
  reasoning: string;
  action: string;
}
