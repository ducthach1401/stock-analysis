import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  isVnCashMarketSessionOpen,
  vnCalendarTodayYmd,
} from '../common/vn-trading-days';
import { IntradayIndexBarDto } from '../stock/dto/intraday-bar.dto';
import { StockService } from '../stock/stock.service';
import { TelegramService } from '../telegram/telegram.service';
import {
  DerivativeDecision,
  DerivativeDecisionAction,
  DerivativeDecisionMetadata,
  DerivativeDecisionOutcome,
  DerivativeDecisionStatus,
} from './entities/derivative-decision.entity';
import { nearestVn30FuturesContract } from './vn30-contracts.util';

const ALGORITHM = 'VN30_EMA_VWAP_RSI_ATR_5M_V1';
const LOOKBACK_BARS = 120;
const SETTLE_AFTER_BARS = 12;
const MIN_BARS = 60;
const ATR_PERIOD = 14;
const RISK_ATR_MULT = 1.2;
const REWARD_ATR_MULT = 2;

type IndicatorSnapshot = {
  close: number;
  ema9: number;
  ema21: number;
  emaSlope: number;
  rsi14: number | null;
  atr14: number | null;
  vwap: number;
  prevHigh12: number;
  prevLow12: number;
  volumeRatio20: number;
  latestTime: Date;
  tradingDate: string;
};

@Injectable()
export class DerivativesService {
  private readonly logger = new Logger(DerivativesService.name);
  private running = false;

  constructor(
    @InjectRepository(DerivativeDecision)
    private readonly decisionRepo: Repository<DerivativeDecision>,
    private readonly stockService: StockService,
    private readonly telegramService: TelegramService,
    private readonly config: ConfigService,
  ) {}

  // Quét nhanh hơn: mỗi 1 phút trong phiên để phản ứng mở/đóng lệnh sớm hơn.
  @Cron('* 9-14 * * 1-5', { timeZone: 'Asia/Ho_Chi_Minh' })
  async scheduledVn30FiveMinuteDecision(): Promise<void> {
    if (
      this.config.get<string>('DERIVATIVES_VN30_FIVE_MIN_SCAN', 'true') ===
      'false'
    ) {
      return;
    }
    if (!isVnCashMarketSessionOpen()) return;
    await this.scanVn30({ source: 'cron' });
  }

  async scanVn30(
    opts: { forceNotify?: boolean; source?: string } = {},
  ): Promise<{
    decision: DerivativeDecision | null;
    bars: number;
    skipped?: string;
  }> {
    if (this.running) {
      const latest = await this.latestDecision();
      if (latest) return { decision: latest, bars: 0 };
    }
    this.running = true;
    try {
      const bars = await this.fetchRecentFiveMinuteBars();
      if (opts.source === 'cron' && !this.latestBarIsToday(bars)) {
        this.logger.log('Phái sinh VN30: bỏ qua cron vì chưa có nến hôm nay');
        return {
          decision: await this.latestDecision(),
          bars: bars.length,
          skipped: 'NO_TODAY_BAR',
        };
      }
      await this.settleOpenDecisions(bars);
      const activeOpenDecision = await this.latestOpenDecision();
      if (activeOpenDecision) {
        this.logger.log(
          `Phái sinh VN30: giữ lệnh ${activeOpenDecision.action} @ ${activeOpenDecision.entryPrice ?? 'n/a'} (chưa đóng) — không mở lệnh mới`,
        );
        return {
          decision: activeOpenDecision,
          bars: bars.length,
          skipped: 'OPEN_DECISION_ACTIVE',
        };
      }
      const decision = this.makeDecision(bars);
      const saved = await this.decisionRepo.save(
        this.decisionRepo.create(decision),
      );
      const shouldNotify = await this.shouldNotify(saved, opts.forceNotify);
      if (shouldNotify) {
        await this.notifyDecision(saved, opts.source ?? 'manual');
        saved.notified = true;
        await this.decisionRepo.save(saved);
      }
      this.logger.log(
        `Phái sinh VN30 ${saved.action} score=${saved.score} conf=${saved.confidence}% @ ${saved.entryPrice ?? 'n/a'}`,
      );
      return { decision: saved, bars: bars.length };
    } catch (e) {
      this.logger.warn(`Phái sinh VN30 scan lỗi: ${(e as Error).message}`);
      throw e;
    } finally {
      this.running = false;
    }
  }

  async latestDecision(): Promise<DerivativeDecision | null> {
    return this.decisionRepo.findOne({
      where: { symbol: 'VN30' },
      order: { decidedAt: 'DESC' },
    });
  }

  private latestOpenDecision(): Promise<DerivativeDecision | null> {
    return this.decisionRepo.findOne({
      where: { symbol: 'VN30', status: DerivativeDecisionStatus.OPEN },
      order: { decidedAt: 'DESC' },
    });
  }

  async recentDecisions(limit = 50): Promise<DerivativeDecision[]> {
    const safeLimit = Math.min(Math.max(Math.floor(limit), 1), 200);
    return this.decisionRepo.find({
      where: { symbol: 'VN30' },
      order: { decidedAt: 'DESC' },
      take: safeLimit,
    });
  }

  private async fetchRecentFiveMinuteBars(): Promise<IntradayIndexBarDto[]> {
    const to = new Date();
    const from = new Date(to.getTime() - 10 * 24 * 60 * 60 * 1000);
    const bars = await this.stockService.fetchIntradayIndexOhlc(
      'VN30',
      '5',
      from.toISOString(),
      to.toISOString(),
    );
    return bars
      .filter((b) => this.isValidBar(b))
      .sort((a, b) => Number(a.time) - Number(b.time))
      .slice(-LOOKBACK_BARS);
  }

  private isValidBar(b: IntradayIndexBarDto): boolean {
    return [b.time, b.open, b.high, b.low, b.close].every((v) => {
      const n = Number(v);
      return Number.isFinite(n) && n > 0;
    });
  }

  private latestBarIsToday(bars: IntradayIndexBarDto[]): boolean {
    const latest = bars[bars.length - 1];
    if (!latest) return false;
    return this.vnDateFromUnix(Number(latest.time)) === vnCalendarTodayYmd();
  }

  private makeDecision(
    bars: IntradayIndexBarDto[],
  ): Omit<DerivativeDecision, 'id' | 'createdAt' | 'updatedAt'> {
    const fallbackTime = new Date();
    const insufficient = bars.length < MIN_BARS;
    const snapshot = insufficient ? null : this.indicators(bars);
    const latest = bars[bars.length - 1];
    const decidedAt = snapshot?.latestTime ?? fallbackTime;
    const tradingDate = snapshot?.tradingDate ?? vnCalendarTodayYmd();
    const contractCode = nearestVn30FuturesContract(tradingDate)?.id ?? null;

    if (!snapshot || snapshot.atr14 == null || snapshot.atr14 <= 0) {
      return {
        symbol: 'VN30',
        contractCode,
        decidedAt,
        tradingDate,
        resolution: '5',
        algorithm: ALGORITHM,
        action: DerivativeDecisionAction.NO_TRADE,
        status: DerivativeDecisionStatus.CLOSED,
        entryPrice: latest ? this.price(latest.close) : null,
        stopLoss: null,
        takeProfit: null,
        riskReward: null,
        score: 0,
        confidence: 0,
        reason: insufficient
          ? `Không vào lệnh: thiếu nến 5m (${bars.length}/${MIN_BARS}).`
          : 'Không vào lệnh: ATR chưa đủ tin cậy để đặt SL/TP.',
        metadata: this.metadata([], snapshot),
        exitAt: decidedAt,
        exitPrice: latest ? this.price(latest.close) : null,
        pnlPoints: 0,
        outcome: DerivativeDecisionOutcome.NO_TRADE,
        outcomeReason: 'NO_TRADE không tính P/L.',
        notified: false,
      };
    }

    const longChecks = [
      snapshot.close > snapshot.vwap,
      snapshot.ema9 > snapshot.ema21,
      snapshot.emaSlope > 0,
      snapshot.rsi14 != null && snapshot.rsi14 >= 52 && snapshot.rsi14 <= 72,
      snapshot.close > snapshot.prevHigh12 || snapshot.volumeRatio20 >= 1.15,
    ];
    const shortChecks = [
      snapshot.close < snapshot.vwap,
      snapshot.ema9 < snapshot.ema21,
      snapshot.emaSlope < 0,
      snapshot.rsi14 != null && snapshot.rsi14 >= 28 && snapshot.rsi14 <= 48,
      snapshot.close < snapshot.prevLow12 || snapshot.volumeRatio20 >= 1.15,
    ];
    const longScore = longChecks.filter(Boolean).length;
    const shortScore = shortChecks.filter(Boolean).length;
    const notes = this.explainSnapshot(snapshot);
    let action = DerivativeDecisionAction.NO_TRADE;
    let score = Math.max(longScore, shortScore);
    if (longScore >= 4 && longScore >= shortScore + 1) {
      action = DerivativeDecisionAction.LONG;
      notes.unshift(
        'LONG: giá trên VWAP, EMA9 dẫn EMA21 và động lượng đủ mạnh.',
      );
    } else if (shortScore >= 4 && shortScore >= longScore + 1) {
      action = DerivativeDecisionAction.SHORT;
      notes.unshift(
        'SHORT: giá dưới VWAP, EMA9 dưới EMA21 và động lượng nghiêng xuống.',
      );
    } else {
      score = longScore - shortScore;
      notes.unshift(
        `NO_TRADE: điểm LONG ${longScore}/5, SHORT ${shortScore}/5 chưa lệch đủ rõ.`,
      );
    }

    const entry = this.round2(snapshot.close);
    const stopLoss =
      action === DerivativeDecisionAction.LONG
        ? this.round2(entry - RISK_ATR_MULT * snapshot.atr14)
        : action === DerivativeDecisionAction.SHORT
          ? this.round2(entry + RISK_ATR_MULT * snapshot.atr14)
          : null;
    const takeProfit =
      action === DerivativeDecisionAction.LONG
        ? this.round2(entry + REWARD_ATR_MULT * snapshot.atr14)
        : action === DerivativeDecisionAction.SHORT
          ? this.round2(entry - REWARD_ATR_MULT * snapshot.atr14)
          : null;
    const confidence =
      action === DerivativeDecisionAction.NO_TRADE
        ? Math.min(55, 25 + Math.abs(longScore - shortScore) * 10)
        : Math.min(92, 45 + Math.max(longScore, shortScore) * 10);

    return {
      symbol: 'VN30',
      contractCode,
      decidedAt,
      tradingDate,
      resolution: '5',
      algorithm: ALGORITHM,
      action,
      status:
        action === DerivativeDecisionAction.NO_TRADE
          ? DerivativeDecisionStatus.CLOSED
          : DerivativeDecisionStatus.OPEN,
      entryPrice: entry,
      stopLoss,
      takeProfit,
      riskReward:
        action === DerivativeDecisionAction.NO_TRADE
          ? null
          : this.round2(REWARD_ATR_MULT / RISK_ATR_MULT),
      score,
      confidence,
      reason: notes.join(' '),
      metadata: this.metadata(notes, snapshot),
      exitAt: action === DerivativeDecisionAction.NO_TRADE ? decidedAt : null,
      exitPrice: action === DerivativeDecisionAction.NO_TRADE ? entry : null,
      pnlPoints: action === DerivativeDecisionAction.NO_TRADE ? 0 : null,
      outcome:
        action === DerivativeDecisionAction.NO_TRADE
          ? DerivativeDecisionOutcome.NO_TRADE
          : null,
      outcomeReason:
        action === DerivativeDecisionAction.NO_TRADE
          ? 'NO_TRADE không tính P/L.'
          : null,
      notified: false,
    };
  }

  private indicators(bars: IntradayIndexBarDto[]): IndicatorSnapshot {
    const closes = bars.map((b) => this.price(b.close));
    const highs = bars.map((b) => this.price(b.high));
    const lows = bars.map((b) => this.price(b.low));
    const volumes = bars.map((b) => Number(b.volume) || 0);
    const ema9 = this.ema(closes, 9);
    const ema21 = this.ema(closes, 21);
    const rsi = this.rsi(closes, 14);
    const atr = this.atr(bars, ATR_PERIOD);
    const latestIdx = bars.length - 1;
    const dayBars = this.sameVnDateBars(bars, bars[latestIdx].time);
    const vwap = this.vwap(dayBars);
    const prior = bars.slice(Math.max(0, latestIdx - 12), latestIdx);
    const vol20 = volumes.slice(Math.max(0, latestIdx - 20), latestIdx);
    const avgVol20 = vol20.length
      ? vol20.reduce((a, b) => a + b, 0) / vol20.length
      : 0;

    return {
      close: closes[latestIdx],
      ema9: ema9[latestIdx],
      ema21: ema21[latestIdx],
      emaSlope: ema9[latestIdx] - ema9[Math.max(0, latestIdx - 3)],
      rsi14: rsi[latestIdx],
      atr14: atr[latestIdx],
      vwap,
      prevHigh12: prior.length
        ? Math.max(...prior.map((b) => this.price(b.high)))
        : highs[latestIdx],
      prevLow12: prior.length
        ? Math.min(...prior.map((b) => this.price(b.low)))
        : lows[latestIdx],
      volumeRatio20: avgVol20 > 0 ? volumes[latestIdx] / avgVol20 : 1,
      latestTime: new Date(Number(bars[latestIdx].time) * 1000),
      tradingDate: this.vnDateFromUnix(Number(bars[latestIdx].time)),
    };
  }

  private async settleOpenDecisions(
    bars: IntradayIndexBarDto[],
  ): Promise<void> {
    if (!bars.length) return;
    const open = await this.decisionRepo.find({
      where: {
        symbol: 'VN30',
        status: DerivativeDecisionStatus.OPEN,
      },
      order: { decidedAt: 'ASC' },
      take: 200,
    });
    if (!open.length) return;

    for (const d of open) {
      if (
        d.action === DerivativeDecisionAction.NO_TRADE ||
        d.entryPrice == null ||
        d.stopLoss == null ||
        d.takeProfit == null
      ) {
        d.status = DerivativeDecisionStatus.CLOSED;
        d.outcome = DerivativeDecisionOutcome.NO_TRADE;
        d.pnlPoints = 0;
        d.exitAt = d.decidedAt;
        d.exitPrice = d.entryPrice;
        d.outcomeReason = 'Không có điểm vào hợp lệ.';
        await this.decisionRepo.save(d);
        continue;
      }
      const after = bars.filter(
        (b) => Number(b.time) * 1000 > d.decidedAt.getTime(),
      );
      if (!after.length) continue;
      let exitBar: IntradayIndexBarDto | null = null;
      let exitPrice: number | null = null;
      let outcome: DerivativeDecisionOutcome | null = null;
      let reason = '';
      for (const b of after) {
        const high = this.price(b.high);
        const low = this.price(b.low);
        if (d.action === DerivativeDecisionAction.LONG) {
          if (low <= Number(d.stopLoss)) {
            exitBar = b;
            exitPrice = Number(d.stopLoss);
            outcome = DerivativeDecisionOutcome.LOSS;
            reason = 'Chạm SL trước TP.';
            break;
          }
          if (high >= Number(d.takeProfit)) {
            exitBar = b;
            exitPrice = Number(d.takeProfit);
            outcome = DerivativeDecisionOutcome.WIN;
            reason = 'Chạm TP.';
            break;
          }
        } else {
          if (high >= Number(d.stopLoss)) {
            exitBar = b;
            exitPrice = Number(d.stopLoss);
            outcome = DerivativeDecisionOutcome.LOSS;
            reason = 'Chạm SL trước TP.';
            break;
          }
          if (low <= Number(d.takeProfit)) {
            exitBar = b;
            exitPrice = Number(d.takeProfit);
            outcome = DerivativeDecisionOutcome.WIN;
            reason = 'Chạm TP.';
            break;
          }
        }
      }
      if (!exitBar && after.length >= SETTLE_AFTER_BARS) {
        exitBar = after[after.length - 1];
        exitPrice = this.price(exitBar.close);
        outcome = DerivativeDecisionOutcome.TIME_EXIT;
        reason = `Thoát theo thời gian sau ${SETTLE_AFTER_BARS} nến 5m.`;
      }
      if (!exitBar || exitPrice == null || !outcome) continue;
      d.status = DerivativeDecisionStatus.CLOSED;
      d.exitAt = new Date(Number(exitBar.time) * 1000);
      d.exitPrice = this.round2(exitPrice);
      d.pnlPoints = this.round2(
        d.action === DerivativeDecisionAction.LONG
          ? exitPrice - Number(d.entryPrice)
          : Number(d.entryPrice) - exitPrice,
      );
      d.outcome = outcome;
      d.outcomeReason = reason;
      await this.decisionRepo.save(d);
    }
  }

  private async shouldNotify(
    decision: DerivativeDecision,
    forceNotify = false,
  ): Promise<boolean> {
    if (forceNotify) return true;
    if (
      this.config.get<string>('DERIVATIVES_TELEGRAM_NOTIFY', 'true') === 'false'
    ) {
      return false;
    }
    const notifyNoTrade =
      this.config.get<string>(
        'DERIVATIVES_TELEGRAM_NOTIFY_NO_TRADE',
        'false',
      ) === 'true';
    if (
      decision.action === DerivativeDecisionAction.NO_TRADE &&
      !notifyNoTrade
    ) {
      const previous = await this.previousDecisionBefore(decision.decidedAt);
      return (
        previous?.action === DerivativeDecisionAction.LONG ||
        previous?.action === DerivativeDecisionAction.SHORT
      );
    }
    if (
      decision.action === DerivativeDecisionAction.LONG ||
      decision.action === DerivativeDecisionAction.SHORT
    ) {
      const sameSideOpenNotified = await this.findOpenNotifiedDecision(
        decision.action,
        decision.decidedAt,
      );
      if (sameSideOpenNotified) return false;
    }
    const previous = await this.previousDecisionBefore(decision.decidedAt);
    if (!previous) return decision.action !== DerivativeDecisionAction.NO_TRADE;
    if (previous.action !== decision.action) return true;
    if (decision.action === DerivativeDecisionAction.NO_TRADE) return false;
    // Cùng hướng LONG/SHORT đã thông báo trước đó thì không nhắc lại mở lệnh.
    return false;
  }

  private findOpenNotifiedDecision(
    action: DerivativeDecisionAction.LONG | DerivativeDecisionAction.SHORT,
    at: Date,
  ): Promise<DerivativeDecision | null> {
    return this.decisionRepo
      .createQueryBuilder('d')
      .where('d.symbol = :symbol', { symbol: 'VN30' })
      .andWhere('d.action = :action', { action })
      .andWhere('d.status = :status', { status: DerivativeDecisionStatus.OPEN })
      .andWhere('d.notified = :notified', { notified: true })
      .andWhere('d.decidedAt < :at', { at })
      .orderBy('d.decidedAt', 'DESC')
      .getOne();
  }

  private previousDecisionBefore(at: Date): Promise<DerivativeDecision | null> {
    return this.decisionRepo
      .createQueryBuilder('d')
      .where('d.symbol = :symbol', { symbol: 'VN30' })
      .andWhere('d.decidedAt < :at', { at })
      .orderBy('d.decidedAt', 'DESC')
      .getOne();
  }

  private async notifyDecision(
    decision: DerivativeDecision,
    source: string,
  ): Promise<void> {
    const time = this.formatVnTime(decision.decidedAt);
    const actionIcon =
      decision.action === DerivativeDecisionAction.LONG
        ? '🟢'
        : decision.action === DerivativeDecisionAction.SHORT
          ? '🔴'
          : '🟡';
    const actionLabel =
      decision.action === DerivativeDecisionAction.LONG
        ? 'LONG'
        : decision.action === DerivativeDecisionAction.SHORT
          ? 'SHORT'
          : 'NO TRADE';
    const linePrice =
      decision.entryPrice == null
        ? ''
        : `\n🎯 <b>Entry</b>: <code>${decision.entryPrice}</code>  |  🛡️ <b>SL</b>: <code>${decision.stopLoss ?? '-'}</code>  |  🏁 <b>TP</b>: <code>${decision.takeProfit ?? '-'}</code>`;
    const pnl =
      decision.pnlPoints == null
        ? ''
        : `\n💰 <b>P/L review</b>: <code>${decision.pnlPoints}</code> điểm (${decision.outcome ?? '-'})`;
    await this.telegramService.sendMessage({
      parseMode: 'HTML',
      text:
        `📊 <b>Phái sinh VN30 5m</b> <i>(${source})</i>\n` +
        `🕒 <b>Thời điểm</b>: <b>${time}</b>\n` +
        `${actionIcon} <b>Quyết định</b>: <b>${actionLabel}</b>  |  🎚️ <b>Confidence</b>: <b>${decision.confidence}%</b>  |  🧮 <b>Score</b>: <b>${decision.score}</b>` +
        linePrice +
        pnl +
        `\n🧠 <b>Lý do</b>: ${this.escapeHtml(decision.reason)}`,
    });
  }

  private metadata(
    notes: string[],
    snapshot: IndicatorSnapshot | null,
  ): DerivativeDecisionMetadata {
    return {
      algorithm: ALGORITHM,
      notes,
      metrics: snapshot
        ? {
            close: this.round2(snapshot.close),
            ema9: this.round2(snapshot.ema9),
            ema21: this.round2(snapshot.ema21),
            emaSlope: this.round2(snapshot.emaSlope),
            rsi14: snapshot.rsi14 == null ? null : this.round2(snapshot.rsi14),
            atr14: snapshot.atr14 == null ? null : this.round2(snapshot.atr14),
            vwap: this.round2(snapshot.vwap),
            prevHigh12: this.round2(snapshot.prevHigh12),
            prevLow12: this.round2(snapshot.prevLow12),
            volumeRatio20: this.round2(snapshot.volumeRatio20),
          }
        : {},
    };
  }

  private explainSnapshot(s: IndicatorSnapshot): string[] {
    return [
      `Close ${this.round2(s.close)}, VWAP ${this.round2(s.vwap)}.`,
      `EMA9 ${this.round2(s.ema9)} / EMA21 ${this.round2(s.ema21)}, slope ${this.round2(s.emaSlope)}.`,
      `RSI14 ${s.rsi14 == null ? '-' : this.round2(s.rsi14)}, ATR14 ${s.atr14 == null ? '-' : this.round2(s.atr14)}.`,
      `Breakout 12 nến: high ${this.round2(s.prevHigh12)}, low ${this.round2(s.prevLow12)}, vol x${this.round2(s.volumeRatio20)}.`,
    ];
  }

  private ema(values: number[], period: number): number[] {
    const k = 2 / (period + 1);
    let e = values[0] ?? 0;
    return values.map((v, i) => {
      e = i === 0 ? v : v * k + e * (1 - k);
      return e;
    });
  }

  private rsi(values: number[], period: number): Array<number | null> {
    const out = new Array<number | null>(values.length).fill(null);
    if (values.length <= period) return out;
    let gain = 0;
    let loss = 0;
    for (let i = 1; i <= period; i++) {
      const diff = values[i] - values[i - 1];
      if (diff >= 0) gain += diff;
      else loss -= diff;
    }
    let avgGain = gain / period;
    let avgLoss = loss / period;
    out[period] = this.rsiFromAvg(avgGain, avgLoss);
    for (let i = period + 1; i < values.length; i++) {
      const diff = values[i] - values[i - 1];
      avgGain = (avgGain * (period - 1) + Math.max(diff, 0)) / period;
      avgLoss = (avgLoss * (period - 1) + Math.max(-diff, 0)) / period;
      out[i] = this.rsiFromAvg(avgGain, avgLoss);
    }
    return out;
  }

  private rsiFromAvg(avgGain: number, avgLoss: number): number {
    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    return 100 - 100 / (1 + rs);
  }

  private atr(
    bars: IntradayIndexBarDto[],
    period: number,
  ): Array<number | null> {
    const out = new Array<number | null>(bars.length).fill(null);
    if (bars.length <= period) return out;
    const tr: number[] = [];
    for (let i = 0; i < bars.length; i++) {
      const high = this.price(bars[i].high);
      const low = this.price(bars[i].low);
      const prevClose = i > 0 ? this.price(bars[i - 1].close) : high;
      tr.push(
        Math.max(
          high - low,
          Math.abs(high - prevClose),
          Math.abs(low - prevClose),
        ),
      );
    }
    let avg = tr.slice(1, period + 1).reduce((a, b) => a + b, 0) / period;
    out[period] = avg;
    for (let i = period + 1; i < tr.length; i++) {
      avg = (avg * (period - 1) + tr[i]) / period;
      out[i] = avg;
    }
    return out;
  }

  private sameVnDateBars(
    bars: IntradayIndexBarDto[],
    unixSec: number,
  ): IntradayIndexBarDto[] {
    const ymd = this.vnDateFromUnix(unixSec);
    return bars.filter((b) => this.vnDateFromUnix(Number(b.time)) === ymd);
  }

  private vwap(bars: IntradayIndexBarDto[]): number {
    let pv = 0;
    let vol = 0;
    for (const b of bars) {
      const v = Number(b.volume) || 0;
      const typical =
        (this.price(b.high) + this.price(b.low) + this.price(b.close)) / 3;
      pv += typical * v;
      vol += v;
    }
    if (vol <= 0) return this.price(bars[bars.length - 1]?.close ?? 0);
    return pv / vol;
  }

  private price(v: number): number {
    const n = Number(v);
    return Number.isFinite(n) ? n / 1000 : 0;
  }

  private round2(v: number): number {
    return Math.round((v + Number.EPSILON) * 100) / 100;
  }

  private vnDateFromUnix(unixSec: number): string {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Ho_Chi_Minh',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(unixSec * 1000));
  }

  private formatVnTime(d: Date): string {
    return new Intl.DateTimeFormat('vi-VN', {
      timeZone: 'Asia/Ho_Chi_Minh',
      hour: '2-digit',
      minute: '2-digit',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
    }).format(d);
  }

  private escapeHtml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }
}
