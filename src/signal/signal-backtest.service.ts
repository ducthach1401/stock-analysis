import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, Not, Repository } from 'typeorm';
import { StockPrice } from '../stock/entities/stock-price.entity';
import { Recommendation } from './dto/recommendation.dto';
import { BacktestRun } from './entities/backtest-run.entity';
import { Signal } from './entities/signal.entity';
import { SimulatedTrade } from './entities/simulated-trade.entity';
import type { AverageDownLeg } from '../position/entities/position.entity';
import {
  allowsAverageDownFromSignals,
  allowsFirstPositionEntryFromSignals,
  averageReasonLabelFromSignals,
  firstLegPriceFromWeightedAverage,
  weightedEntryAfterAverageDown,
} from '../position/averaging-policy';
import {
  PROFIT_RUN_PCT,
  effectiveProfitFloorPnl,
} from '../common/position-profit-run';
import { MIN_TRADING_SESSIONS_AFTER_ENTRY } from '../common/vn-trading-days';
import {
  calcPriceTargetForFixedEntry,
  POSITION_MIN_UPSIDE_PCT,
  RecommendationService,
} from './recommendation.service';

/** Giả lập T+2: ít nhất 2 phiên (nến) sau ngày mua mới được bán. */
function canExitAfterT2(
  entryBarIndex: number,
  currentBarIndex: number,
): boolean {
  return currentBarIndex - entryBarIndex >= MIN_TRADING_SESSIONS_AFTER_ENTRY;
}

function addCalendarMonths(isoDate: string, deltaMonths: number): string {
  const d = new Date(isoDate + 'T12:00:00');
  d.setMonth(d.getMonth() + deltaMonths);
  return d.toISOString().slice(0, 10);
}

function mapBars(history: StockPrice[]) {
  return history.map((b) => ({
    open: Number(b.open),
    high: Number(b.high),
    low: Number(b.low),
    close: Number(b.close),
  }));
}

/**
 * Target từ giá vào — tối thiểu 20% (cùng vị thế thật). Không dùng SL.
 */
function targetsForWeightedEntry(
  history: StockPrice[],
  weightedEntry: number,
): { takeProfitTarget: number | null; stopLossAtEntry: null } {
  if (history.length < 20) {
    return { takeProfitTarget: null, stopLossAtEntry: null };
  }
  const tgs = calcPriceTargetForFixedEntry(weightedEntry, mapBars(history), {
    minUpsidePct: POSITION_MIN_UPSIDE_PCT,
  });
  return {
    takeProfitTarget: tgs.targetPrice,
    stopLossAtEntry: null,
  };
}

/** Một dòng cho bảng xếp hạng backtest trên Dashboard (run mới nhất / mã). */
export interface BacktestRunSummaryRow {
  ticker: string;
  compoundPnlPercent: number;
  sumPnlPercent: number;
  tradeCount: number;
  winCount: number;
  periodFrom: string;
  periodTo: string;
  createdAt: string;
}

/** Hiển thị: lệnh đóng gần đây nhất trước (ngày ra ↓, rồi ngày vào ↓). */
function sortSimulatedTradesNewestFirst(trades: SimulatedTrade[]): void {
  trades.sort((a, b) => {
    const byExit = String(b.exitDate).localeCompare(String(a.exitDate));
    if (byExit !== 0) return byExit;
    return String(b.entryDate).localeCompare(String(a.entryDate));
  });
}

@Injectable()
export class SignalBacktestService {
  private readonly logger = new Logger(SignalBacktestService.name);

  constructor(
    @InjectRepository(BacktestRun)
    private readonly runRepo: Repository<BacktestRun>,
    @InjectRepository(SimulatedTrade)
    private readonly tradeRepo: Repository<SimulatedTrade>,
    @InjectRepository(Signal)
    private readonly signalRepo: Repository<Signal>,
    @InjectRepository(StockPrice)
    private readonly stockRepo: Repository<StockPrice>,
    private readonly recommendationService: RecommendationService,
  ) {}

  /**
   * Giống vị thế thật: vào khi **STRONG_BUY + nền/break**; **TB giá** khi lỗ + nền/hồi phục;
   * TP ≥ **20%** từ giá TB (hoặc cao hơn nếu kháng cự/ATR). **Không SL.**
   * Thoát: chặn lãi (sàn tối thiểu ~20%, nâng theo đỉnh) khi quay đầu → target (lãi &lt;20%) sau T+2 → cuối kỳ (không đóng theo đảo chiều).
   */
  async runBacktest(
    ticker: string,
    monthsBack = 12,
  ): Promise<BacktestRun & { trades: SimulatedTrade[] }> {
    const t = ticker.toUpperCase();
    const latest = await this.stockRepo.findOne({
      where: { ticker: t },
      order: { tradingDate: 'DESC' },
    });
    if (!latest) {
      throw new BadRequestException(`${t}: chưa có dữ liệu giá`);
    }

    const periodTo = latest.tradingDate;
    const periodFrom = addCalendarMonths(periodTo, -monthsBack);

    const bars = await this.stockRepo.find({
      where: { ticker: t, tradingDate: Between(periodFrom, periodTo) },
      order: { tradingDate: 'ASC' },
    });
    if (bars.length < 20) {
      throw new BadRequestException(
        `${t}: quá ít nến trong khoảng (${bars.length}), cần phân tích lịch sử tín hiệu trước`,
      );
    }

    const signals = await this.signalRepo.find({
      where: { ticker: t, tradingDate: Between(periodFrom, periodTo) },
      order: { tradingDate: 'ASC' },
    });
    const byDate = new Map<string, Signal[]>();
    for (const s of signals) {
      const list = byDate.get(s.tradingDate) ?? [];
      list.push(s);
      byDate.set(s.tradingDate, list);
    }

    type Draft = {
      entryDate: string;
      entryPrice: number;
      entryRecommendation: Recommendation;
      entryStrength: string | null;
      entryReason: string | null;
      averageDownCount: number;
      averageDownLegs: AverageDownLeg[] | null;
      takeProfitTarget: number | null;
      stopLossAtEntry: number | null;
      exitDate: string;
      exitPrice: number;
      exitRecommendation: string;
      exitSellStrength: string | null;
      exitReason: string | null;
      pnlPercent: number;
    };

    const closed: Draft[] = [];
    let pos: {
      entryDate: string;
      entryBarIndex: number;
      entryPrice: number;
      entryRecommendation: Recommendation;
      entryStrength: string | null;
      entryReason: string | null;
      takeProfitTarget: number | null;
      stopLossAtEntry: number | null;
      /** Số lần mua thêm (trung bình giá). */
      averageLegCount: number;
      averageDownLegs: AverageDownLeg[];
      /** Đỉnh giá (đóng cửa) để chặn lãi khi quay đầu */
      peakClose: number;
    } | null = null;

    for (let i = 0; i < bars.length; i++) {
      const bar = bars[i];
      const history = bars.slice(0, i + 1);
      const daySignals = byDate.get(bar.tradingDate) ?? [];
      const ev = this.recommendationService.evaluateSignals(daySignals);
      const rec = ev.recommendation;
      const close = Number(bar.close);

      if (pos) {
        pos.peakClose = Math.max(pos.peakClose, close);
        const curPnlPct = ((close - pos.entryPrice) / pos.entryPrice) * 100;
        const peakPnlPct =
          ((pos.peakClose - pos.entryPrice) / pos.entryPrice) * 100;
        const floorPnlPct = effectiveProfitFloorPnl(
          pos.entryPrice,
          pos.peakClose,
        );
        const hitProfitFloor =
          peakPnlPct > PROFIT_RUN_PCT && curPnlPct <= floorPnlPct;

        if (hitProfitFloor) {
          const pnlPercent = ((close - pos.entryPrice) / pos.entryPrice) * 100;
          closed.push({
            entryDate: pos.entryDate,
            entryPrice: pos.entryPrice,
            entryRecommendation: pos.entryRecommendation,
            entryStrength: pos.entryStrength,
            entryReason: pos.entryReason,
            averageDownCount: pos.averageLegCount,
            averageDownLegs: pos.averageDownLegs.length
              ? [...pos.averageDownLegs]
              : null,
            takeProfitTarget: pos.takeProfitTarget,
            stopLossAtEntry: pos.stopLossAtEntry,
            exitDate: bar.tradingDate,
            exitPrice: close,
            exitRecommendation: 'PROFIT_FLOOR_20',
            exitSellStrength: null,
            exitReason: `Chặn lãi (sàn ~${floorPnlPct.toFixed(1)}%, đỉnh ~${peakPnlPct.toFixed(1)}%) — đóng ${close.toLocaleString('vi-VN')}`,
            pnlPercent: Number(pnlPercent.toFixed(4)),
          });
          pos = null;
          continue;
        }

        const t2Ok = canExitAfterT2(pos.entryBarIndex, i);
        if (
          t2Ok &&
          pos.takeProfitTarget != null &&
          curPnlPct < PROFIT_RUN_PCT &&
          close >= pos.takeProfitTarget
        ) {
          const pnlPercent = ((close - pos.entryPrice) / pos.entryPrice) * 100;
          const tp = pos.takeProfitTarget;
          closed.push({
            entryDate: pos.entryDate,
            entryPrice: pos.entryPrice,
            entryRecommendation: pos.entryRecommendation,
            entryStrength: pos.entryStrength,
            entryReason: pos.entryReason,
            averageDownCount: pos.averageLegCount,
            averageDownLegs: pos.averageDownLegs.length
              ? [...pos.averageDownLegs]
              : null,
            takeProfitTarget: pos.takeProfitTarget,
            stopLossAtEntry: pos.stopLossAtEntry,
            exitDate: bar.tradingDate,
            exitPrice: close,
            exitRecommendation: 'TARGET_HIT',
            exitSellStrength: null,
            exitReason: `Chốt mục tiêu ≥${tp.toLocaleString('vi-VN')}đ (sau T+2, đóng ${close.toLocaleString('vi-VN')})`,
            pnlPercent: Number(pnlPercent.toFixed(4)),
          });
          pos = null;
          continue;
        }
        if (
          allowsAverageDownFromSignals(
            daySignals,
            rec,
            pos.entryPrice,
            close,
            pos.averageLegCount,
          )
        ) {
          const newAvg = Math.round(
            weightedEntryAfterAverageDown(
              pos.entryPrice,
              pos.averageLegCount,
              close,
            ),
          );
          const { takeProfitTarget } = targetsForWeightedEntry(history, newAvg);
          if (takeProfitTarget != null) {
            pos.entryPrice = newAvg;
            pos.takeProfitTarget = takeProfitTarget;
            pos.stopLossAtEntry = null;
            pos.averageLegCount += 1;
            pos.peakClose = Math.max(newAvg, close);
            pos.averageDownLegs.push({
              date: bar.tradingDate,
              price: Math.round(close),
              reason: averageReasonLabelFromSignals(daySignals),
            });
          }
          continue;
        }
      } else if (allowsFirstPositionEntryFromSignals(daySignals, rec)) {
        const { takeProfitTarget } = targetsForWeightedEntry(history, close);
        if (takeProfitTarget == null) continue;
        pos = {
          entryDate: bar.tradingDate,
          entryBarIndex: i,
          entryPrice: close,
          entryRecommendation: rec,
          entryStrength: ev.buyStrength,
          entryReason: ev.reasoning,
          takeProfitTarget,
          stopLossAtEntry: null,
          averageLegCount: 0,
          averageDownLegs: [],
          peakClose: close,
        };
      }
    }

    if (pos && bars.length) {
      const last = bars[bars.length - 1];
      const close = Number(last.close);
      const pnlPercent = ((close - pos.entryPrice) / pos.entryPrice) * 100;
      closed.push({
        entryDate: pos.entryDate,
        entryPrice: pos.entryPrice,
        entryRecommendation: pos.entryRecommendation,
        entryStrength: pos.entryStrength,
        entryReason: pos.entryReason,
        averageDownCount: pos.averageLegCount,
        averageDownLegs: pos.averageDownLegs.length
          ? [...pos.averageDownLegs]
          : null,
        takeProfitTarget: pos.takeProfitTarget,
        stopLossAtEntry: pos.stopLossAtEntry,
        exitDate: last.tradingDate,
        exitPrice: close,
        exitRecommendation: 'END_OF_PERIOD',
        exitSellStrength: null,
        exitReason:
          'Cuối kỳ · đóng theo giá phiên cuối (cưỡng bức, có thể trước T+2)',
        pnlPercent: Number(pnlPercent.toFixed(4)),
      });
    }

    const sumPnl = closed.reduce((s, x) => s + x.pnlPercent, 0);
    const compound =
      (closed.reduce((acc, x) => acc * (1 + x.pnlPercent / 100), 1) - 1) * 100;
    const winCount = closed.filter((x) => x.pnlPercent > 0).length;

    const run = this.runRepo.create({
      ticker: t,
      periodFrom,
      periodTo,
      tradingDays: bars.length,
      tradeCount: closed.length,
      winCount,
      sumPnlPercent: Number(sumPnl.toFixed(4)),
      compoundPnlPercent: Number(compound.toFixed(4)),
      strongBuyEntryOnly: true,
      strongSellExitOnly: true,
      trades: closed.map((c) =>
        this.tradeRepo.create({
          entryDate: c.entryDate,
          entryPrice: c.entryPrice,
          entryRecommendation: c.entryRecommendation,
          entryStrength: c.entryStrength,
          entryReason: c.entryReason,
          averageDownCount: c.averageDownCount,
          averageDownLegs: c.averageDownLegs,
          takeProfitTarget: c.takeProfitTarget,
          stopLossAtEntry: c.stopLossAtEntry,
          exitDate: c.exitDate,
          exitPrice: c.exitPrice,
          exitRecommendation: c.exitRecommendation,
          exitSellStrength: c.exitSellStrength,
          exitReason: c.exitReason,
          pnlPercent: c.pnlPercent,
        }),
      ),
    });

    const saved = await this.runRepo.save(run);

    const del = await this.runRepo.delete({
      ticker: t,
      id: Not(saved.id),
    });
    if (del.affected && del.affected > 0) {
      this.logger.log(
        `${t}: đã xóa ${del.affected} backtest cũ — chỉ giữ run #${saved.id}`,
      );
    }

    this.logger.log(
      `${t} backtest ${periodFrom}→${periodTo}: ${closed.length} lệnh, Σ%=${sumPnl.toFixed(2)} compound=${compound.toFixed(2)}%`,
    );

    const full = await this.runRepo.findOne({
      where: { id: saved.id },
      relations: ['trades'],
    });
    if (!full) throw new Error('backtest save failed');
    if (full.trades?.length) sortSimulatedTradesNewestFirst(full.trades);
    return full as BacktestRun & { trades: SimulatedTrade[] };
  }

  async listRuns(ticker: string, take = 20): Promise<BacktestRun[]> {
    return this.runRepo.find({
      where: { ticker: ticker.toUpperCase() },
      order: { createdAt: 'DESC', id: 'DESC' },
      take,
    });
  }

  async getRun(
    ticker: string,
    runId: number,
  ): Promise<BacktestRun & { trades: SimulatedTrade[] }> {
    const run = await this.runRepo.findOne({
      where: { id: runId, ticker: ticker.toUpperCase() },
      relations: ['trades'],
    });
    if (!run) {
      throw new NotFoundException('Không tìm thấy backtest');
    }
    if (run.trades?.length) sortSimulatedTradesNewestFirst(run.trades);
    const trades = (run.trades ?? []).map((t) => {
      const ep = Number(t.entryPrice);
      const legs = t.averageDownLegs ?? [];
      const firstEntryPrice =
        legs.length > 0
          ? Math.round(firstLegPriceFromWeightedAverage(ep, legs))
          : ep;
      return { ...t, firstEntryPrice };
    });
    return { ...run, trades } as BacktestRun & {
      trades: (SimulatedTrade & { firstEntryPrice: number })[];
    };
  }

  /**
   * Run mới nhất mỗi mã (id giảm dần — lần đầu gặp ticker là bản mới nhất).
   */
  async listLatestRunPerTicker(): Promise<BacktestRun[]> {
    const all = await this.runRepo.find({ order: { id: 'DESC' } });
    const byTicker = new Map<string, BacktestRun>();
    for (const run of all) {
      if (!byTicker.has(run.ticker)) {
        byTicker.set(run.ticker, run);
      }
    }
    return [...byTicker.values()];
  }

  /**
   * Top / bottom theo **compound %** (lãi gộp giả lập) trên run mới nhất từng mã.
   */
  async getBacktestGoodBad(limit: number): Promise<{
    good: BacktestRunSummaryRow[];
    bad: BacktestRunSummaryRow[];
    total: number;
  }> {
    const runs = await this.listLatestRunPerTicker();
    const total = runs.length;
    const map = (x: BacktestRun): BacktestRunSummaryRow => ({
      ticker: x.ticker,
      compoundPnlPercent: Number(x.compoundPnlPercent),
      sumPnlPercent: Number(x.sumPnlPercent),
      tradeCount: x.tradeCount,
      winCount: x.winCount,
      periodFrom: x.periodFrom,
      periodTo: x.periodTo,
      createdAt:
        x.createdAt instanceof Date
          ? x.createdAt.toISOString()
          : String(x.createdAt),
    });
    if (total === 0) {
      return { good: [], bad: [], total: 0 };
    }
    const lim = Math.min(Math.max(1, limit), 50);
    const desc = [...runs].sort(
      (a, b) => Number(b.compoundPnlPercent) - Number(a.compoundPnlPercent),
    );
    const asc = [...runs].sort(
      (a, b) => Number(a.compoundPnlPercent) - Number(b.compoundPnlPercent),
    );
    return {
      good: desc.slice(0, lim).map(map),
      bad: asc.slice(0, lim).map(map),
      total,
    };
  }
}
