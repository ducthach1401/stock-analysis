import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export enum DerivativeDecisionAction {
  LONG = 'LONG',
  SHORT = 'SHORT',
  NO_TRADE = 'NO_TRADE',
}

export enum DerivativeDecisionStatus {
  OPEN = 'OPEN',
  CLOSED = 'CLOSED',
}

export enum DerivativeDecisionOutcome {
  WIN = 'WIN',
  LOSS = 'LOSS',
  TIME_EXIT = 'TIME_EXIT',
  NO_TRADE = 'NO_TRADE',
}

export interface DerivativeDecisionMetadata {
  algorithm: string;
  notes: string[];
  metrics: Record<string, number | string | boolean | null>;
}

@Entity('derivative_decisions')
@Index('idx_deriv_dec_symbol_time', ['symbol', 'decidedAt'])
@Index('idx_deriv_dec_symbol_status', ['symbol', 'status'])
export class DerivativeDecision {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ length: 16, default: 'VN30' })
  symbol: string;

  @Column({ type: 'varchar', length: 32, nullable: true })
  contractCode: string | null;

  @Column({ type: 'datetime' })
  decidedAt: Date;

  @Column({ type: 'date' })
  tradingDate: string;

  @Column({ length: 8, default: '5' })
  resolution: string;

  @Column({ length: 64 })
  algorithm: string;

  @Column({ type: 'enum', enum: DerivativeDecisionAction })
  action: DerivativeDecisionAction;

  @Column({ type: 'enum', enum: DerivativeDecisionStatus })
  status: DerivativeDecisionStatus;

  @Column({ type: 'decimal', precision: 10, scale: 2, nullable: true })
  entryPrice: number | null;

  @Column({ type: 'decimal', precision: 10, scale: 2, nullable: true })
  stopLoss: number | null;

  @Column({ type: 'decimal', precision: 10, scale: 2, nullable: true })
  takeProfit: number | null;

  @Column({ type: 'decimal', precision: 5, scale: 2, nullable: true })
  riskReward: number | null;

  @Column({ type: 'int', default: 0 })
  score: number;

  @Column({ type: 'int', default: 0 })
  confidence: number;

  @Column({ type: 'text' })
  reason: string;

  @Column({ type: 'json', nullable: true })
  metadata: DerivativeDecisionMetadata | null;

  @Column({ type: 'datetime', nullable: true })
  exitAt: Date | null;

  @Column({ type: 'decimal', precision: 10, scale: 2, nullable: true })
  exitPrice: number | null;

  @Column({ type: 'decimal', precision: 10, scale: 2, nullable: true })
  pnlPoints: number | null;

  @Column({ type: 'enum', enum: DerivativeDecisionOutcome, nullable: true })
  outcome: DerivativeDecisionOutcome | null;

  @Column({ type: 'text', nullable: true })
  outcomeReason: string | null;

  @Column({ default: false })
  notified: boolean;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
