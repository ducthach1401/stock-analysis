import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export enum PositionStatus {
  OPEN = 'OPEN',
  CLOSED = 'CLOSED',
}

export enum CloseReason {
  TARGET_HIT = 'TARGET_HIT',
  STOP_LOSS = 'STOP_LOSS',
  /** Đỉnh lãi > PROFIT_RUN_PCT, giá quay xuống ≤ sàn động (tối thiểu ~20%, nâng theo đỉnh) */
  PROFIT_FLOOR_20 = 'PROFIT_FLOOR_20',
  DISTRIBUTION = 'DISTRIBUTION',
  MANUAL = 'MANUAL',
}

/** Một lần mua thêm (trung bình giá): ngày, giá, lý do (nền / hồi phục). */
export interface AverageDownLeg {
  date: string;
  price: number;
  reason: 'NỀN_TỐT' | 'HỒI_PHỤC' | 'NỀN_VÀ_HỒI';
}

// Index (ticker, status) tối ưu query: findOne({ ticker, status: OPEN })
@Entity('positions')
@Index('idx_pos_ticker_status', ['ticker', 'status'])
export class Position {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ length: 10 })
  ticker: string;

  @Column({ type: 'date' })
  entryDate: string;

  @Column({ type: 'decimal', precision: 15, scale: 2 })
  entryPrice: number; // VND

  @Column({ type: 'decimal', precision: 15, scale: 2 })
  targetPrice: number;

  /** Luôn null — chiến lược ôm dài hạn, không đặt cắt lỗ tự động (cột giữ tương thích DB cũ). */
  @Column({ type: 'decimal', precision: 15, scale: 2, nullable: true })
  stopLoss: number | null;

  @Column({ length: 20 })
  recommendation: string; // BUY | STRONG_BUY

  @Column({ type: 'decimal', precision: 5, scale: 2 })
  riskReward: number;

  /**
   * Các lần mua thêm sau lệnh đầu (TB giá). Giá vào bình quân = `entryPrice`;
   * `entryDate` = ngày lệnh đầu (T+2 theo ngày mua đầu).
   */
  @Column({ type: 'json', nullable: true })
  averageDownLegs: AverageDownLeg[] | null;

  @Column({ type: 'enum', enum: PositionStatus, default: PositionStatus.OPEN })
  status: PositionStatus;

  // ── Theo dõi hàng ngày ───────────────────────────────────────────
  @Column({ type: 'decimal', precision: 15, scale: 2, nullable: true })
  lastPrice: number | null; // Giá cập nhật lần cuối

  @Column({ type: 'date', nullable: true })
  lastTrackedDate: string | null;

  @Column({ type: 'decimal', precision: 6, scale: 2, nullable: true })
  pnlPercent: number | null; // % lãi/lỗ so với entryPrice

  @Column({ type: 'int', default: 0 })
  daysHeld: number; // Số ngày nắm giữ

  /** Giá cao nhất đã thấy kể từ mở/TB — dùng chặn lãi khi giá quay đầu từ trên +20%. */
  @Column({ type: 'decimal', precision: 15, scale: 2, nullable: true })
  peakPriceSinceOpen: number | null;

  // ── Đóng vị thế ──────────────────────────────────────────────────
  @Column({ type: 'date', nullable: true })
  closeDate: string | null;

  @Column({ type: 'decimal', precision: 15, scale: 2, nullable: true })
  closePrice: number | null;

  @Column({ type: 'enum', enum: CloseReason, nullable: true })
  closeReason: CloseReason | null;

  /** Giải thích ngắn (tiếng Việt) — hiển thị lịch sử đóng lệnh */
  @Column({ type: 'text', nullable: true })
  closeReasonDetail: string | null;

  @Column({ type: 'decimal', precision: 6, scale: 2, nullable: true })
  closePnlPercent: number | null; // P&L cuối cùng khi đóng

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
