/** Gợi ý «cần chờ thêm vài nến» — chưa phải tín hiệu xác nhận, chỉ heuristics. */
export interface FormingSetupHint {
  code: string;
  direction: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  /** Ưu tiên hiển thị (cao hơn = đáng chú ý hơn) */
  priority: number;
  etaMin: number;
  etaMax: number;
  summary: string;
}

export interface TickerFormingSetups {
  ticker: string;
  tradingDate: string;
  hints: FormingSetupHint[];
}
