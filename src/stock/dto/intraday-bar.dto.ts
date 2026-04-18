/** Nến chỉ số từ Entrade (không lưu DB): 5m/15m/1H/4H/1D — giá ×1000 giống stock_prices. */
export interface IntradayIndexBarDto {
  ticker: string;
  /** Unix timestamp (giây), theo mốc API */
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}
