import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  OneToMany,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { SimulatedTrade } from './simulated-trade.entity';

/** Một lần chạy giả lập theo tín hiệu mua/bán trên khoảng thời gian */
@Entity('backtest_runs')
@Index('idx_bt_ticker_created', ['ticker', 'createdAt'])
export class BacktestRun {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ length: 10 })
  ticker: string;

  @Column({ type: 'date' })
  periodFrom: string;

  @Column({ type: 'date' })
  periodTo: string;

  @Column({ type: 'int' })
  tradingDays: number;

  @Column({ type: 'int' })
  tradeCount: number;

  @Column({ type: 'int' })
  winCount: number;

  /** Cộng dồn % từng lệnh (đơn giản) */
  @Column({ type: 'double' })
  sumPnlPercent: number;

  /** Lãi lỗ gộp: Π(1 + pᵢ/100) − 1, tính bằng % */
  @Column({ type: 'double' })
  compoundPnlPercent: number;

  /** Chỉ mở lệnh khi STRONG_BUY (bỏ qua BUY) — luôn bật từ UI mới */
  @Column({ type: 'boolean', default: true })
  strongBuyEntryOnly: boolean;

  /** Lưu tương thích DB; logic thoát không còn dùng STRONG_SELL — chỉ target / chặn lãi / cuối kỳ */
  @Column({ type: 'boolean', default: true })
  strongSellExitOnly: boolean;

  @OneToMany(() => SimulatedTrade, (t) => t.run, { cascade: true })
  trades: SimulatedTrade[];

  @CreateDateColumn()
  createdAt: Date;
}
