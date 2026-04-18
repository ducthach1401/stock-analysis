import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { StockPrice } from '../stock/entities/stock-price.entity';
import { Signal, SignalType } from '../signal/entities/signal.entity';
import { TelegramService } from '../telegram/telegram.service';
import { SignalService } from '../signal/signal.service';
import { WatchlistService } from '../watchlist/watchlist.service';
import { mapPool } from '../common/map-pool';
import {
  isVnAfterMarketCloseForDailySignals,
  isVnCashMarketSessionOpen,
  vnCalendarTodayYmd,
} from '../common/vn-trading-days';
import { isMarketIndexTicker } from './watchlist';

/** Trạng thái break cản theo mã / ngày VN — tránh spam & đếm thời gian giữ. */
interface BreakoutSessionState {
  vnDate: string;
  /** Lần đầu thấy giá đóng > cản (epoch ms). Reset nếu mất break. */
  firstAboveResistanceAt: number | null;
  intradayStrengthSent: boolean;
  closeConfirmSent: boolean;
}

/**
 * Telegram trong phiên: "đang mạnh" khi giá giữ trên kháng cự 60 phiên đủ lâu (mặc định 30 phút),
 * tránh tin break 1 nhịp rồi cụt đầu.
 * Sau đóng cửa: một tin xác nhận nếu DB có RESISTANCE_BREAKOUT và đóng vẫn trên cản.
 */
@Injectable()
export class IntradayBreakoutNotifyService {
  private readonly logger = new Logger(IntradayBreakoutNotifyService.name);
  private readonly stateByTicker = new Map<string, BreakoutSessionState>();

  constructor(
    @InjectRepository(StockPrice)
    private readonly stockPriceRepo: Repository<StockPrice>,
    @InjectRepository(Signal)
    private readonly signalRepo: Repository<Signal>,
    private readonly signalService: SignalService,
    private readonly telegramService: TelegramService,
    private readonly watchlistService: WatchlistService,
    private readonly config: ConfigService,
  ) {}

  private holdMs(): number {
    const raw = this.config.get<string>(
      'TELEGRAM_INTRADAY_BREAKOUT_HOLD_MINUTES',
      '30',
    );
    const n = parseInt(raw ?? '30', 10);
    const minutes = Number.isFinite(n) && n >= 5 && n <= 120 ? n : 30;
    return minutes * 60 * 1000;
  }

  private intradayEnabled(): boolean {
    return (
      this.config.get<string>('TELEGRAM_INTRADAY_BREAKOUT_ENABLED', 'true') !==
      'false'
    );
  }

  private closeConfirmEnabled(): boolean {
    return (
      this.config.get<string>('TELEGRAM_BREAKOUT_CLOSE_CONFIRM', 'true') !==
      'false'
    );
  }

  private poolSize(): number {
    const n = parseInt(
      this.config.get<string>('INTRADAY_BREAKOUT_CONCURRENCY', '4') ?? '4',
      10,
    );
    return Number.isFinite(n) && n >= 1 && n <= 16 ? n : 4;
  }

  private fmtK(n: number): string {
    return (
      (n / 1000).toLocaleString('vi-VN', { maximumFractionDigits: 1 }) + 'k'
    );
  }

  private async loadBarsAsc(
    ticker: string,
    take: number,
  ): Promise<
    Array<{
      high: number;
      low: number;
      close: number;
      tradingDate: string;
    }>
  > {
    const rows = await this.stockPriceRepo.find({
      where: { ticker: ticker.toUpperCase() },
      order: { tradingDate: 'DESC' },
      take,
    });
    return rows.reverse().map((r) => ({
      high: Number(r.high),
      low: Number(r.low),
      close: Number(r.close),
      tradingDate: r.tradingDate,
    }));
  }

  /** Max high của 60 phiên trước nến cuối (cùng detectResistanceBreakout). */
  private resistanceFromBars(bars: Array<{ high: number }>): number | null {
    if (bars.length < 62) return null;
    const prev60 = bars.slice(-61, -1);
    return Math.max(...prev60.map((b) => b.high));
  }

  private getOrResetState(ticker: string): BreakoutSessionState {
    const today = vnCalendarTodayYmd();
    let st = this.stateByTicker.get(ticker);
    if (!st || st.vnDate !== today) {
      st = {
        vnDate: today,
        firstAboveResistanceAt: null,
        intradayStrengthSent: false,
        closeConfirmSent: false,
      };
      this.stateByTicker.set(ticker, st);
    }
    return st;
  }

  /**
   * Gọi sau `syncAll` trong phiên — DB đã có nến ngày hiện tại.
   */
  async processWatchlistAfterSync(): Promise<void> {
    if (!this.intradayEnabled()) return;
    if (!isVnCashMarketSessionOpen()) return;

    const tickers = await this.watchlistService.getActiveTickers();
    const pool = this.poolSize();
    await mapPool(tickers, pool, async (ticker) => {
      try {
        await this.processOneTickerIntraday(ticker);
      } catch (e) {
        this.logger.warn(
          `${ticker} intraday break notify: ${(e as Error).message}`,
        );
      }
    });
  }

  private async processOneTickerIntraday(ticker: string): Promise<void> {
    const upper = ticker.toUpperCase();
    if (isMarketIndexTicker(upper)) return;

    const liq = await this.signalService.checkLiquidity(upper);
    if (!liq.pass) return;

    const today = vnCalendarTodayYmd();
    const bars = await this.loadBarsAsc(upper, 70);
    const resistance = this.resistanceFromBars(bars);
    if (resistance == null) return;

    const todayBar = bars[bars.length - 1];
    if (!todayBar || todayBar.tradingDate !== today) return;

    const close = todayBar.close;
    const high = todayBar.high;
    const low = todayBar.low;
    const range = high - low;
    const closePosInRange = range > 0 ? (close - low) / range : 1;

    const st = this.getOrResetState(upper);

    if (close <= resistance) {
      st.firstAboveResistanceAt = null;
      return;
    }

    const minClosePos = 0.45;
    if (closePosInRange < minClosePos) {
      st.firstAboveResistanceAt = null;
      return;
    }

    const now = Date.now();
    if (st.firstAboveResistanceAt == null) {
      st.firstAboveResistanceAt = now;
    }

    if (st.intradayStrengthSent) return;

    const hold = this.holdMs();
    if (now - st.firstAboveResistanceAt < hold) return;

    const breakPct = ((close - resistance) / resistance) * 100;
    const hh = new Date().toLocaleTimeString('vi-VN', {
      timeZone: 'Asia/Ho_Chi_Minh',
      hour: '2-digit',
      minute: '2-digit',
    });

    await this.telegramService.sendMessage({
      text:
        `📈 <b>${upper}</b> đang mạnh: giữ trên cản ~${this.fmtK(resistance)}đ ` +
        `(đóng ${this.fmtK(close)}, +${breakPct.toFixed(1)}% so cản 60 phiên, ~${hh}).\n` +
        `Giữ break ≥ <b>${Math.round(hold / 60000)} phút</b> — theo dõi <b>đóng cửa</b> xác nhận nến ngày.\n` +
        `<i>⚠️ Không phải tư vấn; vào lệnh khuyến nghị chỉ sau khi nến đóng.</i>`,
      parseMode: 'HTML',
    });

    st.intradayStrengthSent = true;
    this.logger.log(
      `${upper}: đã gửi Telegram break intraday (giữ ≥${Math.round(hold / 60000)} phút)`,
    );
  }

  /**
   * Gọi sau sync buổi chiều khi nến ngày đã đầy đủ + analyze đã chạy.
   */
  async notifyDayCloseConfirmAfterSync(): Promise<void> {
    if (!this.closeConfirmEnabled()) return;
    if (!isVnAfterMarketCloseForDailySignals()) return;

    const today = vnCalendarTodayYmd();
    const tickers = await this.watchlistService.getActiveTickers();
    const pool = this.poolSize();

    await mapPool(tickers, pool, async (ticker) => {
      try {
        await this.maybeSendCloseConfirm(ticker, today);
      } catch (e) {
        this.logger.warn(
          `${ticker} close break confirm: ${(e as Error).message}`,
        );
      }
    });
  }

  private async maybeSendCloseConfirm(
    ticker: string,
    today: string,
  ): Promise<void> {
    const upper = ticker.toUpperCase();
    if (isMarketIndexTicker(upper)) return;

    const st = this.getOrResetState(upper);
    if (st.closeConfirmSent) return;

    const hasBreak = await this.signalRepo.findOne({
      where: {
        ticker: upper,
        tradingDate: today,
        type: SignalType.RESISTANCE_BREAKOUT,
      },
      select: ['id'],
    });
    if (!hasBreak) return;

    const bars = await this.loadBarsAsc(upper, 70);
    const resistance = this.resistanceFromBars(bars);
    if (resistance == null) return;

    const todayBar = bars[bars.length - 1];
    if (!todayBar || todayBar.tradingDate !== today) return;

    const close = todayBar.close;
    if (close <= resistance) return;

    const breakPct = ((close - resistance) / resistance) * 100;

    await this.telegramService.sendMessage({
      text:
        `✅ <b>${upper}</b> đóng ${this.fmtK(close)} — giữ trên cản ~${this.fmtK(resistance)}đ ` +
        `(+${breakPct.toFixed(1)}%, break 60 phiên + volume trong DB).\n` +
        `Gợi ý xem xét vào lệnh theo <b>nến ngày đã xác nhận</b> (khớp tin khuyến nghị 16:00 nếu có).\n` +
        `<i>⚠️ Tự động, không phải tư vấn.</i>`,
      parseMode: 'HTML',
    });

    st.closeConfirmSent = true;
    this.logger.log(`${upper}: đã gửi Telegram xác nhận break sau đóng cửa`);
  }
}
