import { Recommendation } from './dto/recommendation.dto';
import {
  evaluateMinervini,
  MINERVINI_STOP_PCT,
  minerviniTargetPctFromEnv,
  type MinerviniBar,
} from './minervini-strategy';

function strictSetupBars(options?: {
  breakout?: boolean;
  volumeConfirm?: boolean;
  extended?: boolean;
}): MinerviniBar[] {
  const breakout = options?.breakout ?? true;
  const volumeConfirm = options?.volumeConfirm ?? true;
  const extended = options?.extended ?? false;
  const bars: MinerviniBar[] = [];

  for (let i = 0; i < 220; i++) {
    const close = 80 + i * 0.45;
    bars.push({
      open: close * 0.995,
      high: close * 1.01,
      low: close * 0.99,
      close,
      volume: 700_000,
      tradingDate: `2024-01-${String((i % 28) + 1).padStart(2, '0')}`,
    });
  }

  for (let i = 0; i < 30; i++) {
    const width = 9 - i * 0.18;
    const center = 184 + i * 0.05;
    bars.push({
      open: center - 0.5,
      high: center + width / 2,
      low: center - width / 2,
      close: center,
      volume: 650_000 - i * 6_000,
      tradingDate: `2025-01-${String((i % 28) + 1).padStart(2, '0')}`,
    });
  }

  const pivot = Math.max(...bars.slice(-30).map((b) => b.high));
  const close = extended
    ? pivot * 1.18
    : breakout
      ? pivot * 1.025
      : pivot * 0.99;
  bars.push({
    open: close * 0.985,
    high: close * 1.005,
    low: close * 0.98,
    close,
    volume: volumeConfirm ? 1_400_000 : 650_000,
    tradingDate: '2025-02-15',
  });

  return bars;
}

describe('evaluateMinervini', () => {
  const oldTarget = process.env.MINERVINI_TARGET_PCT;

  afterEach(() => {
    if (oldTarget == null) delete process.env.MINERVINI_TARGET_PCT;
    else process.env.MINERVINI_TARGET_PCT = oldTarget;
  });

  it('returns STRONG_BUY for trend template + VCP base + pivot breakout + volume + buy zone', () => {
    const e = evaluateMinervini(strictSetupBars());

    expect(e.recommendation).toBe(Recommendation.STRONG_BUY);
    expect(e.trendOk).toBe(true);
    expect(e.baseOk).toBe(true);
    expect(e.breakoutOk).toBe(true);
    expect(e.volumeOk).toBe(true);
    expect(e.buyZoneOk).toBe(true);
  });

  it('returns BUY when trend and base are valid but breakout is still pending', () => {
    const e = evaluateMinervini(strictSetupBars({ breakout: false }));

    expect(e.recommendation).toBe(Recommendation.BUY);
    expect(e.nearPivot).toBe(true);
    expect(e.breakoutOk).toBe(false);
  });

  it('does not return STRONG_BUY without volume confirmation', () => {
    const e = evaluateMinervini(strictSetupBars({ volumeConfirm: false }));

    expect(e.recommendation).not.toBe(Recommendation.STRONG_BUY);
    expect(e.volumeOk).toBe(false);
  });

  it('rejects breakouts that are too extended above MA50', () => {
    const e = evaluateMinervini(strictSetupBars({ extended: true }));

    expect(e.recommendation).toBe(Recommendation.HOLD);
    expect(e.extended).toBe(true);
  });

  it('uses 7% stop and target env with a 20% floor', () => {
    process.env.MINERVINI_TARGET_PCT = '10';
    const e = evaluateMinervini(strictSetupBars());
    const entry = strictSetupBars().at(-1)?.close ?? 0;

    expect(minerviniTargetPctFromEnv()).toBe(0.2);
    expect(e.stopLoss).toBe(Math.round(entry * (1 - MINERVINI_STOP_PCT)));
    expect(e.targetPrice).toBe(Math.round(entry * 1.2));
    expect(e.riskReward).toBeGreaterThan(2.5);
  });
});
