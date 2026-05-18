import { ConfigService } from '@nestjs/config';
import { TelegramNotifyPolicyService } from './telegram-notify-policy.service';

function makeService(env: Record<string, string>): TelegramNotifyPolicyService {
  const cfg = {
    get: (k: string, d?: string) => (k in env ? env[k] : d),
  } as unknown as ConfigService;
  return new TelegramNotifyPolicyService(cfg);
}

describe('TelegramNotifyPolicyService', () => {
  it('balanced: cho phép recommend/close/track/close-confirm; chặn intraday/startup/signal/stock', () => {
    const svc = makeService({ TELEGRAM_NOTIFY_PROFILE: 'balanced' });
    expect(svc.shouldSend({ type: 'recommend_summary' })).toBe(true);
    expect(svc.shouldSend({ type: 'recommend_manual' })).toBe(true);
    expect(svc.shouldSend({ type: 'position_close' })).toBe(true);
    expect(svc.shouldSend({ type: 'position_track' })).toBe(true);
    expect(svc.shouldSend({ type: 'breakout_close_confirm' })).toBe(true);
    expect(svc.shouldSend({ type: 'breakout_intraday' })).toBe(false);
    expect(svc.shouldSend({ type: 'startup' })).toBe(false);
    expect(svc.shouldSend({ type: 'signal_notify' })).toBe(false);
    expect(svc.shouldSend({ type: 'stock_alert' })).toBe(false);
  });

  it('force cho phép bỏ qua profile/flag/cap', () => {
    const svc = makeService({
      TELEGRAM_NOTIFY_PROFILE: 'balanced',
      TELEGRAM_NOTIFY_ENABLE_STARTUP: 'false',
      MAX_RECOMMEND_MSG_PER_DAY: '0',
    });
    expect(svc.shouldSend({ type: 'startup', force: true })).toBe(true);
    expect(svc.shouldSend({ type: 'recommend_summary', force: true })).toBe(
      true,
    );
  });

  it('dedupe: cùng key trong ngày chỉ gửi 1 lần', () => {
    const svc = makeService({ TELEGRAM_NOTIFY_PROFILE: 'full' });
    expect(
      svc.shouldSend({ type: 'breakout_close_confirm', dedupeKey: 'AAA|2026-01-01' }),
    ).toBe(true);
    expect(
      svc.shouldSend({ type: 'breakout_close_confirm', dedupeKey: 'AAA|2026-01-01' }),
    ).toBe(false);
  });

  it('duplicate không ăn quota cap', () => {
    const svc = makeService({
      TELEGRAM_NOTIFY_PROFILE: 'full',
      MAX_RECOMMEND_MSG_PER_DAY: '2',
    });
    expect(
      svc.shouldSend({
        type: 'recommend_summary',
        dedupeKey: 'same-key',
      }),
    ).toBe(true);
    expect(
      svc.shouldSend({
        type: 'recommend_summary',
        dedupeKey: 'same-key',
      }),
    ).toBe(false);
    // Nếu duplicate đã không ăn cap, key mới vẫn phải được gửi
    expect(
      svc.shouldSend({
        type: 'recommend_summary',
        dedupeKey: 'new-key',
      }),
    ).toBe(true);
  });

  it('cap: chặn khi vượt giới hạn ngày', () => {
    const svc = makeService({
      TELEGRAM_NOTIFY_PROFILE: 'full',
      MAX_RECOMMEND_MSG_PER_DAY: '1',
    });
    expect(svc.shouldSend({ type: 'recommend_summary' })).toBe(true);
    expect(svc.shouldSend({ type: 'recommend_summary' })).toBe(false);
  });
});
