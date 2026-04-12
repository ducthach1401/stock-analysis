import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ATR } from 'technicalindicators';
import { Repository } from 'typeorm';
import { StockPrice } from '../stock/entities/stock-price.entity';
import { TelegramService } from '../telegram/telegram.service';
import {
  PatternLevel,
  PriceTarget,
  Recommendation,
  RecommendationResult,
  SignalWeight,
} from './dto/recommendation.dto';
import { Signal, SignalDirection, SignalType } from './entities/signal.entity';
import { buildPatternAnalysis } from './chart-patterns';
import { SignalService } from './signal.service';

const SIGNAL_WEIGHTS: Record<SignalType, number> = {
  // ── Chiến lược nền + break (trọng số cao nhất) ────────────────────
  [SignalType.RESISTANCE_BREAKOUT]: 5, // break cản + volume = tín hiệu mạnh nhất
  [SignalType.EMA_BOUNCE]: 3, // nảy EMA = điểm mua tốt trong uptrend
  [SignalType.BASE_FORMING]: 2, // nền ổn định = setup đang chín muồi
  [SignalType.SUPPORT_BREAKDOWN]: 5, // thủng hỗ trợ = thoát ngay

  // ── EMA trend ────────────────────────────────────────────────────
  [SignalType.EMA_GOLDEN_CROSS]: 3.5, // EMA20 cắt lên EMA50
  [SignalType.EMA_DEATH_CROSS]: 3.5,
  [SignalType.EMA_BULLISH_STACK]: 2.5, // cấu trúc tăng bền vững
  [SignalType.EMA_BEARISH_STACK]: 2.5,

  // ── RSI momentum ─────────────────────────────────────────────────
  [SignalType.RSI_MOMENTUM_UP]: 2.5, // RSI vượt 50 = momentum tăng
  [SignalType.RSI_MOMENTUM_DOWN]: 2.5,
  [SignalType.RSI_OVERSOLD]: 2,
  [SignalType.RSI_OVERBOUGHT]: 2,

  // ── MACD ─────────────────────────────────────────────────────────
  [SignalType.MACD_BULLISH_CROSS]: 2,
  [SignalType.MACD_BEARISH_CROSS]: 2,

  // ── Bollinger Bands ───────────────────────────────────────────────
  [SignalType.BB_BREAKOUT_DOWN]: 1.5,
  [SignalType.BB_BREAKOUT_UP]: 1.5,
  [SignalType.BB_SQUEEZE]: 0, // trung tính, chỉ cảnh báo

  // ── Candlestick patterns ─────────────────────────────────────────
  [SignalType.BULLISH_ENGULFING]: 1.5,
  [SignalType.BEARISH_ENGULFING]: 1.5,
  [SignalType.HAMMER]: 1.5,
  [SignalType.SHOOTING_STAR]: 1.5,
  [SignalType.DOJI]: 0,

  // ── Volume ───────────────────────────────────────────────────────
  [SignalType.VOLUME_SURGE]: 1,

  // ── Phân phối đỉnh ───────────────────────────────────────────────
  [SignalType.FAILED_BREAKOUT]: 5, // bull trap = tín hiệu bán mạnh nhất
  [SignalType.VOLUME_CLIMAX_TOP]: 4, // xả hàng đỉnh điểm
  [SignalType.DISTRIBUTION_BAR]: 3.5, // nến phân phối Wyckoff
  [SignalType.RSI_BEARISH_DIVERGENCE]: 3, // phân kỳ RSI
  [SignalType.MACD_BEARISH_DIVERGENCE]: 3, // phân kỳ MACD

  // ── Legacy ───────────────────────────────────────────────────────
  [SignalType.MA_GOLDEN_CROSS]: 2,
  [SignalType.MA_DEATH_CROSS]: 2,
};

@Injectable()
export class RecommendationService {
  private readonly logger = new Logger(RecommendationService.name);

  constructor(
    @InjectRepository(Signal)
    private readonly signalRepo: Repository<Signal>,
    @InjectRepository(StockPrice)
    private readonly stockPriceRepo: Repository<StockPrice>,
    private readonly signalService: SignalService,
    private readonly telegramService: TelegramService,
  ) {}

  async recommend(ticker: string): Promise<RecommendationResult> {
    // Kiểm tra thanh khoản — bỏ qua mã giao dịch thưa
    const liq = await this.signalService.checkLiquidity(ticker);
    if (!liq.pass) {
      this.logger.warn(`${ticker}: bỏ qua recommend — ${liq.reason}`);
      return {
        ticker,
        tradingDate: '',
        recommendation: Recommendation.HOLD,
        score: 0,
        confidence: 'LOW',
        priceTarget: null,
        patternSummary: null,
        patternLevels: null,
        bullishSignals: [],
        bearishSignals: [],
        neutralSignals: [],
        reasoning: `Thanh khoản thấp: ${liq.reason}`,
        action: 'Không đủ thanh khoản để phân tích',
      };
    }

    await this.signalService.analyze(ticker);

    // Một lần tải 130 phiên daily: price target + mô hình giá
    const bars = await this.loadBars(ticker, 130);
    const priceTarget = bars.length >= 20 ? calcPriceTarget(bars) : null;
    const patternAnalysis =
      bars.length >= 80 ? buildPatternAnalysis(bars) : null;
    const patternSummary = patternAnalysis?.summary ?? null;
    const patternLevels = patternAnalysis?.levels ?? null;

    // Lấy ngày giao dịch mới nhất từ DB giá
    const latestPrice = await this.stockPriceRepo.findOne({
      where: { ticker: ticker.toUpperCase() },
      order: { tradingDate: 'DESC' },
    });
    const tradingDate = latestPrice?.tradingDate ?? 'N/A';

    // Lấy tín hiệu của ngày mới nhất (nếu có)
    const signals =
      tradingDate !== 'N/A'
        ? await this.signalRepo.find({
            where: { ticker: ticker.toUpperCase(), tradingDate },
          })
        : [];

    return this.buildResult(
      ticker,
      tradingDate,
      signals,
      priceTarget,
      patternSummary,
      patternLevels,
    );
  }

  async recommendAndNotify(ticker: string): Promise<RecommendationResult> {
    const result = await this.recommend(ticker);
    if (
      result.recommendation === Recommendation.BUY ||
      result.recommendation === Recommendation.STRONG_BUY
    ) {
      await this.sendRecommendation(result);
    } else if (
      result.recommendation === Recommendation.SELL ||
      result.recommendation === Recommendation.STRONG_SELL
    ) {
      await this.sendDistributionAlert(result);
    } else {
      this.logger.debug(
        `${ticker}: ${result.recommendation} — bỏ qua, không gửi Telegram`,
      );
    }
    return result;
  }

  // ─── Core ────────────────────────────────────────────────────────────

  /**
   * Cùng công thức với khuyến nghị realtime — dùng backtest lịch sử theo từng phiên.
   * `reasoning`: một dòng gọn (điểm · khuyến nghị · ↑/↓ loại tín hiệu), không phải đoạn dài như recommend UI.
   * `buyStrength` / `sellStrength`: STRONG = STRONG_BUY/STRONG_SELL, MODERATE = BUY/SELL (lọc nhiễu khi chỉ dùng tín hiệu mạnh).
   */
  evaluateSignals(signals: Signal[]): {
    score: number;
    recommendation: Recommendation;
    reasoning: string;
    confidence: 'HIGH' | 'MEDIUM' | 'LOW';
    buyStrength: 'STRONG' | 'MODERATE' | null;
    sellStrength: 'STRONG' | 'MODERATE' | null;
  } {
    const {
      normalizedScore,
      recommendation,
      bullishSignals,
      bearishSignals,
      neutralSignals,
      hasVolumeSurge,
    } = this.computeRecommendationFromSignals(signals);
    const confidence = calcConfidence(signals.length, normalizedScore);
    /** Một dòng gọn cho backtest (điểm + khuyến nghị + loại tín hiệu) */
    const reasoning = buildReasoningShort(
      normalizedScore,
      recommendation,
      bullishSignals,
      bearishSignals,
      neutralSignals,
      hasVolumeSurge,
    );
    let buyStrength: 'STRONG' | 'MODERATE' | null = null;
    let sellStrength: 'STRONG' | 'MODERATE' | null = null;
    if (recommendation === Recommendation.STRONG_BUY) buyStrength = 'STRONG';
    else if (recommendation === Recommendation.BUY) buyStrength = 'MODERATE';
    if (recommendation === Recommendation.STRONG_SELL) sellStrength = 'STRONG';
    else if (recommendation === Recommendation.SELL) sellStrength = 'MODERATE';

    return {
      score: Number(normalizedScore.toFixed(2)),
      recommendation,
      reasoning,
      confidence,
      buyStrength,
      sellStrength,
    };
  }

  private computeRecommendationFromSignals(signals: Signal[]): {
    normalizedScore: number;
    recommendation: Recommendation;
    bullishSignals: SignalWeight[];
    bearishSignals: SignalWeight[];
    neutralSignals: SignalWeight[];
    hasVolumeSurge: boolean;
  } {
    const bullishSignals: SignalWeight[] = [];
    const bearishSignals: SignalWeight[] = [];
    const neutralSignals: SignalWeight[] = [];

    let score = 0;
    const hasVolumeSurge = signals.some(
      (s) => s.type === SignalType.VOLUME_SURGE,
    );

    for (const signal of signals) {
      const weight = SIGNAL_WEIGHTS[signal.type] ?? 1;
      const boosted = hasVolumeSurge && weight > 0 ? weight * 1.3 : weight;
      const sw: SignalWeight = {
        type: signal.type,
        direction: signal.direction,
        weight: Number(boosted.toFixed(2)),
        description: signal.description,
      };

      if (signal.direction === SignalDirection.BULLISH) {
        score += boosted;
        bullishSignals.push(sw);
      } else if (signal.direction === SignalDirection.BEARISH) {
        score -= boosted;
        bearishSignals.push(sw);
      } else {
        neutralSignals.push(sw);
      }
    }

    const normalizedScore = Math.max(-10, Math.min(10, score));
    const recommendation = scoreToRecommendation(normalizedScore);
    return {
      normalizedScore,
      recommendation,
      bullishSignals,
      bearishSignals,
      neutralSignals,
      hasVolumeSurge,
    };
  }

  private buildResult(
    ticker: string,
    tradingDate: string,
    signals: Signal[],
    priceTarget: PriceTarget | null,
    patternSummary: string | null,
    patternLevels: PatternLevel[] | null,
  ): RecommendationResult {
    const {
      normalizedScore,
      recommendation,
      bullishSignals,
      bearishSignals,
      neutralSignals,
      hasVolumeSurge,
    } = this.computeRecommendationFromSignals(signals);
    const confidence = calcConfidence(signals.length, normalizedScore);
    const reasoning = buildReasoning(
      bullishSignals,
      bearishSignals,
      neutralSignals,
      hasVolumeSurge,
      recommendation,
    );
    const action = buildAction(recommendation, ticker, priceTarget);

    this.logger.log(
      `${ticker} [${tradingDate}]: ${recommendation} (score=${normalizedScore.toFixed(2)})`,
    );

    return {
      ticker: ticker.toUpperCase(),
      tradingDate,
      recommendation,
      score: Number(normalizedScore.toFixed(2)),
      confidence,
      priceTarget,
      patternSummary,
      patternLevels,
      bullishSignals,
      bearishSignals,
      neutralSignals,
      reasoning,
      action,
    };
  }

  // ─── Telegram ────────────────────────────────────────────────────────

  private formatPatternLevelsForTelegram(
    levels: PatternLevel[] | null,
  ): string {
    if (!levels?.length) return '';
    const fmt = (n: number) => Math.round(n).toLocaleString('vi-VN');
    return (
      '\n<b>Đỉnh / đáy tham chiếu</b>\n' +
      levels
        .map(
          (l) =>
            `  • ${l.role}: <b>${fmt(l.price)}đ</b>` +
            (l.date ? ` <i>(${l.date})</i>` : ''),
        )
        .join('\n') +
      '\n'
    );
  }

  private async sendRecommendation(
    result: RecommendationResult,
  ): Promise<void> {
    const emoji = recommendationEmoji(result.recommendation);
    const conf = confidenceLabel(result.confidence);
    const scoreStr = result.score > 0 ? `+${result.score}` : `${result.score}`;
    const fmt = (n: number) => Math.round(n).toLocaleString('vi-VN');

    let msg =
      `${emoji} <b>${result.ticker} — ${result.recommendation}</b>\n` +
      `📅 ${result.tradingDate} | 📊 Điểm: <b>${scoreStr}/10</b> | Độ tin cậy: <b>${conf}</b>\n`;

    if (result.priceTarget) {
      const pt = result.priceTarget;
      const rrStr =
        pt.riskReward >= 0
          ? `1 : ${pt.riskReward.toFixed(1)}`
          : `${pt.riskReward.toFixed(1)} : 1`;

      msg +=
        `\n💰 <b>Giá tham khảo</b>\n` +
        `  • Giá hiện tại:  <b>${fmt(pt.currentPrice)}đ</b>\n` +
        `  • 🟢 Giá mua vào: <b>${fmt(pt.entryPrice)}đ</b>` +
        `  (+${pt.upside.toFixed(1)}% kỳ vọng)\n` +
        `  • 🎯 Chốt lời:    <b>${fmt(pt.targetPrice)}đ</b>\n` +
        `  • 📌 <i>Không đặt cắt lỗ tự động</i> — chiến lược ôm trung/dài hạn\n` +
        `  • ⚖️ R:R tham chiếu (lợi nhuận mục tiêu / 8% vốn) = ${rrStr}\n` +
        `  • 📐 ATR-14: ${fmt(pt.atr)}đ` +
        ` | Hỗ trợ: ${fmt(pt.support)}đ | Kháng cự: ${fmt(pt.resistance)}đ\n`;
    }

    if (result.bullishSignals.length) {
      msg += `\n🟢 <b>Tín hiệu TĂNG</b>\n`;
      result.bullishSignals.forEach(
        (s) => (msg += `  • ${s.type} (×${s.weight}): ${s.description}\n`),
      );
    }
    if (result.bearishSignals.length) {
      msg += `\n🔴 <b>Tín hiệu GIẢM</b>\n`;
      result.bearishSignals.forEach(
        (s) => (msg += `  • ${s.type} (×${s.weight}): ${s.description}\n`),
      );
    }
    if (result.neutralSignals.length) {
      msg += `\n🟡 <b>Trung tính</b>\n`;
      result.neutralSignals.forEach(
        (s) => (msg += `  • ${s.type}: ${s.description}\n`),
      );
    }

    msg +=
      `\n💡 ${result.reasoning}\n` +
      (result.patternSummary
        ? `\n📐 <b>Mô hình giá (daily)</b>\n${result.patternSummary}${this.formatPatternLevelsForTelegram(result.patternLevels)}\n`
        : '') +
      `\n📌 <b>${result.action}</b>\n\n` +
      `<i>⚠️ Phân tích kỹ thuật tự động, không phải tư vấn đầu tư chuyên nghiệp.</i>`;

    await this.telegramService.sendMessage({ text: msg });
  }

  private async sendDistributionAlert(
    result: RecommendationResult,
  ): Promise<void> {
    const fmt = (n: number) => Math.round(n).toLocaleString('vi-VN');
    const conf = confidenceLabel(result.confidence);
    const scoreStr = result.score > 0 ? `+${result.score}` : `${result.score}`;

    let msg =
      `🔴 <b>${result.ticker} — CẢNH BÁO PHÂN PHỐI ĐỈNH</b>\n` +
      `📅 ${result.tradingDate} | 📊 Điểm: <b>${scoreStr}/10</b> | Độ tin cậy: <b>${conf}</b>\n`;

    if (result.priceTarget) {
      const pt = result.priceTarget;
      msg +=
        `\n⚠️ <b>Vùng giá cảnh báo</b>\n` +
        `  • Giá hiện tại: <b>${fmt(pt.currentPrice)}đ</b>\n` +
        `  • 📐 Hỗ trợ gần: ${fmt(pt.support)}đ | Kháng cự: ${fmt(pt.resistance)}đ\n` +
        `  • <i>Chiến lược không dùng SL tự động — cân nhắc giảm tỷ trọng theo tín hiệu.</i>\n`;
    }

    if (result.bearishSignals.length) {
      msg += `\n🔴 <b>Tín hiệu phân phối</b>\n`;
      result.bearishSignals.forEach(
        (s) => (msg += `  • ${s.type} (×${s.weight}): ${s.description}\n`),
      );
    }

    msg +=
      `\n💡 ${result.reasoning}\n` +
      (result.patternSummary
        ? `\n📐 <b>Mô hình giá (daily)</b>\n${result.patternSummary}${this.formatPatternLevelsForTelegram(result.patternLevels)}\n`
        : '') +
      `\n📌 <b>${result.action}</b>\n\n` +
      `<i>⚠️ Phân tích kỹ thuật tự động, không phải tư vấn đầu tư chuyên nghiệp.</i>`;

    await this.telegramService.sendMessage({ text: msg });
  }

  // ─── Helpers ─────────────────────────────────────────────────────────

  private async loadBars(ticker: string, limit: number) {
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
}

// ─── Price Target Calculator ─────────────────────────────────────────────────

const MIN_UPSIDE_PCT = 0.12; // kỳ vọng tối thiểu 12% để xứng đáng đầu tư dài hạn

/** Dùng chung recommend + backtest: mục tiêu từ nến lịch sử đến phiên hiện tại (không đặt SL). */
export function calcPriceTarget(
  bars: { open: number; high: number; low: number; close: number }[],
): PriceTarget {
  const last = bars[bars.length - 1];
  const currentPrice = last.close;

  // ATR-14 để đo biến động
  const atrResults = ATR.calculate({
    high: bars.map((b) => b.high),
    low: bars.map((b) => b.low),
    close: bars.map((b) => b.close),
    period: 14,
  });
  const atr = atrResults[atrResults.length - 1] ?? currentPrice * 0.02;

  // Hỗ trợ = lowest low 20 phiên (ngắn hạn)
  const recent20 = bars.slice(-20);
  const support = Math.min(...recent20.map((b) => b.low));

  // Kháng cự dài hạn = highest high toàn bộ dữ liệu (tối đa 60 phiên)
  const resistance = Math.max(...bars.map((b) => b.high));

  // Entry = giá hiện tại hoặc pullback nhẹ (~0.3 ATR) để không mua đuổi
  const entryPrice = Math.max(support, currentPrice - atr * 0.3);

  // Mục tiêu dài hạn: lấy lớn nhất trong 3 cách tính
  // 1. Kháng cự toàn dữ liệu (60 phiên)
  // 2. Entry + tối thiểu 12% (kỳ vọng dài hạn)
  // 3. Entry + 5×ATR (tương ứng ~3–5 tháng nắm giữ)
  const targetByResistance = resistance;
  const targetByMinUpside = entryPrice * (1 + MIN_UPSIDE_PCT);
  const targetByAtr = entryPrice + atr * 5;
  const targetPrice = Math.max(
    targetByResistance,
    targetByMinUpside,
    targetByAtr,
  );

  const profitPotential = targetPrice - entryPrice;
  const syntheticRisk = entryPrice * 0.08;
  const riskReward =
    syntheticRisk > 0
      ? Number((profitPotential / syntheticRisk).toFixed(2))
      : 0;

  const upside = ((targetPrice - currentPrice) / currentPrice) * 100;

  return {
    currentPrice: Math.round(currentPrice),
    entryPrice: Math.round(entryPrice),
    targetPrice: Math.round(targetPrice),
    stopLoss: null,
    riskReward,
    upside: Number(upside.toFixed(2)),
    downside: 0,
    atr: Math.round(atr),
    support: Math.round(support),
    resistance: Math.round(resistance),
  };
}

/** Chiến lược vị thế (TB giá): TP tối thiểu từ giá vào bình quân — mặc định ≥ 20%. */
export const POSITION_MIN_UPSIDE_PCT = 0.2;

/**
 * TP từ **giá vào thực tế** (bình quân sau TB), tận dụng kháng cự/ATR; tối thiểu `minUpsidePct` (mặc định 20%).
 * Không tính mức cắt lỗ — `stopLoss` luôn null.
 */
export function calcPriceTargetForFixedEntry(
  fixedEntryPrice: number,
  bars: { open: number; high: number; low: number; close: number }[],
  options?: { minUpsidePct?: number },
): Pick<
  PriceTarget,
  'targetPrice' | 'stopLoss' | 'riskReward' | 'atr' | 'support' | 'resistance'
> {
  const minPct = options?.minUpsidePct ?? POSITION_MIN_UPSIDE_PCT;
  const last = bars[bars.length - 1];
  const currentPrice = last.close;
  const entryPrice = Number(fixedEntryPrice);

  const atrResults = ATR.calculate({
    high: bars.map((b) => b.high),
    low: bars.map((b) => b.low),
    close: bars.map((b) => b.close),
    period: 14,
  });
  const atr = atrResults[atrResults.length - 1] ?? currentPrice * 0.02;

  const recent20 = bars.slice(-20);
  const support = Math.min(...recent20.map((b) => b.low));
  const resistance = Math.max(...bars.map((b) => b.high));

  const targetByResistance = resistance;
  const targetByMinUpside = entryPrice * (1 + minPct);
  const targetByAtr = entryPrice + atr * 5;
  const targetPrice = Math.max(
    targetByResistance,
    targetByMinUpside,
    targetByAtr,
  );

  const profitPotential = targetPrice - entryPrice;
  const syntheticRisk = entryPrice * 0.08;
  const riskReward =
    syntheticRisk > 0
      ? Number((profitPotential / syntheticRisk).toFixed(2))
      : 0;

  return {
    targetPrice: Math.round(targetPrice),
    stopLoss: null,
    riskReward,
    atr: Math.round(atr),
    support: Math.round(support),
    resistance: Math.round(resistance),
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function scoreToRecommendation(score: number): Recommendation {
  // Ngưỡng cho chiến lược trung dài hạn: yêu cầu hội tụ nhiều tín hiệu hơn
  if (score >= 6) return Recommendation.STRONG_BUY; // break + stack + momentum
  if (score >= 3) return Recommendation.BUY; // 1-2 tín hiệu chính
  if (score <= -6) return Recommendation.STRONG_SELL;
  if (score <= -3) return Recommendation.SELL;
  return Recommendation.HOLD;
}

function calcConfidence(
  signalCount: number,
  score: number,
): 'HIGH' | 'MEDIUM' | 'LOW' {
  const abs = Math.abs(score);
  if (signalCount >= 3 && abs >= 4) return 'HIGH';
  if (signalCount >= 2 && abs >= 2) return 'MEDIUM';
  return 'LOW';
}

function buildReasoning(
  bullish: SignalWeight[],
  bearish: SignalWeight[],
  neutral: SignalWeight[],
  volumeSurge: boolean,
  rec: Recommendation,
): string {
  const parts: string[] = [];
  if (bullish.length)
    parts.push(
      `${bullish.length} tín hiệu tăng (${bullish.map((s) => s.type).join(', ')})`,
    );
  if (bearish.length)
    parts.push(
      `${bearish.length} tín hiệu giảm (${bearish.map((s) => s.type).join(', ')})`,
    );
  if (neutral.length)
    parts.push(`${neutral.length} tín hiệu trung tính cần theo dõi`);
  if (volumeSurge) parts.push('KL đột biến tăng cường độ tin cậy (×1.3)');

  const suffix: Record<Recommendation, string> = {
    [Recommendation.STRONG_BUY]: 'Chỉ báo hội tụ mạnh — cơ hội mua tốt.',
    [Recommendation.BUY]: 'Xu hướng tăng chiếm ưu thế — có thể mua vào.',
    [Recommendation.HOLD]: 'Chưa rõ xu hướng — chờ xác nhận thêm.',
    [Recommendation.SELL]: 'Xu hướng giảm — cân nhắc giảm tỷ trọng.',
    [Recommendation.STRONG_SELL]: 'Chỉ báo giảm mạnh — nên thoát hàng.',
  };
  return (parts.length ? parts.join('; ') + '. ' : '') + suffix[rec];
}

/** Một dòng: điểm + khuyến nghị + ↑/↓ loại tín hiệu (rút gọn, không đoạn văn dài). */
function buildReasoningShort(
  normalizedScore: number,
  rec: Recommendation,
  bullish: SignalWeight[],
  bearish: SignalWeight[],
  neutral: SignalWeight[],
  volumeSurge: boolean,
): string {
  const recVi: Record<Recommendation, string> = {
    [Recommendation.STRONG_BUY]: 'MUA+',
    [Recommendation.BUY]: 'MUA',
    [Recommendation.HOLD]: 'GIỮ',
    [Recommendation.SELL]: 'BÁN',
    [Recommendation.STRONG_SELL]: 'BÁN+',
  };
  const chunks: string[] = [
    `${Number(normalizedScore.toFixed(1))} · ${recVi[rec]}`,
  ];
  const joinTypes = (sw: SignalWeight[], max: number) =>
    sw
      .slice(0, max)
      .map((s) => s.type)
      .join(',');
  if (bullish.length) {
    const t = joinTypes(bullish, 5);
    const more = bullish.length > 5 ? `+${bullish.length - 5}` : '';
    chunks.push(`↑${t}${more ? '(' + more + ')' : ''}`);
  }
  if (bearish.length) {
    const t = joinTypes(bearish, 5);
    const more = bearish.length > 5 ? `+${bearish.length - 5}` : '';
    chunks.push(`↓${t}${more ? '(' + more + ')' : ''}`);
  }
  if (neutral.length) chunks.push(`○${neutral.length} trung tính`);
  if (volumeSurge) chunks.push('KL×1.3');
  let out = chunks.join(' ');
  if (out.length > 240) out = out.slice(0, 237) + '…';
  return out;
}

function buildAction(
  rec: Recommendation,
  ticker: string,
  pt: PriceTarget | null,
): string {
  const fmt = (n: number) => Math.round(n).toLocaleString('vi-VN');
  const priceInfo = pt
    ? ` Mua quanh ${fmt(pt.entryPrice)}đ, chốt lời ${fmt(pt.targetPrice)}đ (R:R tham chiếu 1:${pt.riskReward.toFixed(1)}, không đặt SL).`
    : '';

  const verbs: Record<Recommendation, string> = {
    [Recommendation.STRONG_BUY]: `🚀 Khuyến nghị mua tích cực ${ticker} — Có thể tăng tỷ trọng.${priceInfo}`,
    [Recommendation.BUY]: `📈 MUA ${ticker} — Mua một phần, chờ xác nhận thêm.${priceInfo}`,
    [Recommendation.HOLD]: `⏸️ GIỮ ${ticker} — Không hành động, theo dõi phiên sau.`,
    [Recommendation.SELL]: `📉 BÁN ${ticker} — Giảm tỷ trọng hoặc chốt lời.${priceInfo}`,
    [Recommendation.STRONG_SELL]: `🔥 Khuyến nghị bán tích cực ${ticker} — Cân nhắc thoát.${priceInfo}`,
  };
  return verbs[rec];
}

function recommendationEmoji(rec: Recommendation): string {
  return {
    [Recommendation.STRONG_BUY]: '🚀',
    [Recommendation.BUY]: '📈',
    [Recommendation.HOLD]: '⏸️',
    [Recommendation.SELL]: '📉',
    [Recommendation.STRONG_SELL]: '🔥',
  }[rec];
}

function confidenceLabel(c: 'HIGH' | 'MEDIUM' | 'LOW'): string {
  return { HIGH: 'Cao ✅', MEDIUM: 'Trung bình ⚠️', LOW: 'Thấp ❗' }[c];
}
