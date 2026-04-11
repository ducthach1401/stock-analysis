import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';

@Entity('stock_prices')
@Unique(['ticker', 'tradingDate'])
export class StockPrice {
  @PrimaryGeneratedColumn()
  id: number;

  @Index()
  @Column({ length: 10 })
  ticker: string;

  @Index()
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
