import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import type { AverageDownLeg } from '../../position/entities/position.entity';
import { BacktestRun } from './backtest-run.entity';

/** Một lệnh mua → bán giả lập theo khuyến nghị trong backtest */
@Entity('simulated_trades')
@Index('idx_sim_run', ['backtestRunId'])
export class SimulatedTrade {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  backtestRunId: number;

  @ManyToOne(() => BacktestRun, (r) => r.trades, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'backtestRunId' })
  run: BacktestRun;

  @Column({ type: 'date' })
  entryDate: string;

  @Column({ type: 'decimal', precision: 15, scale: 2 })
  entryPrice: number;

  @Column({ length: 32 })
  entryRecommendation: string;

  /** STRONG = STRONG_BUY, MODERATE = BUY */
  @Column({ type: 'varchar', length: 16, nullable: true })
  entryStrength: string | null;

  /** Giải thích lý do mua (cùng logic recommend) */
  @Column({ type: 'text', nullable: true })
  entryReason: string | null;

  /** Số lần mua thêm trung bình giá (0 = chỉ lệnh đầu). */
  @Column({ type: 'int', default: 0 })
  averageDownCount: number;

  /** Từng lần TB: ngày, giá, lý do (đồng bộ vị thế thật). */
  @Column({ type: 'json', nullable: true })
  averageDownLegs: AverageDownLeg[] | null;

  /** Mục chốt lãi đặt tại ngày vào (cùng công thức priceTarget) — null nếu chưa đủ nến */
  @Column({ type: 'decimal', precision: 15, scale: 2, nullable: true })
  takeProfitTarget: number | null;

  /** Cắt lỗ đặt tại ngày vào — chỉ thoát lỗ khi đóng cửa ≤ mức này (sau T+2) */
  @Column({ type: 'decimal', precision: 15, scale: 2, nullable: true })
  stopLossAtEntry: number | null;

  @Column({ type: 'date' })
  exitDate: string;

  @Column({ type: 'decimal', precision: 15, scale: 2 })
  exitPrice: number;

  @Column({ length: 32 })
  exitRecommendation: string;

  /** STRONG = STRONG_SELL, MODERATE = SELL; null nếu đóng cuối kỳ */
  @Column({ type: 'varchar', length: 16, nullable: true })
  exitSellStrength: string | null;

  /** Giải thích lý do bán hoặc đóng cuối kỳ */
  @Column({ type: 'text', nullable: true })
  exitReason: string | null;

  /** % lãi/lỗ theo giá đóng cửa */
  @Column({ type: 'double' })
  pnlPercent: number;
}
