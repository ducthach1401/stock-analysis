import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity('watchlist')
export class WatchlistItem {
  @PrimaryGeneratedColumn()
  id: number;

  @Index({ unique: true })
  @Column({ length: 10 })
  ticker: string;

  @Column({ length: 100 })
  name: string;

  @Column({ length: 50 })
  sector: string;

  // Trạng thái — false khi bị loại do thanh khoản thấp hoặc xoá thủ công
  @Index()
  @Column({ default: true })
  active: boolean;

  // Kết quả kiểm tra thanh khoản lần cuối
  @Column({ type: 'bigint', unsigned: true, nullable: true })
  avgVolume: number | null;

  @Column({ type: 'tinyint', unsigned: true, nullable: true })
  tradingDays: number | null; // trên 30 ngày gần nhất

  @Column({ type: 'timestamp', nullable: true })
  lastChecked: Date | null;

  @Column({ type: 'varchar', length: 200, nullable: true })
  deactivateReason: string | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
