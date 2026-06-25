export const STOCK_QUEUE = 'stock-tasks';
export const DERIVATIVES_QUEUE = 'derivatives-tasks';

export const JobName = {
  SYNC_ALL: 'sync-all',
  SYNC_TICKER: 'sync-ticker',
  SCAN_ALL: 'scan-all',
  ANALYZE_HISTORY_ALL: 'analyze-history-all',
  ANALYZE_HISTORY_TICKER: 'analyze-history-ticker',
  BACKTEST_VN30: 'backtest-vn30',
} as const;

export type JobName = (typeof JobName)[keyof typeof JobName];

export interface JobProgress {
  done: number;
  total: number;
  current: string;
  percent: number;
}
