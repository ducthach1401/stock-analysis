import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DnseService } from '../stock/dnse.service';
import { TelegramService } from '../telegram/telegram.service';
import { RecommendationResult } from '../signal/dto/recommendation.dto';
import {
  CloseReason,
  Position,
  PositionStatus,
} from './entities/position.entity';
import { SignalType } from '../signal/entities/signal.entity';

@Injectable()
export class PositionService {
  private readonly logger = new Logger(PositionService.name);

  constructor(
    @InjectRepository(Position)
    private readonly positionRepo: Repository<Position>,
    private readonly dnseService: DnseService,
    private readonly telegramService: TelegramService,
  ) {}

  // ─── Mở vị thế mới ──────────────────────────────────────────────────────

  /**
   * Mở vị thế khi có tín hiệu MUA.
   * Trả về false nếu đã có vị thế OPEN cho mã này (không mở trùng).
   */
  async openPosition(result: RecommendationResult): Promise<boolean> {
    const ticker = result.ticker.toUpperCase();
    const pt = result.priceTarget;
    if (!pt) return false;

    // Kiểm tra đã có vị thế đang mở chưa
    const existing = await this.positionRepo.findOne({
      where: { ticker, status: PositionStatus.OPEN },
    });
    if (existing) {
      this.logger.debug(
        `${ticker}: đã có vị thế mở từ ${existing.entryDate}, bỏ qua`,
      );
      return false;
    }

    const position = this.positionRepo.create({
      ticker,
      entryDate: result.tradingDate,
      entryPrice: pt.currentPrice,
      targetPrice: pt.targetPrice,
      stopLoss: pt.stopLoss,
      recommendation: result.recommendation,
      riskReward: pt.riskReward,
      status: PositionStatus.OPEN,
      lastPrice: pt.currentPrice,
      lastTrackedDate: result.tradingDate,
      pnlPercent: 0,
      daysHeld: 0,
    });

    await this.positionRepo.save(position);
    this.logger.log(
      `📂 Mở vị thế ${ticker} @ ${(pt.currentPrice / 1000).toFixed(1)}k` +
        ` | Target: ${(pt.targetPrice / 1000).toFixed(1)}k | SL: ${(pt.stopLoss / 1000).toFixed(1)}k`,
    );
    return true;
  }

  // ─── Theo dõi hàng ngày ─────────────────────────────────────────────────

  /**
   * Lấy giá mới nhất và cập nhật tất cả vị thế đang mở.
   * Kiểm tra target hit / stop loss / distribution signal.
   */
  async trackAll(distributionTickers: string[] = []): Promise<void> {
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

        // Cập nhật giá + P&L
        pos.lastPrice = currentPrice;
        pos.lastTrackedDate = today;
        pos.pnlPercent = Number(pnlPct.toFixed(2));
        pos.daysHeld = daysHeld;

        const fmt = (n: number) =>
          (n / 1000).toLocaleString('vi-VN', { maximumFractionDigits: 1 }) +
          'k';
        const pnlEmoji = pnlPct >= 0 ? '🟢' : '🔴';
        const pnlStr = `${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%`;

        // ── Kiểm tra điều kiện đóng lệnh ─────────────────────────
        const hitTarget = currentPrice >= Number(pos.targetPrice);
        const hitStop = currentPrice <= Number(pos.stopLoss);
        const hasDistribution = distributionTickers.includes(pos.ticker);

        if (hitTarget) {
          await this.closePosition(
            pos,
            currentPrice,
            CloseReason.TARGET_HIT,
            today,
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

        if (hitStop) {
          await this.closePosition(
            pos,
            currentPrice,
            CloseReason.STOP_LOSS,
            today,
          );
          await this.sendCloseAlert(
            pos,
            currentPrice,
            CloseReason.STOP_LOSS,
            pnlPct,
          );
          this.logger.log(
            `🛑 ${pos.ticker} chạm cắt lỗ. Đóng vị thế ${pnlPct.toFixed(2)}%`,
          );
          continue;
        }

        if (hasDistribution) {
          await this.closePosition(
            pos,
            currentPrice,
            CloseReason.DISTRIBUTION,
            today,
          );
          await this.sendCloseAlert(
            pos,
            currentPrice,
            CloseReason.DISTRIBUTION,
            pnlPct,
          );
          this.logger.log(
            `⚠️ ${pos.ticker} xuất hiện phân phối. Đóng vị thế ${pnlPct.toFixed(2)}%`,
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
      msg += `<i>SL = cắt lỗ | Target = chốt lời</i>`;
      await this.telegramService.sendMessage({ text: msg });
    }
  }

  // ─── Đóng vị thế ────────────────────────────────────────────────────────

  async closePosition(
    pos: Position,
    closePrice: number,
    reason: CloseReason,
    closeDate: string,
  ): Promise<void> {
    const entry = Number(pos.entryPrice);
    const pnl = ((closePrice - entry) / entry) * 100;

    pos.status = PositionStatus.CLOSED;
    pos.closeDate = closeDate;
    pos.closePrice = closePrice;
    pos.closeReason = reason;
    pos.closePnlPercent = Number(pnl.toFixed(2));
    await this.positionRepo.save(pos);
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

    await this.closePosition(pos, price, CloseReason.MANUAL, today);
    return pos;
  }

  // ─── Query ───────────────────────────────────────────────────────────────

  async getOpenPositions(): Promise<Position[]> {
    return this.positionRepo.find({
      where: { status: PositionStatus.OPEN },
      order: { entryDate: 'ASC' },
    });
  }

  async getAllPositions(): Promise<Position[]> {
    return this.positionRepo.find({ order: { createdAt: 'DESC' } });
  }

  async getClosedPositions(): Promise<Position[]> {
    return this.positionRepo.find({
      where: { status: PositionStatus.CLOSED },
      order: { closeDate: 'DESC' },
    });
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
      [CloseReason.TARGET_HIT]: '🎯 Đạt mục tiêu lợi nhuận',
      [CloseReason.STOP_LOSS]: '🛑 Chạm cắt lỗ',
      [CloseReason.DISTRIBUTION]: '⚠️ Xuất hiện tín hiệu phân phối đỉnh',
      [CloseReason.MANUAL]: '🤚 Đóng thủ công',
    };

    const emoji = pnlPct >= 5 ? '💰' : pnlPct >= 0 ? '✅' : '❌';

    const msg =
      `${emoji} <b>ĐÓNG VỊ THẾ — ${pos.ticker}</b>\n` +
      `📌 ${reasonMap[reason]}\n\n` +
      `  • Giá mua:    <b>${fmt(Number(pos.entryPrice))}</b> (${pos.entryDate})\n` +
      `  • Giá bán:    <b>${fmt(closePrice)}</b>\n` +
      `  • Kết quả:    <b>${pnlStr}</b>\n` +
      `  • Nắm giữ:    ${pos.daysHeld} ngày\n` +
      `  • Target:     ${fmt(Number(pos.targetPrice))}\n` +
      `  • Cắt lỗ:    ${fmt(Number(pos.stopLoss))}\n\n` +
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
