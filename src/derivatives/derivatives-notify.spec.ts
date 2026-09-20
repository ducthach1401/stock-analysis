import { DerivativesService } from './derivatives.service';
import {
  DerivativeDecision,
  DerivativeDecisionAction,
  DerivativeDecisionStatus,
} from './entities/derivative-decision.entity';

type Internals = {
  shouldNotify(d: DerivativeDecision, force?: boolean): Promise<boolean>;
  retryOpenNotification(d: DerivativeDecision, source: string): Promise<void>;
};

function makeService(env: Record<string, string> = {}) {
  const sendMessage = jest.fn().mockResolvedValue(true);
  const update = jest.fn().mockResolvedValue(undefined);
  const getOne = jest.fn().mockResolvedValue(null);
  const qb = {
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    getOne,
  };
  const decisionRepo = { update, createQueryBuilder: jest.fn(() => qb) };
  const config = {
    get: (key: string, fallback?: string) => env[key] ?? fallback,
  };
  const service = new DerivativesService(
    decisionRepo as never,
    {} as never,
    { sendMessage } as never,
    config as never,
  );
  return { service: service as unknown as Internals, sendMessage, update, qb };
}

function decision(over: Partial<DerivativeDecision> = {}): DerivativeDecision {
  return {
    id: 10,
    symbol: 'VN30F1M',
    action: DerivativeDecisionAction.LONG,
    status: DerivativeDecisionStatus.OPEN,
    decidedAt: new Date(),
    entryPrice: 1900,
    stopLoss: 1895,
    takeProfit: 1910,
    riskReward: 1.67,
    score: 5,
    confidence: 55,
    reason: 'test',
    notified: false,
    ...over,
  } as DerivativeDecision;
}

describe('DerivativesService open-position notification', () => {
  it('always notifies a newly opened LONG/SHORT without consulting earlier rows', async () => {
    const { service, qb } = makeService();

    await expect(service.shouldNotify(decision())).resolves.toBe(true);
    await expect(
      service.shouldNotify(
        decision({ action: DerivativeDecisionAction.SHORT }),
      ),
    ).resolves.toBe(true);
    expect(qb.getOne).not.toHaveBeenCalled();
  });

  it('respects DERIVATIVES_TELEGRAM_NOTIFY=false', async () => {
    const { service } = makeService({ DERIVATIVES_TELEGRAM_NOTIFY: 'false' });

    await expect(service.shouldNotify(decision())).resolves.toBe(false);
  });

  it('looks up the previous decision by id, not by decidedAt', async () => {
    const { service, qb } = makeService();

    await service.shouldNotify(
      decision({ action: DerivativeDecisionAction.NO_TRADE }),
      false,
    );

    expect(qb.andWhere).toHaveBeenCalledWith('d.id < :id', { id: 10 });
    expect(qb.orderBy).toHaveBeenCalledWith('d.id', 'DESC');
  });

  it('resends the open message when the first send failed and the trade is fresh', async () => {
    const { service, sendMessage, update } = makeService();

    await service.retryOpenNotification(decision(), 'cron');

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith(10, { notified: true });
  });

  it('does not resend when already notified or too old', async () => {
    const { service, sendMessage, update } = makeService();

    await service.retryOpenNotification(decision({ notified: true }), 'cron');
    await service.retryOpenNotification(
      decision({ decidedAt: new Date(Date.now() - 16 * 60 * 1000) }),
      'cron',
    );

    expect(sendMessage).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });
});
