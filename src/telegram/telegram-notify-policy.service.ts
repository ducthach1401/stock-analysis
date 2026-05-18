import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { vnCalendarTodayYmd } from '../common/vn-trading-days';

export type TelegramNotifyProfile = 'balanced' | 'strict' | 'full';

export type TelegramNotifyType =
  | 'startup'
  | 'recommend_summary'
  | 'recommend_manual'
  | 'position_close'
  | 'position_track'
  | 'breakout_intraday'
  | 'breakout_close_confirm'
  | 'signal_notify'
  | 'stock_alert';

export interface TelegramNotifyDecisionInput {
  type: TelegramNotifyType;
  force?: boolean;
  dedupeKey?: string;
  ticker?: string;
}

type DailyCounterKey = 'recommend' | 'positionTrack' | 'breakoutConfirm';

@Injectable()
export class TelegramNotifyPolicyService {
  private readonly logger = new Logger(TelegramNotifyPolicyService.name);

  private readonly dedupe = new Set<string>();
  private dedupeDate = vnCalendarTodayYmd();

  private countersDate = vnCalendarTodayYmd();
  private counters: Record<DailyCounterKey, number> = {
    recommend: 0,
    positionTrack: 0,
    breakoutConfirm: 0,
  };

  constructor(private readonly config: ConfigService) {}

  profile(): TelegramNotifyProfile {
    const raw =
      this.config.get<string>('TELEGRAM_NOTIFY_PROFILE', 'balanced') ??
      'balanced';
    if (raw === 'strict' || raw === 'full' || raw === 'balanced') return raw;
    return 'balanced';
  }

  shouldSend(input: TelegramNotifyDecisionInput): boolean {
    this.rotateDailyStateIfNeeded();
    if (input.force) return true;
    const type = input.type;
    const profile = this.profile();
    const dedupeKey = this.dedupeKeyFor(type, input);

    if (!this.isTypeEnabledByProfile(type, profile)) return false;
    if (!this.isTypeEnabledByFlag(type)) return false;
    if (!this.passDedupeCheckOnly(type, dedupeKey)) return false;
    if (!this.passDailyCap(type)) return false;
    this.commitDedupeKey(dedupeKey);
    return true;
  }

  private isTypeEnabledByProfile(
    type: TelegramNotifyType,
    profile: TelegramNotifyProfile,
  ): boolean {
    if (profile === 'full') return true;
    if (profile === 'strict') {
      return (
        type === 'recommend_summary' ||
        type === 'recommend_manual' ||
        type === 'position_close' ||
        type === 'breakout_close_confirm'
      );
    }
    // balanced
    return (
      type === 'recommend_summary' ||
      type === 'recommend_manual' ||
      type === 'position_close' ||
      type === 'breakout_close_confirm' ||
      type === 'position_track'
    );
  }

  private isTypeEnabledByFlag(type: TelegramNotifyType): boolean {
    const key = {
      startup: 'TELEGRAM_NOTIFY_ENABLE_STARTUP',
      recommend_summary: 'TELEGRAM_NOTIFY_ENABLE_RECOMMEND_SUMMARY',
      recommend_manual: 'TELEGRAM_NOTIFY_ENABLE_RECOMMEND_MANUAL',
      position_close: 'TELEGRAM_NOTIFY_ENABLE_POSITION_CLOSE',
      position_track: 'TELEGRAM_NOTIFY_ENABLE_POSITION_TRACK',
      breakout_intraday: 'TELEGRAM_NOTIFY_ENABLE_BREAKOUT_INTRADAY',
      breakout_close_confirm: 'TELEGRAM_NOTIFY_ENABLE_BREAKOUT_CLOSE_CONFIRM',
      signal_notify: 'TELEGRAM_NOTIFY_ENABLE_SIGNAL_NOTIFY',
      stock_alert: 'TELEGRAM_NOTIFY_ENABLE_STOCK_ALERT',
    }[type];
    const raw = this.config.get<string>(key, 'true') ?? 'true';
    return raw !== 'false';
  }

  private passDailyCap(type: TelegramNotifyType): boolean {
    const counterKey = this.counterKeyForType(type);
    if (!counterKey) return true;
    const cap = this.dailyCapForCounter(counterKey);
    if (cap <= 0) return true;
    if (this.counters[counterKey] >= cap) {
      this.logger.warn(
        `Drop Telegram ${type}: vượt cap ngày ${cap} (${counterKey})`,
      );
      return false;
    }
    this.counters[counterKey] += 1;
    return true;
  }

  private counterKeyForType(type: TelegramNotifyType): DailyCounterKey | null {
    if (type === 'recommend_summary' || type === 'recommend_manual') {
      return 'recommend';
    }
    if (type === 'position_track') return 'positionTrack';
    if (type === 'breakout_close_confirm') return 'breakoutConfirm';
    return null;
  }

  private dailyCapForCounter(key: DailyCounterKey): number {
    const envKey = {
      recommend: 'MAX_RECOMMEND_MSG_PER_DAY',
      positionTrack: 'MAX_POSITION_TRACK_MSG_PER_DAY',
      breakoutConfirm: 'MAX_BREAKOUT_CONFIRM_MSG_PER_DAY',
    }[key];
    const fallback = { recommend: '2', positionTrack: '1', breakoutConfirm: '20' }[
      key
    ];
    const raw = this.config.get<string>(envKey, fallback) ?? fallback;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n >= 0 ? n : parseInt(fallback, 10);
  }

  private dedupeKeyFor(
    type: TelegramNotifyType,
    input: TelegramNotifyDecisionInput,
  ): string | null {
    return input.dedupeKey
      ? `${vnCalendarTodayYmd()}|${type}|${input.dedupeKey}`
      : null;
  }

  private passDedupeCheckOnly(
    type: TelegramNotifyType,
    key: string | null,
  ): boolean {
    if (!key) return true;
    if (this.dedupe.has(key)) {
      this.logger.debug(`Drop Telegram ${type}: duplicate (${key})`);
      return false;
    }
    return true;
  }

  private commitDedupeKey(key: string | null): void {
    if (!key) return;
    this.dedupe.add(key);
  }

  private rotateDailyStateIfNeeded(): void {
    const today = vnCalendarTodayYmd();
    if (today !== this.dedupeDate) {
      this.dedupe.clear();
      this.dedupeDate = today;
    }
    if (today !== this.countersDate) {
      this.counters = { recommend: 0, positionTrack: 0, breakoutConfirm: 0 };
      this.countersDate = today;
    }
  }
}
