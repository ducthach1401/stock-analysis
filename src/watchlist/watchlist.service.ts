import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SignalService } from '../signal/signal.service';
import { WATCHLIST } from '../scanner/watchlist';
import { WatchlistItem } from './entities/watchlist-item.entity';

@Injectable()
export class WatchlistService implements OnModuleInit {
  private readonly logger = new Logger(WatchlistService.name);

  constructor(
    @InjectRepository(WatchlistItem)
    private readonly repo: Repository<WatchlistItem>,
    private readonly signalService: SignalService,
  ) {}

  // ─── Seed dữ liệu ban đầu khi module khởi động ────────────────────────────
  async onModuleInit() {
    const count = await this.repo.count();
    if (count === 0) {
      this.logger.log('Seeding watchlist từ file cứng...');
      await this.repo
        .createQueryBuilder()
        .insert()
        .into(WatchlistItem)
        .values(
          WATCHLIST.map((s) => ({
            ticker: s.ticker,
            name: s.name,
            sector: s.sector,
            active: true,
          })),
        )
        .orIgnore()
        .execute();
      this.logger.log(`✅ Đã seed ${WATCHLIST.length} mã vào watchlist DB`);
    }
  }

  // ─── Đọc danh sách ────────────────────────────────────────────────────────

  findAll(): Promise<WatchlistItem[]> {
    return this.repo.find({ order: { sector: 'ASC', ticker: 'ASC' } });
  }

  findActive(): Promise<WatchlistItem[]> {
    return this.repo.find({
      where: { active: true },
      order: { sector: 'ASC', ticker: 'ASC' },
    });
  }

  async getActiveTickers(): Promise<string[]> {
    const items = await this.findActive();
    return items.map((i) => i.ticker);
  }

  // ─── Thêm / Sửa / Xoá ────────────────────────────────────────────────────

  async add(
    ticker: string,
    name: string,
    sector: string,
  ): Promise<WatchlistItem> {
    const t = ticker.toUpperCase().trim();
    const existing = await this.repo.findOne({ where: { ticker: t } });
    if (existing) {
      // Reactivate nếu đang inactive
      existing.active = true;
      existing.deactivateReason = null;
      existing.name = name || existing.name;
      existing.sector = sector || existing.sector;
      return this.repo.save(existing);
    }
    return this.repo.save(
      this.repo.create({ ticker: t, name, sector, active: true }),
    );
  }

  async remove(id: number): Promise<void> {
    await this.repo.delete(id);
  }

  async deactivate(ticker: string, reason: string): Promise<void> {
    await this.repo.update(
      { ticker: ticker.toUpperCase() },
      { active: false, deactivateReason: reason },
    );
  }

  async activate(ticker: string): Promise<void> {
    await this.repo.update(
      { ticker: ticker.toUpperCase() },
      { active: true, deactivateReason: null },
    );
  }

  // ─── Kiểm tra thanh khoản toàn bộ danh sách ──────────────────────────────

  async checkAllLiquidity(): Promise<{
    checked: number;
    deactivated: string[];
    reactivated: string[];
  }> {
    const all = await this.findAll();
    const deactivated: string[] = [];
    const reactivated: string[] = [];

    for (const item of all) {
      const liq = await this.signalService.checkLiquidity(item.ticker);

      // Cập nhật số liệu thanh khoản
      await this.repo.update(item.id, {
        avgVolume: Math.round(liq.avgVolume),
        tradingDays: liq.tradingDays,
        lastChecked: new Date(),
      });

      if (!liq.pass && item.active) {
        await this.repo.update(item.id, {
          active: false,
          deactivateReason: liq.reason,
        });
        deactivated.push(item.ticker);
        this.logger.warn(`❌ Deactivated ${item.ticker}: ${liq.reason}`);
      } else if (liq.pass && !item.active && item.deactivateReason !== 'MANUAL') {
        // Tự reactivate nếu thanh khoản đã phục hồi (không reactivate mã bị xoá thủ công)
        await this.repo.update(item.id, {
          active: true,
          deactivateReason: null,
        });
        reactivated.push(item.ticker);
        this.logger.log(`✅ Reactivated ${item.ticker}: thanh khoản phục hồi`);
      }
    }

    this.logger.log(
      `Liquidity check xong: ${all.length} mã, deactivated=${deactivated.length}, reactivated=${reactivated.length}`,
    );
    return { checked: all.length, deactivated, reactivated };
  }

  // ─── Cron: Kiểm tra thanh khoản hàng tuần (Chủ nhật 8:00) ────────────────
  @Cron('0 8 * * 0', { timeZone: 'Asia/Ho_Chi_Minh' })
  async scheduledLiquidityCheck() {
    this.logger.log('⏰ [Cron] Kiểm tra thanh khoản watchlist hàng tuần...');
    await this.checkAllLiquidity();
  }
}
