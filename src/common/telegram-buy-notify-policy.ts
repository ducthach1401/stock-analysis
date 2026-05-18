import {
  Recommendation,
  RecommendationResult,
} from '../signal/dto/recommendation.dto';
import { SignalType } from '../signal/entities/signal.entity';

/** `all` = mọi MUA/STRONG_BUY như trước. `safe` = chỉ gợi ý chất lượng cao, thiên về nền dài / an toàn. */
export type TelegramBuyNotifyMode = 'all' | 'safe';

/** Mặc định `safe` — gọn, ít nhiễu. Đặt `TELEGRAM_BUY_NOTIFY_MODE=all` để gửi mọi MUA như trước. */
export function parseTelegramBuyNotifyMode(
  raw: string | undefined,
): TelegramBuyNotifyMode {
  const v = (raw ?? '').trim().toLowerCase();
  if (v === 'all') return 'all';
  return 'safe';
}

/**
 * Chế độ `safe`: chỉ đưa MUA lên Telegram khi
 * - STRONG_BUY Strict Minervini,
 * - độ tin cậy HIGH,
 * - và có đủ trend template + nền/VCP + breakout pivot.
 */
export function shouldIncludeBuyInTelegram(
  mode: TelegramBuyNotifyMode,
  result: RecommendationResult,
): boolean {
  if (mode === 'all') return true;
  if (result.recommendation !== Recommendation.STRONG_BUY) return false;
  if (result.confidence !== 'HIGH') return false;

  const bullishTypes = new Set(result.bullishSignals.map((s) => s.type));
  return (
    bullishTypes.has(SignalType.MINERVINI_TREND_TEMPLATE) &&
    bullishTypes.has(SignalType.MINERVINI_VCP_BASE) &&
    bullishTypes.has(SignalType.MINERVINI_PIVOT_BREAKOUT)
  );
}
