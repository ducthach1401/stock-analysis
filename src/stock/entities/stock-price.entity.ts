import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';

// Composite UNIQUE bao phủ queries: WHERE ticker = X ORDER BY tradingDate DESC
// Đây cũng là index chính cho INSERT IGNORE bulk
@Entity('stock_prices')
@Unique(['ticker', 'tradingDate'])
@Index('idx_sp_ticker_date', ['ticker', 'tradingDate'])
export class StockPrice {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ length: 10 })
  ticker: string;

  @Column({ type: 'date' })
  tradingDate: string;

  @Column({ type: 'decimal', precision: 15, scale: 2 })
  open: number;

  @Column({ type: 'decimal', precision: 15, scale: 2 })
  high: number;

  @Column({ type: 'decimal', precision: 15, scale: 2 })
  low: number;

  @Column({ type: 'decimal', precision: 15, scale: 2 })
  close: number;

  @Column({ type: 'bigint' })
  volume: number;

  @Column({ type: 'decimal', precision: 15, scale: 2, nullable: true })
  foreignBuyVolume: number | null;

  @Column({ type: 'decimal', precision: 15, scale: 2, nullable: true })
  foreignSellVolume: number | null;

  @CreateDateColumn()
  createdAt: Date;
}
