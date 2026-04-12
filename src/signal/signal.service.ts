import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { BollingerBands, EMA, MACD, RSI } from 'technicalindicators';
import { Repository } from 'typeorm';
import { TelegramService } from '../telegram/telegram.service';
import { StockPrice } from '../stock/entities/stock-price.entity';
import { Signal, SignalDirection, SignalType } from './entities/signal.entity';

// Trọng số tín hiệu cho scanner summary (đồng bộ với RecommendationService)
const SUMMARY_WEIGHTS: Partial<Record<SignalType, number>> = {
  [SignalType.RESISTANCE_BREAKOUT]: 5,
  [SignalType.SUPPORT_BREAKDOWN]: 5,
  [SignalType.FAILED_BREAKOUT]: 5,
  [SignalType.VOLUME_CLIMAX_TOP]: 4,
  [SignalType.EMA_GOLDEN_CROSS]: 3.5,
  [SignalType.EMA_DEATH_CROSS]: 3.5,
  [SignalType.DISTRIBUTION_BAR]: 3.5,
  [SignalType.RSI_BEARISH_DIVERGENCE]: 3,
  [SignalType.MACD_BEARISH_DIVERGENCE]: 3,
  [SignalType.EMA_BOUNCE]: 3,
  [SignalType.EMA_BULLISH_STACK]: 2.5,
  [SignalType.EMA_BEARISH_STACK]: 2.5,
  [SignalType.RSI_MOMENTUM_UP]: 2.5,
  [SignalType.RSI_MOMENTUM_DOWN]: 2.5,
  [SignalType.BASE_FORMING]: 2,
  [SignalType.RSI_OVERSOLD]: 2,
  [SignalType.RSI_OVERBOUGHT]: 2,
  [SignalType.MACD_BULLISH_CROSS]: 2,
  [SignalType.MACD_BEARISH_CROSS]: 2,
  [SignalType.MA_GOLDEN_CROSS]: 2,
  [SignalType.MA_DEATH_CROSS]: 2,
  [SignalType.BB_BREAKOUT_UP]: 1.5,
  [SignalType.BB_BREAKOUT_DOWN]: 1.5,
  [SignalType.BULLISH_ENGULFING]: 1.5,
  [SignalType.BEARISH_ENGULFING]: 1.5,
  [SignalType.HAMMER]: 1.5,
  [SignalType.SHOOTING_STAR]: 1.5,
  [SignalType.VOLUME_SURGE]: 1,
  [SignalType.BB_SQUEEZE]: 0,
  [SignalType.DOJI]: 0,
};

interface DetectedSignal {
  type: SignalType;
  direction: SignalDirection;
  value: number | null;
  description: string;
}

interface OhlcvBar {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  tradingDate: string;
}

@Injectable()
export class SignalService {
  private readonly logger = new Logger(SignalService.name);

  constructor(
    @InjectRepository(Signal)
    private readonly signalRepo: Repository<Signal>,
    @InjectRepository(StockPrice)
    private readonly stockPriceRepo: Repository<StockPrice>,
    private readonly telegramService: TelegramService,
  ) {}

  // ─── Kiểm tra thanh khoản tối thiểu ───────────────────────────────────────
  // Yêu cầu: avg volume 30 ngày gần nhất > 100k VÀ ≥18/30 ngày có giao dịch
  async checkLiquidity(ticker: string): Promise<{
    pass: boolean;
    avgVolume: number;
    tradingDays: number;
    reason?: string;
  }> {
    const MIN_AVG_VOLUME = 100_000;
    const MIN_TRADING_DAYS = 18;

    const rows = await this.stockPriceRepo
      .createQueryBuilder('sp')
      .select(['sp.volume', 'sp.tradingDate'])
      .where('sp.ticker = :ticker', { ticker: ticker.toUpperCase() })
      .orderBy('sp.tradingDate', 'DESC')
      .limit(30)
      .getMany();

    if (rows.length < 10) {
      return { pass: false, avgVolume: 0, tradingDays: rows.length, reason: 'Quá ít dữ liệu' };
    }

    const tradingDays = rows.filter((r) => Number(r.volume) > 0).length;
    const avgVolume = rows.reduce((s, r) => s + Number(r.volume), 0) / rows.length;

    if (avgVolume < MIN_AVG_VOLUME) {
      return {
        pass: false, avgVolume, tradingDays,
        reason: `Avg vol ${Math.round(avgVolume / 1000)}k < ${MIN_AVG_VOLUME / 1000}k`,
      };
    }
    if (tradingDays < MIN_TRADING_DAYS) {
      return {
        pass: false, avgVolume, tradingDays,
        reason: `Giao dịch thưa: ${tradingDays}/30 ngày`,
      };
    }
    return { pass: true, avgVolume, tradingDays };
  }

  // ─── Phân tích và lưu tín hiệu cho một mã ───────────────────────────────

  async analyze(ticker: string): Promise<Signal[]> {
    // Kiểm tra thanh khoản trước khi phân tích
    const liq = await this.checkLiquidity(ticker);
    if (!liq.pass) {
      this.logger.warn(`${ticker}: bỏ qua — ${liq.reason}`);
      return [];
    }
    // Cần 130 bars: EMA100 + 30 buffer, breakout lookback 60 phiên
    const bars = await this.loadBars(ticker, 130);
    if (bars.length < 65) {
      this.logger.warn(
        `${ticker}: không đủ dữ liệu (${bars.length} nến, cần ≥65)`,
      );
      return [];
    }

    const latest = bars[bars.length - 1];
    const detected = [
      ...this.detectRsi(bars),
      ...this.detectMacd(bars),
      ...this.detectBollingerBands(bars),
      ...this.detectEmaCross(bars),
      ...this.detectEmaStack(bars),
      ...this.detectEmaBounce(bars),
      ...this.detectBase(bars),
      ...this.detectResistanceBreakout(bars),
      ...this.detectSupportBreakdown(bars),
      // ── Phân phối đỉnh ──────────────────────────────────────────
      ...this.detectRsiBearishDivergence(bars),
      ...this.detectMacdBearishDivergence(bars),
      ...this.detectVolumeClimaxTop(bars),
      ...this.detectDistributionBar(bars),
      ...this.detectFailedBreakout(bars),
      // ────────────────────────────────────────────────────────────
      ...this.detectCandlestickPatterns(bars),
      ...this.detectVolumeSurge(bars),
    ];

    const saved: Signal[] = [];
    for (const s of detected) {
      const exists = await this.signalRepo.findOne({
        where: { ticker, tradingDate: latest.tradingDate, type: s.type },
      });
      if (!exists) {
        const entity = this.signalRepo.create({
          ticker,
          tradingDate: latest.tradingDate,
          ...s,
          notified: false,
        });
        saved.push(await this.signalRepo.save(entity));
      }
    }

    this.logger.log(
      `${ticker}: ${saved.length} tín hiệu mới (${latest.tradingDate})`,
    );
    return saved;
  }

  // ─── Phân tích toàn bộ lịch sử (sliding window) ──────────────────────────
  // Với mỗi ngày từ `from` đến nay, chạy lại bộ detect trên slice 130 bars
  // Kết quả lưu vào DB theo (ticker, tradingDate, type) — INSERT IGNORE
  async analyzeAllHistory(
    ticker: string,
    from?: string,
  ): Promise<{ analyzed: number; saved: number }> {
    const MIN_BARS = 130;
    const startDate = from ?? '2025-01-01';

    // Load tất cả bars một lần duy nhất (ASC)
    const allBars = await this.loadAllBars(ticker);
    if (allBars.length < MIN_BARS) {
      this.logger.warn(`${ticker}: không đủ dữ liệu lịch sử (${allBars.length} nến)`);
      return { analyzed: 0, saved: 0 };
    }

    let analyzed = 0;
    let saved = 0;

    for (let i = MIN_BARS - 1; i < allBars.length; i++) {
      const tradingDate = allBars[i]!.tradingDate;
      if (tradingDate < startDate) continue;

      const slice = allBars.slice(i - MIN_BARS + 1, i + 1);

      const detected = [
        ...this.detectRsi(slice),
        ...this.detectMacd(slice),
        ...this.detectBollingerBands(slice),
        ...this.detectEmaCross(slice),
        ...this.detectEmaStack(slice),
        ...this.detectEmaBounce(slice),
        ...this.detectBase(slice),
        ...this.detectResistanceBreakout(slice),
        ...this.detectSupportBreakdown(slice),
        ...this.detectRsiBearishDivergence(slice),
        ...this.detectMacdBearishDivergence(slice),
        ...this.detectVolumeClimaxTop(slice),
        ...this.detectDistributionBar(slice),
        ...this.detectFailedBreakout(slice),
        ...this.detectCandlestickPatterns(slice),
        ...this.detectVolumeSurge(slice),
      ];

      if (detected.length > 0) {
        // Raw INSERT IGNORE — tránh lỗi TypeORM "entity id not set"
        const COLS =
          '(`ticker`, `tradingDate`, `type`, `direction`, `value`, `description`, `notified`)';
        const placeholders = detected.map(() => '(?,?,?,?,?,?,?)').join(',');
        const params = detected.flatMap((s) => [
          ticker.toUpperCase(),
          tradingDate,
          s.type,
          s.direction,
          s.value,
          s.description,
          true,
        ]);
        const result = (await this.signalRepo.query(
          `INSERT IGNORE INTO signals ${COLS} VALUES ${placeholders}`,
          params,
        )) as { affectedRows?: number };
        saved += result?.affectedRows ?? 0;
      }
      analyzed++;
    }

    this.logger.log(
      `${ticker}: analyzeHistory done — ${analyzed} ngày, ${saved} tín hiệu mới`,
    );
    return { analyzed, saved };
  }

  // Lấy tín hiệu cho chart (tất cả, grouped by date) — không giới hạn
  async getSignalsForChart(
    ticker: string,
    from?: string,
  ): Promise<{ tradingDate: string; direction: string; type: string; description: string | null }[]> {
    const qb = this.signalRepo
      .createQueryBuilder('s')
      .select(['s.tradingDate', 's.direction', 's.type', 's.description'])
      .where('s.ticker = :ticker', { ticker: ticker.toUpperCase() });
    if (from) qb.andWhere('s.tradingDate >= :from', { from });
    qb.orderBy('s.tradingDate', 'ASC');
    return qb.getMany();
  }

  // Phân tích và gửi Telegram ngay
  async analyzeAndNotify(ticker: string): Promise<void> {
    // Phân tích tín hiệu mới, sau đó lấy tất cả chưa gửi từ DB
    await this.analyze(ticker);

    const unnotified = await this.signalRepo.find({
      where: { ticker: ticker.toUpperCase(), notified: false },
      order: { tradingDate: 'DESC' },
    });

    if (!unnotified.length) return;

    const lines = unnotified
      .map(
        (s) =>
          `${directionEmoji(s.direction)} <b>${s.type}</b>: ${s.description}`,
      )
      .join('\n');

    await this.telegramService.sendStockAlert(
      ticker,
      `<b>Phát hiện ${unnotified.length} tín hiệu đảo chiều</b>\n\n${lines}`,
    );

    await this.signalRepo.update(
      unnotified.map((s) => s.id),
      { notified: true },
    );
  }

  // Lấy tín hiệu đã lưu
  async getSignals(ticker: string, date?: string): Promise<Signal[]> {
    const qb = this.signalRepo
      .createQueryBuilder('s')
      .where('s.ticker = :ticker', { ticker })
      .orderBy('s.tradingDate', 'DESC')
      .addOrderBy('s.createdAt', 'DESC');

    if (date) qb.andWhere('s.tradingDate = :date', { date });

    return qb.getMany();
  }

  // Tổng hợp tín hiệu mới nhất cho danh sách mã — dùng cho Scanner dashboard
  async getSignalsSummary(tickers: string[]): Promise<
    Record<
      string,
      {
        tradingDate: string;
        bullish: string[];
        bearish: string[];
        topSignal: string | null;
        direction: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
        score: number; // điểm thực (có thể âm)
        stars: 0 | 1 | 2 | 3; // 0–3 sao
        confidence: 'HIGH' | 'MEDIUM' | 'LOW';
      }
    >
  > {
    if (!tickers.length) return {};

    // Lấy trading date mới nhất của từng mã
    const latestDates = await this.signalRepo
      .createQueryBuilder('s')
      .select('s.ticker', 'ticker')
      .addSelect('MAX(s.tradingDate)', 'latestDate')
      .where('s.ticker IN (:...tickers)', {
        tickers: tickers.map((t) => t.toUpperCase()),
      })
      .groupBy('s.ticker')
      .getRawMany<{ ticker: string; latestDate: string }>();

    if (!latestDates.length) return {};

    // Lấy tất cả tín hiệu của ngày mới nhất cho mỗi mã trong 1 query
    const conditions = latestDates
      .map((_, i) => `(s.ticker = :t${i} AND s.tradingDate = :d${i})`)
      .join(' OR ');
    const params: Record<string, string> = {};
    latestDates.forEach(({ ticker, latestDate }, i) => {
      params[`t${i}`] = ticker;
      params[`d${i}`] = latestDate;
    });

    const signals = await this.signalRepo
      .createQueryBuilder('s')
      .where(conditions, params)
      .getMany();

    const result: Record<
      string,
      {
        tradingDate: string;
        bullish: string[];
        bearish: string[];
        topSignal: string | null;
        direction: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
        score: number;
        stars: 0 | 1 | 2 | 3;
        confidence: 'HIGH' | 'MEDIUM' | 'LOW';
      }
    > = {};

    for (const { ticker, latestDate } of latestDates) {
      const tickerSigs = signals.filter((s) => s.ticker === ticker);
      const bullish = tickerSigs
        .filter((s) => s.direction === SignalDirection.BULLISH)
        .map((s) => s.type);
      const bearish = tickerSigs
        .filter((s) => s.direction === SignalDirection.BEARISH)
        .map((s) => s.type);

      // ── Tính điểm theo trọng số giống RecommendationService ─────────────
      let rawScore = 0;
      for (const t of bullish)
        rawScore += SUMMARY_WEIGHTS[t as SignalType] ?? 1;
      for (const t of bearish)
        rawScore -= SUMMARY_WEIGHTS[t as SignalType] ?? 1;
      const score = Math.round(Math.max(-10, Math.min(10, rawScore)) * 10) / 10;

      // ── Số sao ───────────────────────────────────────────────────────────
      const absScore = Math.abs(score);
      const stars: 0 | 1 | 2 | 3 =
        absScore >= 7 ? 3 : absScore >= 4.5 ? 2 : absScore >= 2.5 ? 1 : 0;

      // ── Độ tin cậy ───────────────────────────────────────────────────────
      const totalSigs = bullish.length + bearish.length;
      const confidence: 'HIGH' | 'MEDIUM' | 'LOW' =
        stars >= 3 && totalSigs >= 3
          ? 'HIGH'
          : stars >= 2 || totalSigs >= 2
            ? 'MEDIUM'
            : 'LOW';

      // ── Ưu tiên hiển thị tín hiệu mạnh ──────────────────────────────────
      const HIGH_PRIORITY: string[] = [
        SignalType.RESISTANCE_BREAKOUT,
        SignalType.FAILED_BREAKOUT,
        SignalType.VOLUME_CLIMAX_TOP,
        SignalType.DISTRIBUTION_BAR,
        SignalType.EMA_GOLDEN_CROSS,
        SignalType.EMA_DEATH_CROSS,
        SignalType.BASE_FORMING,
        SignalType.EMA_BOUNCE,
      ];
      const topBull =
        bullish.find((s) => HIGH_PRIORITY.includes(s)) ?? bullish[0] ?? null;
      const topBear =
        bearish.find((s) => HIGH_PRIORITY.includes(s)) ?? bearish[0] ?? null;

      const direction: 'BULLISH' | 'BEARISH' | 'NEUTRAL' =
        score <= -2.5 ? 'BEARISH' : score >= 2.5 ? 'BULLISH' : 'NEUTRAL';

      const topSignal =
        direction === 'BEARISH'
          ? (topBear ?? null)
          : (topBull ?? topBear ?? null);

      result[ticker] = {
        tradingDate: latestDate,
        bullish,
        bearish,
        topSignal,
        direction,
        score,
        stars,
        confidence,
      };
    }

    return result;
  }

  // ─── Indicators ──────────────────────────────────────────────────────────

  private detectRsi(bars: OhlcvBar[]): DetectedSignal[] {
    const closes = bars.map((b) => b.close);
    const results = RSI.calculate({ values: closes, period: 14 });
    if (results.length < 2) return [];

    const rsi = results[results.length - 1]!;
    const prevRsi = results[results.length - 2]!;
    const signals: DetectedSignal[] = [];

    if (rsi < 30) {
      signals.push({
        type: SignalType.RSI_OVERSOLD,
        direction: SignalDirection.BULLISH,
        value: rsi,
        description: `RSI=${rsi.toFixed(2)} < 30 → vùng bán quá mức, khả năng đảo chiều tăng`,
      });
    } else if (rsi > 70) {
      signals.push({
        type: SignalType.RSI_OVERBOUGHT,
        direction: SignalDirection.BEARISH,
        value: rsi,
        description: `RSI=${rsi.toFixed(2)} > 70 → vùng mua quá mức, khả năng đảo chiều giảm`,
      });
    }

    // RSI vượt 50 từ dưới lên → momentum tăng (tín hiệu nền tốt)
    if (prevRsi < 50 && rsi >= 50 && rsi <= 70) {
      signals.push({
        type: SignalType.RSI_MOMENTUM_UP,
        direction: SignalDirection.BULLISH,
        value: rsi,
        description: `RSI vượt 50 (${prevRsi.toFixed(1)}→${rsi.toFixed(1)}) → momentum tăng, xu hướng lành mạnh`,
      });
    }
    // RSI rớt dưới 50 → momentum yếu
    if (prevRsi >= 50 && rsi < 50) {
      signals.push({
        type: SignalType.RSI_MOMENTUM_DOWN,
        direction: SignalDirection.BEARISH,
        value: rsi,
        description: `RSI rớt dưới 50 (${prevRsi.toFixed(1)}→${rsi.toFixed(1)}) → momentum giảm`,
      });
    }

    return signals;
  }

  private detectMacd(bars: OhlcvBar[]): DetectedSignal[] {
    const closes = bars.map((b) => b.close);
    const results = MACD.calculate({
      values: closes,
      fastPeriod: 12,
      slowPeriod: 26,
      signalPeriod: 9,
      SimpleMAOscillator: false,
      SimpleMASignal: false,
    });

    if (results.length < 2) return [];
    const prev = results[results.length - 2];
    const curr = results[results.length - 1];

    if (
      prev.MACD !== undefined &&
      prev.signal !== undefined &&
      curr.MACD !== undefined &&
      curr.signal !== undefined
    ) {
      // MACD vừa cắt lên signal line
      if (prev.MACD < prev.signal && curr.MACD > curr.signal) {
        return [
          {
            type: SignalType.MACD_BULLISH_CROSS,
            direction: SignalDirection.BULLISH,
            value: curr.MACD,
            description: `MACD(${curr.MACD.toFixed(2)}) cắt lên Signal(${curr.signal.toFixed(2)}) → xu hướng tăng`,
          },
        ];
      }
      // MACD vừa cắt xuống signal line
      if (prev.MACD > prev.signal && curr.MACD < curr.signal) {
        return [
          {
            type: SignalType.MACD_BEARISH_CROSS,
            direction: SignalDirection.BEARISH,
            value: curr.MACD,
            description: `MACD(${curr.MACD.toFixed(2)}) cắt xuống Signal(${curr.signal.toFixed(2)}) → xu hướng giảm`,
          },
        ];
      }
    }
    return [];
  }

  private detectBollingerBands(bars: OhlcvBar[]): DetectedSignal[] {
    const closes = bars.map((b) => b.close);
    const results = BollingerBands.calculate({
      values: closes,
      period: 20,
      stdDev: 2,
    });

    if (!results.length) return [];
    const bb = results[results.length - 1]!;
    const close = closes[closes.length - 1]!;
    const signals: DetectedSignal[] = [];

    // BB Lower chạm → oversold, cơ hội mua
    if (close < bb.lower) {
      signals.push({
        type: SignalType.BB_BREAKOUT_DOWN,
        direction: SignalDirection.BULLISH,
        value: close,
        description: `Giá chạm BB Lower(${(bb.lower / 1000).toFixed(1)}k) → oversold, khả năng bật`,
      });
    }

    // BB Upper: chỉ bearish nếu KHÔNG phải breakout mạnh
    // Nếu cùng lúc có volume bình thường + không phải nến xanh mạnh → overbought
    if (close > bb.upper) {
      const curr = bars[bars.length - 1]!;
      const avgVol =
        bars
          .slice(-20, -1)
          .map((b) => b.volume)
          .reduce((s, v) => s + v, 0) / 19;
      const isStrongBreakout =
        curr.volume >= avgVol * 2 &&
        curr.close > curr.open &&
        Math.abs(curr.close - curr.open) / (curr.high - curr.low || 1) >= 0.5;

      if (!isStrongBreakout) {
        // Vượt BB upper nhưng không có lực → overbought ngắn hạn
        signals.push({
          type: SignalType.BB_BREAKOUT_UP,
          direction: SignalDirection.BEARISH,
          value: close,
          description: `Giá vượt BB Upper(${(bb.upper / 1000).toFixed(1)}k) không có lực → overbought ngắn hạn`,
        });
      }
      // Nếu là breakout mạnh: bỏ qua (không phạt, RESISTANCE_BREAKOUT sẽ xử lý)
    }

    // BB Squeeze: bandwidth < 8% → sắp bùng phát (tín hiệu trung tính, cần chờ hướng)
    const bandwidth = (bb.upper - bb.lower) / bb.middle;
    if (bandwidth < 0.08) {
      signals.push({
        type: SignalType.BB_SQUEEZE,
        direction: SignalDirection.NEUTRAL,
        value: bandwidth,
        description: `BB Squeeze (BW=${(bandwidth * 100).toFixed(1)}%) → năng lượng tích tụ, sắp có sóng lớn`,
      });
    }

    return signals;
  }

  private detectEmaCross(bars: OhlcvBar[]): DetectedSignal[] {
    const closes = bars.map((b) => b.close);
    if (closes.length < 51) return [];

    const ema20 = EMA.calculate({ values: closes, period: 20 });
    const ema50 = EMA.calculate({ values: closes, period: 50 });
    if (ema20.length < 2 || ema50.length < 2) return [];

    const offset = ema20.length - ema50.length;
    const prevEma20 = ema20[ema20.length - 2]!;
    const currEma20 = ema20[ema20.length - 1]!;
    const prevEma50 = ema50[ema50.length - 2 - Math.max(0, offset)]!;
    const currEma50 = ema50[ema50.length - 1]!;

    if (prevEma20 <= prevEma50 && currEma20 > currEma50) {
      return [
        {
          type: SignalType.EMA_GOLDEN_CROSS,
          direction: SignalDirection.BULLISH,
          value: currEma20,
          description: `EMA20(${currEma20.toFixed(0)}) cắt lên EMA50(${currEma50.toFixed(0)}) → Golden Cross, uptrend bắt đầu`,
        },
      ];
    }
    if (prevEma20 >= prevEma50 && currEma20 < currEma50) {
      return [
        {
          type: SignalType.EMA_DEATH_CROSS,
          direction: SignalDirection.BEARISH,
          value: currEma20,
          description: `EMA20(${currEma20.toFixed(0)}) cắt xuống EMA50(${currEma50.toFixed(0)}) → Death Cross, downtrend`,
        },
      ];
    }
    return [];
  }

  private detectEmaStack(bars: OhlcvBar[]): DetectedSignal[] {
    const closes = bars.map((b) => b.close);
    if (closes.length < 51) return [];

    const ema20 = EMA.calculate({ values: closes, period: 20 });
    const ema50 = EMA.calculate({ values: closes, period: 50 });
    // EMA100 nếu có đủ dữ liệu — bộ lọc xu hướng vĩ mô
    const ema100 =
      closes.length >= 100
        ? EMA.calculate({ values: closes, period: 100 })
        : null;

    if (!ema20.length || !ema50.length) return [];

    const currClose = closes[closes.length - 1]!;
    const currEma20 = ema20[ema20.length - 1]!;
    const currEma50 = ema50[ema50.length - 1]!;
    const currEma100 = ema100 ? (ema100[ema100.length - 1] ?? null) : null;
    const signals: DetectedSignal[] = [];

    // Bullish stack đầy đủ: giá > EMA20 > EMA50 > EMA100 (macro uptrend)
    if (
      currClose > currEma20 &&
      currEma20 > currEma50 &&
      (currEma100 === null || currEma50 > currEma100)
    ) {
      const macroStr =
        currEma100 !== null
          ? ` > EMA100(${(currEma100 / 1000).toFixed(1)}k)`
          : ' (chưa đủ dữ liệu EMA100)';
      signals.push({
        type: SignalType.EMA_BULLISH_STACK,
        direction: SignalDirection.BULLISH,
        value: currEma20,
        description: `Giá(${(currClose / 1000).toFixed(1)}k) > EMA20 > EMA50${macroStr} → nền tăng lành mạnh`,
      });
    }

    // Bearish stack: giá < EMA20 < EMA50
    if (currClose < currEma20 && currEma20 < currEma50) {
      signals.push({
        type: SignalType.EMA_BEARISH_STACK,
        direction: SignalDirection.BEARISH,
        value: currEma20,
        description: `Giá(${(currClose / 1000).toFixed(1)}k) < EMA20(${(currEma20 / 1000).toFixed(1)}k) < EMA50(${(currEma50 / 1000).toFixed(1)}k) → xu hướng giảm`,
      });
    }

    return signals;
  }

  private detectEmaBounce(bars: OhlcvBar[]): DetectedSignal[] {
    if (bars.length < 51) return [];
    const closes = bars.map((b) => b.close);
    const lows = bars.map((b) => b.low);

    const ema20 = EMA.calculate({ values: closes, period: 20 });
    const ema50 = EMA.calculate({ values: closes, period: 50 });
    if (ema20.length < 3 || ema50.length < 3) return [];

    const curr = bars[bars.length - 1]!;
    const prev = bars[bars.length - 2]!;
    const currEma20 = ema20[ema20.length - 1]!;
    const prevEma20 = ema20[ema20.length - 2]!;
    const currEma50 = ema50[ema50.length - 1]!;
    const prevEma50 = ema50[ema50.length - 2]!;

    // Bounce từ EMA20: phiên trước low chạm EMA20, phiên này đóng cửa trên EMA20
    const touchedEma20 =
      prev.low <= prevEma20 * 1.005 && curr.close > currEma20;
    if (touchedEma20 && curr.close > curr.open) {
      return [
        {
          type: SignalType.EMA_BOUNCE,
          direction: SignalDirection.BULLISH,
          value: currEma20,
          description: `Nảy từ EMA20(${(currEma20 / 1000).toFixed(1)}k) → pullback kết thúc, tiếp tục xu hướng tăng`,
        },
      ];
    }

    // Bounce từ EMA50: phiên trước low chạm EMA50
    const touchedEma50 =
      prev.low <= prevEma50 * 1.005 && curr.close > currEma50;
    if (touchedEma50 && curr.close > curr.open) {
      return [
        {
          type: SignalType.EMA_BOUNCE,
          direction: SignalDirection.BULLISH,
          value: currEma50,
          description: `Nảy từ EMA50(${(currEma50 / 1000).toFixed(1)}k) → hỗ trợ mạnh, cơ hội mua`,
        },
      ];
    }

    void lows; // suppress unused warning
    return [];
  }

  private detectBase(bars: OhlcvBar[]): DetectedSignal[] {
    if (bars.length < 25) return [];

    // Nền 20 phiên (~4 tuần) — đủ chất lượng cho trung dài hạn
    const BASE_PERIOD = 20;
    const baseBars = bars.slice(-(BASE_PERIOD + 1), -1);
    const closes = baseBars.map((b) => b.close);
    const highs = baseBars.map((b) => b.high);
    const lows = baseBars.map((b) => b.low);
    const volumes = baseBars.map((b) => b.volume);

    const avgClose = closes.reduce((s, v) => s + v, 0) / closes.length;
    const maxHigh = Math.max(...highs);
    const minLow = Math.min(...lows);
    const rangeRatio = (maxHigh - minLow) / avgClose;

    // Nền ổn định: range < 10% (dài hơn nên cho phép rộng hơn chút)
    if (rangeRatio > 0.1) return [];

    // Volume trong nền phải thu hẹp — không có distribution (bán tháo)
    const avgVolBase = volumes.reduce((s, v) => s + v, 0) / volumes.length;
    const longerAvgVol =
      bars
        .slice(-41)
        .map((b) => b.volume)
        .reduce((s, v) => s + v, 0) / 40;
    if (avgVolBase > longerAvgVol * 1.2) return [];

    // Thêm: xu hướng trước khi tạo nền phải là tăng (close 20 phiên trước < close đầu nền)
    const priorBar = bars[bars.length - BASE_PERIOD - 5];
    const firstBaseClose = closes[0]!;
    const priorIsUptrend = priorBar
      ? priorBar.close < firstBaseClose * 1.05
      : true;
    if (!priorIsUptrend) return [];

    return [
      {
        type: SignalType.BASE_FORMING,
        direction: SignalDirection.BULLISH,
        value: rangeRatio * 100,
        description: `Nền ${BASE_PERIOD} phiên (biên độ=${(rangeRatio * 100).toFixed(1)}%, vol thu hẹp) → setup chất lượng, chờ break`,
      },
    ];
  }

  private detectResistanceBreakout(bars: OhlcvBar[]): DetectedSignal[] {
    if (bars.length < 62) return [];

    const curr = bars[bars.length - 1]!;
    // Kháng cự = highest high của 60 phiên trước (~3 tháng)
    const prevBars = bars.slice(-61, -1);
    const resistance = Math.max(...prevBars.map((b) => b.high));
    const avgVol =
      prevBars.map((b) => b.volume).reduce((s, v) => s + v, 0) /
      prevBars.length;

    const body = Math.abs(curr.close - curr.open);
    const range = curr.high - curr.low;
    const bodyRatio = range > 0 ? body / range : 0;

    // Break cản 3 tháng + volume ≥ 2x + thân nến ≥ 50% + nến xanh
    if (
      curr.close > resistance &&
      curr.volume >= avgVol * 2.0 &&
      bodyRatio >= 0.5 &&
      curr.close > curr.open
    ) {
      const breakPercent = ((curr.close - resistance) / resistance) * 100;
      return [
        {
          type: SignalType.RESISTANCE_BREAKOUT,
          direction: SignalDirection.BULLISH,
          value: curr.close,
          description: `Break đỉnh 60 phiên ${(resistance / 1000).toFixed(1)}k (+${breakPercent.toFixed(1)}%) | KL=${(curr.volume / avgVol).toFixed(1)}x | Thân=${(bodyRatio * 100).toFixed(0)}% → breakout dài hạn`,
        },
      ];
    }
    return [];
  }

  private detectSupportBreakdown(bars: OhlcvBar[]): DetectedSignal[] {
    if (bars.length < 62) return [];

    const curr = bars[bars.length - 1]!;
    const prevBars = bars.slice(-61, -1);
    const support = Math.min(...prevBars.map((b) => b.low));
    const avgVol =
      prevBars.map((b) => b.volume).reduce((s, v) => s + v, 0) /
      prevBars.length;

    const body = Math.abs(curr.close - curr.open);
    const range = curr.high - curr.low;
    const bodyRatio = range > 0 ? body / range : 0;

    if (
      curr.close < support &&
      curr.volume >= avgVol * 2.0 &&
      bodyRatio >= 0.5 &&
      curr.close < curr.open
    ) {
      return [
        {
          type: SignalType.SUPPORT_BREAKDOWN,
          direction: SignalDirection.BEARISH,
          value: curr.close,
          description: `Thủng đáy 60 phiên ${(support / 1000).toFixed(1)}k | KL=${(curr.volume / avgVol).toFixed(1)}x → cảnh báo giảm nghiêm trọng`,
        },
      ];
    }
    return [];
  }

  // ─── Phân phối đỉnh ──────────────────────────────────────────────────────

  /**
   * Kiểm tra cổ phiếu đã tăng đủ mạnh từ nền trước khi có thể "phân phối đỉnh"
   * Điều kiện:
   *  1. Giá đã tăng ≥ minRise (15%) từ đáy của lookback phiên gần nhất
   *  2. Giá hiện tại ở upper 40% của range → đang thực sự ở vùng đỉnh
   */
  private hasUptrendToDistribute(
    bars: OhlcvBar[],
    lookback = 60,
    minRise = 0.15,
  ): boolean {
    if (bars.length < lookback) return false;

    const recentBars = bars.slice(-lookback);
    const currClose = bars[bars.length - 1]!.close;
    const low = Math.min(...recentBars.map((b) => b.low));
    const high = Math.max(...recentBars.map((b) => b.high));

    // Phải có uptrend ít nhất minRise từ đáy trong lookback phiên
    const riseFromLow = (currClose - low) / low;
    if (riseFromLow < minRise) return false;

    // Giá hiện tại phải ở upper 40% của range → đang ở vùng đỉnh thực sự
    const pricePosition = high > low ? (currClose - low) / (high - low) : 0;
    return pricePosition >= 0.6;
  }

  /**
   * RSI Bearish Divergence — Mô hình 2 đỉnh (Double Top) với RSI phân kỳ âm:
   *  - Điều kiện BẮT BUỘC: giá đã tăng ≥15% từ đáy 60 phiên (có uptrend thực sự)
   *  - Giá tạo đỉnh 2 cao hơn đỉnh 1 ít nhất 1%
   *  - Giữa 2 đỉnh có pullback ≥3% (xác nhận đây là double top, không phải noise)
   *  - RSI tại đỉnh 2 thấp hơn đỉnh 1 ít nhất 4 điểm → phân kỳ âm rõ ràng
   */
  private detectRsiBearishDivergence(bars: OhlcvBar[]): DetectedSignal[] {
    if (bars.length < 40) return [];

    // Điều kiện tiên quyết: phải có uptrend mạnh từ nền
    if (!this.hasUptrendToDistribute(bars, 60, 0.15)) return [];

    const closes = bars.map((b) => b.close);
    const rsiArr = RSI.calculate({ values: closes, period: 14 });
    if (rsiArr.length < 20) return [];

    const rsiOffset = bars.length - rsiArr.length;

    // Tìm các đỉnh giá trong 40 phiên gần nhất (window rộng hơn để bắt double top)
    const lookback = bars.slice(-40);
    const peaks: Array<{ idx: number; price: number; rsi: number }> = [];

    for (let i = 2; i < lookback.length - 2; i++) {
      const bar = lookback[i]!;
      // Đỉnh rõ ràng: cao hơn 2 nến hai bên
      if (
        bar.high > lookback[i - 1]!.high &&
        bar.high > lookback[i - 2]!.high &&
        bar.high > lookback[i + 1]!.high &&
        bar.high > lookback[i + 2]!.high
      ) {
        const absIdx = bars.length - 40 + i;
        const rsiIdx = absIdx - rsiOffset;
        const rsi = rsiArr[rsiIdx];
        if (rsi !== undefined) {
          peaks.push({ idx: absIdx, price: bar.high, rsi });
        }
      }
    }

    if (peaks.length < 2) return [];
    const p1 = peaks[peaks.length - 2]!;
    const p2 = peaks[peaks.length - 1]!;

    // Hai đỉnh phải cách nhau ít nhất 5 phiên
    if (p2.idx - p1.idx < 5) return [];

    // Phải có pullback ≥3% giữa 2 đỉnh → xác nhận double top thật sự
    const betweenBars = bars.slice(p1.idx, p2.idx + 1);
    const troughBetween = Math.min(...betweenBars.map((b) => b.low));
    const pullback = (p1.price - troughBetween) / p1.price;
    if (pullback < 0.03) return [];

    // Điều kiện chính: giá đỉnh 2 cao hơn ≥1%, RSI đỉnh 2 thấp hơn ≥4 điểm
    if (p2.price > p1.price * 1.01 && p2.rsi < p1.rsi - 4) {
      return [
        {
          type: SignalType.RSI_BEARISH_DIVERGENCE,
          direction: SignalDirection.BEARISH,
          value: p2.rsi,
          description: `Double Top + RSI phân kỳ âm: đỉnh ${(p2.price / 1000).toFixed(1)}k > ${(p1.price / 1000).toFixed(1)}k nhưng RSI ${p2.rsi.toFixed(1)} < ${p1.rsi.toFixed(1)} (pullback ${(pullback * 100).toFixed(1)}%) → phân phối đỉnh`,
        },
      ];
    }
    return [];
  }

  /**
   * MACD Bearish Divergence: histogram MACD yếu dần trong khi giá vẫn ở vùng cao
   * Điều kiện BẮT BUỘC: phải có uptrend thực sự trước đó
   */
  private detectMacdBearishDivergence(bars: OhlcvBar[]): DetectedSignal[] {
    if (bars.length < 40) return [];

    // Điều kiện tiên quyết: phải có uptrend mạnh từ nền
    if (!this.hasUptrendToDistribute(bars, 60, 0.15)) return [];

    const closes = bars.map((b) => b.close);
    const macdArr = MACD.calculate({
      values: closes,
      fastPeriod: 12,
      slowPeriod: 26,
      signalPeriod: 9,
      SimpleMAOscillator: false,
      SimpleMASignal: false,
    });
    if (macdArr.length < 15) return [];

    // So sánh 2 phiên đỉnh gần nhất của MACD histogram
    const histograms = macdArr
      .slice(-15)
      .map((m) =>
        m.MACD !== undefined && m.signal !== undefined
          ? m.MACD - m.signal
          : null,
      );

    // Tìm 2 đỉnh histogram dương
    const histPeaks: Array<{ idx: number; val: number }> = [];
    for (let i = 1; i < histograms.length - 1; i++) {
      const curr = histograms[i];
      const prev = histograms[i - 1];
      const next = histograms[i + 1];
      if (
        curr !== null &&
        prev !== null &&
        next !== null &&
        curr > 0 &&
        curr > prev &&
        curr > next
      ) {
        histPeaks.push({ idx: i, val: curr });
      }
    }

    if (histPeaks.length < 2) return [];
    const h1 = histPeaks[histPeaks.length - 2]!;
    const h2 = histPeaks[histPeaks.length - 1]!;

    // Histogram đỉnh sau yếu hơn đáng kể (30%) trong khi giá vẫn tăng
    const recentHighs = bars.slice(-15).map((b) => b.high);
    const priceAtH1 = recentHighs[h1.idx] ?? 0;
    const priceAtH2 = recentHighs[h2.idx] ?? 0;

    if (h2.val < h1.val * 0.7 && priceAtH2 >= priceAtH1 * 0.99) {
      return [
        {
          type: SignalType.MACD_BEARISH_DIVERGENCE,
          direction: SignalDirection.BEARISH,
          value: h2.val,
          description: `MACD phân kỳ giảm tại đỉnh: momentum suy yếu (hist ${h2.val.toFixed(0)} < ${h1.val.toFixed(0)}) dù giá không giảm → lực mua cạn ở vùng đỉnh`,
        },
      ];
    }
    return [];
  }

  /**
   * Volume Climax Top: khối lượng đột biến ≥ 3x ở vùng đỉnh
   * nhưng đóng cửa yếu (dưới nửa dưới của range) → smart money xả hàng
   * Điều kiện BẮT BUỘC: phải có uptrend thực sự trước đó
   */
  private detectVolumeClimaxTop(bars: OhlcvBar[]): DetectedSignal[] {
    if (bars.length < 21) return [];

    // Điều kiện tiên quyết: phải có uptrend mạnh từ nền
    if (!this.hasUptrendToDistribute(bars, 60, 0.15)) return [];

    const curr = bars[bars.length - 1]!;
    const prevBars = bars.slice(-21, -1);
    const avgVol =
      prevBars.map((b) => b.volume).reduce((s, v) => s + v, 0) /
      prevBars.length;

    // Volume climax: ≥ 3x average
    if (curr.volume < avgVol * 3) return [];

    // Giá ở vùng cao (trong 40% đỉnh của 60 phiên)
    const longerBars = bars.slice(-60);
    const recentHigh = Math.max(...longerBars.map((b) => b.high));
    const recentLow = Math.min(...longerBars.map((b) => b.low));
    const pricePosition =
      recentHigh > recentLow
        ? (curr.close - recentLow) / (recentHigh - recentLow)
        : 0;

    if (pricePosition < 0.6) return []; // không ở vùng đỉnh → bỏ qua

    // Đóng cửa yếu: close nằm dưới 40% range của chính nến đó
    const range = curr.high - curr.low;
    const closePosition = range > 0 ? (curr.close - curr.low) / range : 0.5;

    if (closePosition < 0.4) {
      return [
        {
          type: SignalType.VOLUME_CLIMAX_TOP,
          direction: SignalDirection.BEARISH,
          value: curr.volume / avgVol,
          description: `Climax volume tại đỉnh: KL=${(curr.volume / avgVol).toFixed(1)}x, đóng cửa yếu (${(closePosition * 100).toFixed(0)}% range) → smart money xả hàng`,
        },
      ];
    }
    return [];
  }

  /**
   * Distribution Bar (Wyckoff): nến biên độ rộng ở đỉnh,
   * close gần low, volume cao → phiên phân phối điển hình
   * Điều kiện BẮT BUỘC: phải có uptrend thực sự trước đó
   */
  private detectDistributionBar(bars: OhlcvBar[]): DetectedSignal[] {
    if (bars.length < 21) return [];

    // Điều kiện tiên quyết: phải có uptrend mạnh từ nền
    if (!this.hasUptrendToDistribute(bars, 60, 0.15)) return [];

    const curr = bars[bars.length - 1]!;
    const prevBars = bars.slice(-21, -1);

    const avgVol =
      prevBars.map((b) => b.volume).reduce((s, v) => s + v, 0) /
      prevBars.length;
    const avgRange =
      prevBars.map((b) => b.high - b.low).reduce((s, v) => s + v, 0) /
      prevBars.length;

    const range = curr.high - curr.low;
    const closePosition = range > 0 ? (curr.close - curr.low) / range : 0.5;
    const upperShadow = curr.high - Math.max(curr.open, curr.close);

    // Distribution bar: biên độ rộng (>1.5x avg), volume cao (>1.5x),
    // đóng cửa gần đáy (<35%), bóng trên dài (>25% range)
    if (
      range > avgRange * 1.5 &&
      curr.volume > avgVol * 1.5 &&
      closePosition < 0.35 &&
      upperShadow > range * 0.25
    ) {
      return [
        {
          type: SignalType.DISTRIBUTION_BAR,
          direction: SignalDirection.BEARISH,
          value: closePosition,
          description: `Nến phân phối Wyckoff tại đỉnh: biên độ ${(range / avgRange).toFixed(1)}x, đóng gần đáy (${(closePosition * 100).toFixed(0)}%), KL=${(curr.volume / avgVol).toFixed(1)}x → xả hàng`,
        },
      ];
    }
    return [];
  }

  /**
   * Failed Breakout (Bull Trap): intraday vượt đỉnh nhưng đóng cửa dưới đỉnh cũ
   * + nến đỏ → bẫy tăng, áp lực bán mạnh ở vùng kháng cự
   * Điều kiện BẮT BUỘC: phải có uptrend trước đó mới có "đỉnh" để breakout thất bại
   */
  private detectFailedBreakout(bars: OhlcvBar[]): DetectedSignal[] {
    if (bars.length < 22) return [];

    // Điều kiện tiên quyết: phải có uptrend — mới có "đỉnh" thực để bull trap
    if (!this.hasUptrendToDistribute(bars, 60, 0.10)) return []; // 10% là đủ cho bull trap

    const curr = bars[bars.length - 1]!;
    const prevBars = bars.slice(-22, -1);
    const resistance = Math.max(...prevBars.map((b) => b.high));

    // High vượt kháng cự nhưng close bên dưới và nến đỏ
    if (
      curr.high > resistance &&
      curr.close < resistance &&
      curr.close < curr.open
    ) {
      const failPct = ((resistance - curr.close) / resistance) * 100;
      return [
        {
          type: SignalType.FAILED_BREAKOUT,
          direction: SignalDirection.BEARISH,
          value: curr.high,
          description: `Bull trap tại đỉnh: vượt kháng cự ${(resistance / 1000).toFixed(1)}k nhưng đóng cửa tụt ${failPct.toFixed(1)}% → lực bán áp đảo vùng đỉnh`,
        },
      ];
    }
    return [];
  }

  private detectCandlestickPatterns(bars: OhlcvBar[]): DetectedSignal[] {
    if (bars.length < 2) return [];
    const signals: DetectedSignal[] = [];

    const curr = bars[bars.length - 1];
    const prev = bars[bars.length - 2];
    const body = Math.abs(curr.close - curr.open);
    const range = curr.high - curr.low;
    if (range === 0) return [];

    const upperShadow = curr.high - Math.max(curr.open, curr.close);
    const lowerShadow = Math.min(curr.open, curr.close) - curr.low;

    // Doji: thân nến < 10% range
    if (body / range < 0.1) {
      signals.push({
        type: SignalType.DOJI,
        direction: SignalDirection.NEUTRAL,
        value: null,
        description: `Doji (thân=${body.toFixed(2)}) → do dự, khả năng đảo chiều`,
      });
    }

    // Hammer: thân nhỏ ở trên, bóng dưới dài (> 2x thân), bóng trên ngắn
    if (
      lowerShadow > body * 2 &&
      upperShadow < body * 0.5 &&
      body / range > 0.1
    ) {
      signals.push({
        type: SignalType.HAMMER,
        direction: SignalDirection.BULLISH,
        value: null,
        description: `Hammer → đảo chiều tăng (bóng dưới=${lowerShadow.toFixed(2)}, thân=${body.toFixed(2)})`,
      });
    }

    // Shooting Star: thân nhỏ ở dưới, bóng trên dài (> 2x thân), bóng dưới ngắn
    if (
      upperShadow > body * 2 &&
      lowerShadow < body * 0.5 &&
      body / range > 0.1
    ) {
      signals.push({
        type: SignalType.SHOOTING_STAR,
        direction: SignalDirection.BEARISH,
        value: null,
        description: `Shooting Star → đảo chiều giảm (bóng trên=${upperShadow.toFixed(2)}, thân=${body.toFixed(2)})`,
      });
    }

    // Bullish Engulfing: nến trước đỏ, nến hiện xanh bao trùm
    if (
      prev.close < prev.open &&
      curr.close > curr.open &&
      curr.open < prev.close &&
      curr.close > prev.open
    ) {
      signals.push({
        type: SignalType.BULLISH_ENGULFING,
        direction: SignalDirection.BULLISH,
        value: null,
        description: `Bullish Engulfing → nến xanh bao trùm nến đỏ trước`,
      });
    }

    // Bearish Engulfing: nến trước xanh, nến hiện đỏ bao trùm
    if (
      prev.close > prev.open &&
      curr.close < curr.open &&
      curr.open > prev.close &&
      curr.close < prev.open
    ) {
      signals.push({
        type: SignalType.BEARISH_ENGULFING,
        direction: SignalDirection.BEARISH,
        value: null,
        description: `Bearish Engulfing → nến đỏ bao trùm nến xanh trước`,
      });
    }

    return signals;
  }

  private detectVolumeSurge(bars: OhlcvBar[]): DetectedSignal[] {
    if (bars.length < 20) return [];
    const recent = bars.slice(-20);
    const avgVolume =
      recent.slice(0, -1).reduce((s, b) => s + b.volume, 0) / 19;
    const currVolume = bars[bars.length - 1].volume;

    if (currVolume > avgVolume * 2) {
      return [
        {
          type: SignalType.VOLUME_SURGE,
          direction: SignalDirection.NEUTRAL,
          value: currVolume / avgVolume,
          description: `KL đột biến: ${(currVolume / avgVolume).toFixed(1)}x trung bình 20 phiên → xác nhận tín hiệu`,
        },
      ];
    }
    return [];
  }

  // ─── Helper ──────────────────────────────────────────────────────────────

  private async loadBars(ticker: string, limit: number): Promise<OhlcvBar[]> {
    const rows = await this.stockPriceRepo
      .createQueryBuilder('sp')
      .where('sp.ticker = :ticker', { ticker: ticker.toUpperCase() })
      .orderBy('sp.tradingDate', 'DESC')
      .limit(limit)
      .getMany();

    // Đảo ngược về ASC để indicators tính đúng thứ tự thời gian
    return rows.reverse().map((r) => ({
      open: Number(r.open),
      high: Number(r.high),
      low: Number(r.low),
      close: Number(r.close),
      volume: Number(r.volume),
      tradingDate: r.tradingDate,
    }));
  }

  // Load toàn bộ bars theo ASC — dùng cho analyzeAllHistory
  private async loadAllBars(ticker: string): Promise<OhlcvBar[]> {
    const rows = await this.stockPriceRepo
      .createQueryBuilder('sp')
      .where('sp.ticker = :ticker', { ticker: ticker.toUpperCase() })
      .orderBy('sp.tradingDate', 'ASC')
      .getMany();

    return rows.map((r) => ({
      open: Number(r.open),
      high: Number(r.high),
      low: Number(r.low),
      close: Number(r.close),
      volume: Number(r.volume),
      tradingDate: r.tradingDate,
    }));
  }
}

function directionEmoji(d: SignalDirection): string {
  if (d === SignalDirection.BULLISH) return '🟢';
  if (d === SignalDirection.BEARISH) return '🔴';
  return '🟡';
}
