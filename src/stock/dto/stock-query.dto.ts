export class StockHistoryQueryDto {
  ticker: string;
  from?: string; // YYYY-MM-DD, default 1 year ago
  to?: string; // YYYY-MM-DD, default today
}

export class StockPriceResponseDto {
  ticker: string;
  tradingDate: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  foreignBuyVolume: number | null;
  foreignSellVolume: number | null;
}

export interface TcbsTradingData {
  ticker: string;
  lastPrice: number;
  priceChange: number;
  priceChangeRatio: number;
  highPrice: number;
  lowPrice: number;
  totalVolume: number;
  foreignBuyVolume: number;
  foreignSellVolume: number;
  marketCap: number;
}
