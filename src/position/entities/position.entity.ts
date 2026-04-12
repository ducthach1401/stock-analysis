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
  DISTRIBUTION = 'DISTRIBUTION',
  MANUAL = 'MANUAL',
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

  @Column({ type: 'decimal', precision: 15, scale: 2 })
  stopLoss: number;

  @Column({ length: 20 })
  recommendation: string; // BUY | STRONG_BUY

  @Column({ type: 'decimal', precision: 5, scale: 2 })
  riskReward: number;

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

  // ── Đóng vị thế ──────────────────────────────────────────────────
  @Column({ type: 'date', nullable: true })
  closeDate: string | null;

  @Column({ type: 'decimal', precision: 15, scale: 2, nullable: true })
  closePrice: number | null;

  @Column({ type: 'enum', enum: CloseReason, nullable: true })
  closeReason: CloseReason | null;

  @Column({ type: 'decimal', precision: 6, scale: 2, nullable: true })
  closePnlPercent: number | null; // P&L cuối cùng khi đóng

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
