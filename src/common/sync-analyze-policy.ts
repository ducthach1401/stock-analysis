/**
 * `analyzeAllHistory` quét toàn bộ ngày — rất tốn CPU/DB. Sau sync tăng dần, nếu không có
 * nến mới (`saved === 0`) thì tín hiệu đã lưu vẫn đúng; chỉ cần `analyze()` phiên mới nhất.
 */
export function shouldRunAnalyzeAllHistoryAfterSync(opts: {
  /** `true` khi vừa `syncHistoryFull` */
  isFullPriceSync: boolean;
  /** `syncHistorySmart().mode` khi không full */
  smartMode?: string;
  /** `syncHistorySmart().saved` hoặc tương đương */
  savedBarCount: number;
}): boolean {
  if (opts.isFullPriceSync) return true;
  const mode = opts.smartMode ?? 'incremental';
  if (mode !== 'incremental') return true;
  return opts.savedBarCount > 0;
}
