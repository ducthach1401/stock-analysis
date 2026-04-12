import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DnseService } from '../stock/dnse.service';
import { StockPrice } from '../stock/entities/stock-price.entity';
import { TelegramService } from '../telegram/telegram.service';
import { RecommendationResult } from '../signal/dto/recommendation.dto';
import {
  calcPriceTargetForFixedEntry,
  POSITION_MIN_UPSIDE_PCT,
} from '../signal/recommendation.service';
import {
  allowsAverageDown,
  allowsFirstPositionEntry,
  averageReasonLabel,
  firstLegPriceFromWeightedAverage,
  isInReentryCooldown,
  MAX_AVERAGE_DOWN_LEGS,
  weightedEntryAfterAverageDown,
} from './averaging-policy';
import {
  AverageDownLeg,
  CloseReason,
  Position,
  PositionStatus,
} from './entities/position.entity';
import { SignalType } from '../signal/entities/signal.entity';
import {
  PROFIT_RUN_PCT,
  effectiveProfitFloorPnl,
} from '../common/position-profit-run';
import {
  canSellAfterT2,
  MIN_TRADING_SESSIONS_AFTER_ENTRY,
  tradingSessionsAfterEntryDate,
  vnCalendarTodayYmd,
} from '../common/vn-trading-days';

@Injectable()
export class PositionService {
  private readonly logger = new Logger(PositionService.name);

  constructor(
    @InjectRepository(Position)
    private readonly positionRepo: Repository<Position>,
    @InjectRepository(StockPrice)
    private readonly stockPriceRepo: Repository<StockPrice>,
    private readonly dnseService: DnseService,
    private readonly telegramService: TelegramService,
  ) {}

  // ─── Mở vị thế / trung bình giá ───────────────────────────────────────────

  /** Kết quả xử lý tín hiệu mua (mở mới hoặc TB giá). */
  async openOrScaleIn(result: RecommendationResult): Promise<{
    outcome: 'OPENED' | 'AVERAGED' | 'NONE';
    detail?: string;
    /** Giá vào bình quân sau TB (chỉ khi AVERAGED). */
    weightedEntryPrice?: number;
  }> {
    const ticker = result.ticker.toUpperCase();
    const existing = await this.positionRepo.findOne({
      where: { ticker, status: PositionStatus.OPEN },
    });
    if (existing) {
      return this.tryAverageDown(result, existing);
    }
    return this.tryOpenFirst(result);
  }

  /**
   * Mở lần đầu: STRONG_BUY + (nền tốt hoặc break). TP ≥ 20% từ giá vào (hoặc cao hơn nếu có dư địa kháng cự/ATR).
   */
  private async tryOpenFirst(result: RecommendationResult): Promise<{
    outcome: 'OPENED' | 'NONE';
    detail?: string;
  }> {
    if (!allowsFirstPositionEntry(result)) {
      return {
        outcome: 'NONE',
        detail:
          'chưa đủ nền/break để mở (cần tín hiệu mua mạnh + BASE/EMA stack/BB squeeze hoặc break kháng cự)',
      };
    }
    const ticker = result.ticker.toUpperCase();
    const pt = result.priceTarget;
    if (!pt) return { outcome: 'NONE', detail: 'thiếu price target' };

    const recentlyClosed = await this.positionRepo.findOne({
      where: { ticker, status: PositionStatus.CLOSED },
      order: { closeDate: 'DESC' },
    });
    const todayVn = vnCalendarTodayYmd();
    if (isInReentryCooldown(recentlyClosed?.closeDate, todayVn)) {
      this.logger.warn(
        `${ticker}: cooldown — vừa đóng lệnh ngày ${recentlyClosed?.closeDate}`,
      );
      return { outcome: 'NONE', detail: 'cooldown sau khi đóng lệnh' };
    }

    let entryPrice = Number(pt.currentPrice);
    if (result.tradingDate) {
      const dayBar = await this.stockPriceRepo.findOne({
        where: { ticker, tradingDate: result.tradingDate },
      });
      if (dayBar) entryPrice = Number(dayBar.close);
      else {
        this.logger.warn(
          `${ticker}: không có nến ${result.tradingDate} — dùng currentPrice`,
        );
      }
    }

    const bars = await this.loadBarsAsc(ticker, 130);
    if (bars.length < 20) {
      return { outcome: 'NONE', detail: 'quá ít nến để tính target' };
    }
    const tgs = calcPriceTargetForFixedEntry(entryPrice, bars, {
      minUpsidePct: POSITION_MIN_UPSIDE_PCT,
    });

    const position = this.positionRepo.create({
      ticker,
      entryDate: result.tradingDate,
      entryPrice,
      targetPrice: tgs.targetPrice,
      stopLoss: null,
      recommendation: result.recommendation,
      riskReward: tgs.riskReward,
      averageDownLegs: null,
      status: PositionStatus.OPEN,
      lastPrice: entryPrice,
      lastTrackedDate: result.tradingDate,
      pnlPercent: 0,
      daysHeld: 0,
      peakPriceSinceOpen: entryPrice,
    });

    await this.positionRepo.save(position);
    this.logger.log(
      `📂 Mở vị thế ${ticker} @ ${(entryPrice / 1000).toFixed(1)}k` +
        ` | TP ≥ ${(100 * POSITION_MIN_UPSIDE_PCT).toFixed(0)}%: target ${(tgs.targetPrice / 1000).toFixed(1)}k | không SL`,
    );
    return { outcome: 'OPENED' };
  }

  /**
   * Trung bình giá: chỉ khi đang lỗ so với giá TB và có nền tốt hoặc tín hiệu hồi phục.
   */
  private async tryAverageDown(
    result: RecommendationResult,
    pos: Position,
  ): Promise<{
    outcome: 'AVERAGED' | 'NONE';
    detail?: string;
    weightedEntryPrice?: number;
  }> {
    const ticker = result.ticker.toUpperCase();
    const pt = result.priceTarget;
    if (!pt) return { outcome: 'NONE', detail: 'thiếu price target' };

    const legs = pos.averageDownLegs ?? [];
    if (legs.length >= MAX_AVERAGE_DOWN_LEGS) {
      return {
        outcome: 'NONE',
        detail: `đã đủ ${MAX_AVERAGE_DOWN_LEGS} lần TB giá`,
      };
    }

    const entryAvg = Number(pos.entryPrice);
    if (!allowsAverageDown(result, entryAvg, legs.length)) {
      const px = pt.currentPrice;
      if (px >= entryAvg) {
        return {
          outcome: 'NONE',
          detail: 'chưa lỗ so với giá TB — không TB thêm',
        };
      }
      return {
        outcome: 'NONE',
        detail:
          'chưa đủ điều kiện TB: lỗ ≥ 10% so với giá TB; nền tốt hoặc tín hiệu hồi phục; khuyến nghị BUY/STRONG_BUY/HOLD (không SELL)',
      };
    }

    let addPrice = Number(pt.currentPrice);
    if (result.tradingDate) {
      const dayBar = await this.stockPriceRepo.findOne({
        where: { ticker, tradingDate: result.tradingDate },
      });
      if (dayBar) addPrice = Number(dayBar.close);
    }

    const newAvg = weightedEntryAfterAverageDown(
      entryAvg,
      legs.length,
      addPrice,
    );

    const reason = averageReasonLabel(result);
    const newLeg: AverageDownLeg = {
      date: result.tradingDate,
      price: Math.round(addPrice),
      reason,
    };

    const bars = await this.loadBarsAsc(ticker, 130);
    if (bars.length < 20) {
      return { outcome: 'NONE', detail: 'quá ít nến để cập nhật target' };
    }
    /** Một mức giá vào duy nhất: DB `entryPrice` = giá TB dùng cho target / P&L. */
    const entryRounded = Math.round(newAvg);
    const tgs = calcPriceTargetForFixedEntry(entryRounded, bars, {
      minUpsidePct: POSITION_MIN_UPSIDE_PCT,
    });

    pos.entryPrice = entryRounded;
    pos.targetPrice = tgs.targetPrice;
    pos.stopLoss = null;
    pos.riskReward = tgs.riskReward;
    pos.recommendation = result.recommendation;
    pos.averageDownLegs = [...legs, newLeg];
    pos.lastPrice = addPrice;
    pos.lastTrackedDate = result.tradingDate;
    pos.pnlPercent = Number(
      (((addPrice - entryRounded) / entryRounded) * 100).toFixed(2),
    );

    pos.peakPriceSinceOpen = Math.max(entryRounded, addPrice);

    await this.positionRepo.save(pos);
    this.logger.log(
      `📊 TB giá ${ticker} lần ${pos.averageDownLegs.length} @ ${(addPrice / 1000).toFixed(1)}k` +
        ` → giá vào (entry) ${(entryRounded / 1000).toFixed(1)}k | ${reason} | target ${(tgs.targetPrice / 1000).toFixed(1)}k (không dùng SL)`,
    );
    return { outcome: 'AVERAGED', weightedEntryPrice: entryRounded };
  }

  private async loadBarsAsc(
    ticker: string,
    limit: number,
  ): Promise<{ open: number; high: number; low: number; close: number }[]> {
    const rows = await this.stockPriceRepo
      .createQueryBuilder('sp')
      .where('sp.ticker = :ticker', { ticker })
      .orderBy('sp.tradingDate', 'DESC')
      .limit(limit)
      .getMany();
    return rows.reverse().map((r) => ({
      open: Number(r.open),
      high: Number(r.high),
      low: Number(r.low),
      close: Number(r.close),
    }));
  }

  // ─── Theo dõi hàng ngày ─────────────────────────────────────────────────

  /**
   * Lấy giá mới nhất và cập nhật tất cả vị thế đang mở.
   * **Không** đóng theo tín hiệu đảo chiều — chỉ **mua/TB** và chờ **target** (hoặc **chặn lãi** khi giá quay đầu: sàn tối thiểu ~20%, **nâng** theo đỉnh).
   * Thứ tự: (0) chặn lãi (không T+2) → (1) target khi lãi &lt; ~20% (có T+2).
   */
  async trackAll(): Promise<void> {
    const openPositions = await this.positionRepo.find({
      where: { status: PositionStatus.OPEN },
      order: { entryDate: 'ASC' },
    });

    if (!openPositions.length) {
      this.logger.log('Không có vị thế nào đang mở');
      return;
    }

    const today = new Date().toLocaleDateString('sv-SE', {
      timeZone: 'Asia/Ho_Chi_Minh',
    });

    const updates: string[] = [];

    for (const pos of openPositions) {
      try {
        const bar = await this.dnseService.fetchLatestBar(pos.ticker);
        if (!bar) continue;

        const currentPrice = bar.close;
        const entry = Number(pos.entryPrice);
        const pnlPct = ((currentPrice - entry) / entry) * 100;
        const daysHeld =
          Math.floor(
            (new Date(today).getTime() - new Date(pos.entryDate).getTime()) /
              86400000,
          ) || 0;

        // Cập nhật giá + P&L + đỉnh giá (chặn lãi khi quay đầu)
        pos.lastPrice = currentPrice;
        pos.lastTrackedDate = today;
        pos.pnlPercent = Number(pnlPct.toFixed(2));
        pos.daysHeld = daysHeld;
        const prevPeak =
          pos.peakPriceSinceOpen != null
            ? Number(pos.peakPriceSinceOpen)
            : entry;
        pos.peakPriceSinceOpen = Math.max(prevPeak, currentPrice);

        const fmt = (n: number) =>
          (n / 1000).toLocaleString('vi-VN', { maximumFractionDigits: 1 }) +
          'k';
        const pnlEmoji = pnlPct >= 0 ? '🟢' : '🔴';
        const pnlStr = `${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%`;

        const peakPrice = Number(pos.peakPriceSinceOpen);
        const peakPnlPct = ((peakPrice - entry) / entry) * 100;
        const floorPnlPct = effectiveProfitFloorPnl(entry, peakPrice);
        const hitProfitFloor =
          peakPnlPct > PROFIT_RUN_PCT && pnlPct <= floorPnlPct;

        // ── Đóng lệnh: target (có T+2); chặn lãi xử lý ở trên
        const hitTarget =
          pnlPct < PROFIT_RUN_PCT && currentPrice >= Number(pos.targetPrice);
        const settlementOk = canSellAfterT2(pos.entryDate, today);
        const sessionsAfter = tradingSessionsAfterEntryDate(
          pos.entryDate,
          today,
        );

        if (hitProfitFloor) {
          await this.closePosition(
            pos,
            currentPrice,
            CloseReason.PROFIT_FLOOR_20,
            today,
            this.detailProfitFloor20(
              pos,
              currentPrice,
              peakPnlPct,
              floorPnlPct,
            ),
          );
          await this.sendCloseAlert(
            pos,
            currentPrice,
            CloseReason.PROFIT_FLOOR_20,
            pnlPct,
          );
          this.logger.log(
            `🔒 ${pos.ticker} chặn lãi (sàn ~${floorPnlPct.toFixed(1)}%, đỉnh ~${peakPnlPct.toFixed(1)}%) — đóng ${pnlPct.toFixed(2)}%`,
          );
          continue;
        }

        if (hitTarget && !settlementOk) {
          await this.positionRepo.save(pos);
          updates.push(
            `  ⏳ <b>${pos.ticker}</b>: ${fmt(currentPrice)} (${pnlStr}) | ` +
              `Mua ${fmt(entry)} — <i>Chờ T+2: ${sessionsAfter}/${MIN_TRADING_SESSIONS_AFTER_ENTRY} phiên sau ${pos.entryDate} (đạt target)</i>`,
          );
          this.logger.debug(
            `${pos.ticker}: chưa đủ T+2 (${sessionsAfter} phiên) — giữ vị thế`,
          );
          continue;
        }

        if (hitTarget) {
          await this.closePosition(
            pos,
            currentPrice,
            CloseReason.TARGET_HIT,
            today,
            this.detailTargetHit(pos, currentPrice),
          );
          await this.sendCloseAlert(
            pos,
            currentPrice,
            CloseReason.TARGET_HIT,
            pnlPct,
          );
          this.logger.log(
            `🎯 ${pos.ticker} đạt target! Đóng vị thế +${pnlPct.toFixed(2)}%`,
          );
          continue;
        }

        // Vị thế vẫn mở — cập nhật DB
        await this.positionRepo.save(pos);

        updates.push(
          `  ${pnlEmoji} <b>${pos.ticker}</b>: ${fmt(currentPrice)} (${pnlStr}) | ` +
            `Mua ${fmt(entry)} | Target ${fmt(Number(pos.targetPrice))} | ` +
            `${daysHeld} ngày`,
        );
      } catch (e) {
        this.logger.error(`Track lỗi ${pos.ticker}: ${(e as Error).message}`);
      }
    }

    // Gửi báo cáo hàng ngày cho các vị thế vẫn đang mở
    if (updates.length) {
      const date = new Date().toLocaleDateString('vi-VN', {
        timeZone: 'Asia/Ho_Chi_Minh',
      });
      let msg = `📋 <b>Theo dõi vị thế</b> — ${date}\n`;
      msg += `<i>${updates.length} vị thế đang mở</i>\n`;
      msg += '─'.repeat(30) + '\n\n';
      msg += updates.join('\n') + '\n\n';
      msg +=
        `<i>Thoát: chặn lãi (sàn tối thiểu ~${PROFIT_RUN_PCT}%, nâng theo đỉnh) khi quay đầu (không T+2) → target khi lãi &lt;${PROFIT_RUN_PCT}% (có T+2). ` +
        `Không đóng theo đảo chiều. Không SL.</i>`;
      await this.telegramService.sendMessage({ text: msg });
    }
  }

  // ─── Đóng vị thế ────────────────────────────────────────────────────────

  async closePosition(
    pos: Position,
    closePrice: number,
    reason: CloseReason,
    closeDate: string,
    detail?: string | null,
  ): Promise<void> {
    const entry = Number(pos.entryPrice);
    const pnl = ((closePrice - entry) / entry) * 100;

    pos.status = PositionStatus.CLOSED;
    pos.closeDate = closeDate;
    pos.closePrice = closePrice;
    pos.closeReason = reason;
    pos.closeReasonDetail =
      detail ?? this.defaultCloseReasonDetail(pos, reason, closePrice);
    pos.closePnlPercent = Number(pnl.toFixed(2));
    await this.positionRepo.save(pos);
  }

  private defaultCloseReasonDetail(
    pos: Position,
    reason: CloseReason,
    closePrice: number,
  ): string {
    const fmt = (n: number) =>
      Math.round(n).toLocaleString('vi-VN', { maximumFractionDigits: 0 }) + 'đ';
    switch (reason) {
      case CloseReason.TARGET_HIT:
        return `Chốt mục tiêu — giá ${fmt(closePrice)} ≥ target ${fmt(Number(pos.targetPrice))}; sau T+2`;
      case CloseReason.STOP_LOSS:
        return `Chạm cắt lỗ — giá ${fmt(closePrice)} ≤ stop ${fmt(Number(pos.stopLoss))}; sau T+2`;
      case CloseReason.PROFIT_FLOOR_20:
        return `Chặn lãi (sàn động từ đỉnh, tối thiểu ~${PROFIT_RUN_PCT}%) — giá quay đầu (đóng cửa ${fmt(closePrice)})`;
      case CloseReason.DISTRIBUTION:
        return this.detailReversalStrongSell();
      case CloseReason.MANUAL:
        return 'Đóng thủ công';
      default:
        return '';
    }
  }

  private detailProfitFloor20(
    pos: Position,
    closePrice: number,
    peakPnlPct: number,
    floorPnlPct: number,
  ): string {
    const fmt = (n: number) =>
      Math.round(n).toLocaleString('vi-VN', { maximumFractionDigits: 0 }) + 'đ';
    const floorNote =
      floorPnlPct > PROFIT_RUN_PCT + 0.05
        ? `sàn ~${floorPnlPct.toFixed(1)}% (nâng theo đỉnh)`
        : `sàn ~${PROFIT_RUN_PCT}%`;
    return (
      `Chặn lãi — ${floorNote}, đỉnh lãi ~${peakPnlPct.toFixed(1)}%, ` +
      `giá quay đầu · đóng ${fmt(closePrice)}`
    );
  }

  private detailTargetHit(pos: Position, closePrice: number): string {
    const fmt = (n: number) =>
      Math.round(n).toLocaleString('vi-VN', { maximumFractionDigits: 0 }) + 'đ';
    return `Chốt mục tiêu — đóng cửa ${fmt(closePrice)} ≥ target ${fmt(Number(pos.targetPrice))}; đủ T+2 mới bán`;
  }

  /** Điểm tổng hợp ≤ −6 = STRONG_SELL; khác với SELL (−3…−5) */
  private detailReversalStrongSell(): string {
    return 'Đảo chiều — STRONG_SELL (score ≤ −6), nhiều tín hiệu giảm cùng lúc; sau T+2; không thoát với BÁN thường';
  }

  async closeManual(id: number, closePrice?: number): Promise<Position | null> {
    const pos = await this.positionRepo.findOne({ where: { id } });
    if (!pos || pos.status === PositionStatus.CLOSED) return null;

    const bar = closePrice
      ? null
      : await this.dnseService.fetchLatestBar(pos.ticker);
    const price = closePrice ?? bar?.close ?? Number(pos.lastPrice);
    const today = new Date().toLocaleDateString('sv-SE', {
      timeZone: 'Asia/Ho_Chi_Minh',
    });

    await this.closePosition(
      pos,
      price,
      CloseReason.MANUAL,
      today,
      'Đóng thủ công từ giao diện hoặc API',
    );
    return pos;
  }

  // ─── Query ───────────────────────────────────────────────────────────────

  /** Giá mua lệnh đầu (hiển thị cạnh ngày Đầu); `entryPrice` vẫn là giá TB. */
  private enrichPosition(
    pos: Position,
  ): Position & { firstEntryPrice: number } {
    const entry = Number(pos.entryPrice);
    const legs = pos.averageDownLegs ?? [];
    const firstEntryPrice =
      legs.length > 0
        ? Math.round(firstLegPriceFromWeightedAverage(entry, legs))
        : entry;
    return { ...pos, firstEntryPrice };
  }

  async getOpenPositions(): Promise<
    (Position & { firstEntryPrice: number })[]
  > {
    const rows = await this.positionRepo.find({
      where: { status: PositionStatus.OPEN },
      order: { entryDate: 'ASC' },
    });
    return rows.map((p) => this.enrichPosition(p));
  }

  async getAllPositions(): Promise<(Position & { firstEntryPrice: number })[]> {
    const rows = await this.positionRepo.find({ order: { createdAt: 'DESC' } });
    return rows.map((p) => this.enrichPosition(p));
  }

  async getClosedPositions(): Promise<
    (Position & { firstEntryPrice: number })[]
  > {
    const rows = await this.positionRepo.find({
      where: { status: PositionStatus.CLOSED },
      order: { closeDate: 'DESC' },
    });
    return rows.map((p) => this.enrichPosition(p));
  }

  // ─── Telegram ────────────────────────────────────────────────────────────

  private async sendCloseAlert(
    pos: Position,
    closePrice: number,
    reason: CloseReason,
    pnlPct: number,
  ): Promise<void> {
    const fmt = (n: number) => Math.round(n).toLocaleString('vi-VN') + 'đ';
    const pnlStr = `${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%`;

    const reasonMap: Record<CloseReason, string> = {
      [CloseReason.TARGET_HIT]: '🎯 Chốt mục tiêu (đạt target)',
      [CloseReason.STOP_LOSS]: '🛑 Chạm cắt lỗ',
      [CloseReason.PROFIT_FLOOR_20]: `🔒 Chặn lãi (sàn động từ đỉnh)`,
      [CloseReason.DISTRIBUTION]: '🔄 Đảo chiều (bán tích cực)',
      [CloseReason.MANUAL]: '🤚 Đóng thủ công',
    };

    const emoji = pnlPct >= 5 ? '💰' : pnlPct >= 0 ? '✅' : '❌';

    const detailLine = pos.closeReasonDetail
      ? `\n📎 <i>${pos.closeReasonDetail}</i>\n`
      : '\n';

    const msg =
      `${emoji} <b>ĐÓNG VỊ THẾ — ${pos.ticker}</b>\n` +
      `📌 ${reasonMap[reason]}` +
      detailLine +
      `\n` +
      `  • Giá mua:    <b>${fmt(Number(pos.entryPrice))}</b> (${pos.entryDate})\n` +
      `  • Giá bán:    <b>${fmt(closePrice)}</b>\n` +
      `  • Kết quả:    <b>${pnlStr}</b>\n` +
      `  • Nắm giữ:    ${pos.daysHeld} ngày\n` +
      `  • Target:     ${fmt(Number(pos.targetPrice))}\n` +
      `  • SL:         <i>không dùng</i>\n\n` +
      `<i>Vị thế đã được đóng trong hệ thống.</i>`;

    await this.telegramService.sendMessage({ text: msg });
  }

  // Helper để lấy danh sách ticker đang có phân phối (dùng trong scanner)
  isDistributionSignal(signalType: string): boolean {
    const distributionTypes: string[] = [
      SignalType.FAILED_BREAKOUT,
      SignalType.VOLUME_CLIMAX_TOP,
      SignalType.DISTRIBUTION_BAR,
      SignalType.RSI_BEARISH_DIVERGENCE,
      SignalType.MACD_BEARISH_DIVERGENCE,
      SignalType.SUPPORT_BREAKDOWN,
    ];
    return distributionTypes.includes(signalType);
  }
}
