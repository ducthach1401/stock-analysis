import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';

export enum SignalType {
  // ── Momentum ──────────────────────────────────────────────────────
  RSI_OVERSOLD = 'RSI_OVERSOLD', // RSI < 30 → vùng bán quá mức
  RSI_OVERBOUGHT = 'RSI_OVERBOUGHT', // RSI > 70 → vùng mua quá mức
  RSI_MOMENTUM_UP = 'RSI_MOMENTUM_UP', // RSI vượt 50 từ dưới → momentum tăng
  RSI_MOMENTUM_DOWN = 'RSI_MOMENTUM_DOWN', // RSI rớt dưới 50 → momentum giảm

  // ── Trend (EMA) ───────────────────────────────────────────────────
  EMA_GOLDEN_CROSS = 'EMA_GOLDEN_CROSS', // EMA20 cắt lên EMA50 → uptrend
  EMA_DEATH_CROSS = 'EMA_DEATH_CROSS', // EMA20 cắt xuống EMA50 → downtrend
  EMA_BULLISH_STACK = 'EMA_BULLISH_STACK', // Giá > EMA20 > EMA50 → nền tăng
  EMA_BEARISH_STACK = 'EMA_BEARISH_STACK', // Giá < EMA20 < EMA50 → nền giảm
  EMA_BOUNCE = 'EMA_BOUNCE', // Nảy từ EMA20 hoặc EMA50

  // ── Base & Breakout ───────────────────────────────────────────────
  BASE_FORMING = 'BASE_FORMING', // Nền ổn định (range hẹp, vol thấp)
  RESISTANCE_BREAKOUT = 'RESISTANCE_BREAKOUT', // Break kháng cự + volume xác nhận
  SUPPORT_BREAKDOWN = 'SUPPORT_BREAKDOWN', // Thủng hỗ trợ + volume xác nhận

  // ── MACD ─────────────────────────────────────────────────────────
  MACD_BULLISH_CROSS = 'MACD_BULLISH_CROSS',
  MACD_BEARISH_CROSS = 'MACD_BEARISH_CROSS',

  // ── Volatility (Bollinger) — tên enum lịch sử: UP/DOWN theo giá vs dải, không phải hướng tín hiệu ──
  /** Giá vượt BB upper (thường kèm BEARISH: overbought nếu không breakout mạnh) */
  BB_BREAKOUT_UP = 'BB_BREAKOUT_UP',
  /** Giá chạm / xuyên BB lower (thường kèm BULLISH: oversold / cơ hội bật) */
  BB_BREAKOUT_DOWN = 'BB_BREAKOUT_DOWN',
  BB_SQUEEZE = 'BB_SQUEEZE',

  // ── Candlestick patterns ─────────────────────────────────────────
  HAMMER = 'HAMMER',
  SHOOTING_STAR = 'SHOOTING_STAR',
  BULLISH_ENGULFING = 'BULLISH_ENGULFING',
  BEARISH_ENGULFING = 'BEARISH_ENGULFING',
  DOJI = 'DOJI',

  // ── Volume ───────────────────────────────────────────────────────
  VOLUME_SURGE = 'VOLUME_SURGE',

  // ── Phân phối đỉnh (Distribution Top) ───────────────────────────
  RSI_BEARISH_DIVERGENCE = 'RSI_BEARISH_DIVERGENCE', // Giá đỉnh cao hơn nhưng RSI thấp hơn
  MACD_BEARISH_DIVERGENCE = 'MACD_BEARISH_DIVERGENCE', // Giá đỉnh cao hơn nhưng MACD thấp hơn
  VOLUME_CLIMAX_TOP = 'VOLUME_CLIMAX_TOP', // KL đột biến ở đỉnh, đóng cửa yếu
  DISTRIBUTION_BAR = 'DISTRIBUTION_BAR', // Nến phân phối Wyckoff (wide range + close near low)
  /** Washout / selling climax: KL cực đại ở vùng đáy, thân rộng, đóng lệch khỏi đáy nến → hấp thụ */
  WASHOUT_BAR = 'WASHOUT_BAR',
  FAILED_BREAKOUT = 'FAILED_BREAKOUT', // Bull trap: vượt đỉnh rồi đóng dưới

  // ── Legacy (giữ tương thích DB; detector hiện tại dùng EMA_* — không emit MA_* mới) ──
  MA_GOLDEN_CROSS = 'MA_GOLDEN_CROSS',
  MA_DEATH_CROSS = 'MA_DEATH_CROSS',
}

export enum SignalDirection {
  BULLISH = 'BULLISH', // Đảo chiều tăng
  BEARISH = 'BEARISH', // Đảo chiều giảm
  NEUTRAL = 'NEUTRAL', // Chưa rõ
}

// UNIQUE (ticker, tradingDate, type) cover prefix (ticker) và (ticker, tradingDate)
// Index riêng cho getSignalsSummary: GROUP BY ticker, WHERE ticker IN (...)
@Entity('signals')
@Unique(['ticker', 'tradingDate', 'type'])
@Index('idx_sig_ticker_date', ['ticker', 'tradingDate'])
export class Signal {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ length: 10 })
  ticker: string;

  @Column({ type: 'date' })
  tradingDate: string;

  @Column({ type: 'enum', enum: SignalType })
  type: SignalType;

  @Column({ type: 'enum', enum: SignalDirection })
  direction: SignalDirection;

  @Column({ type: 'decimal', precision: 10, scale: 4, nullable: true })
  value: number | null; // Giá trị chỉ báo (vd: RSI=28.5)

  @Column({ type: 'text', nullable: true })
  description: string | null;

  @Column({ default: false })
  notified: boolean; // Đã gửi Telegram chưa

  @CreateDateColumn()
  createdAt: Date;
}
