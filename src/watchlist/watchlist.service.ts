import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SignalService } from '../signal/signal.service';
import { shouldRunAnalyzeAllHistoryAfterSync } from '../common/sync-analyze-policy';
import { StockService } from '../stock/stock.service';
import {
  isMarketIndexTicker,
  tickerCapLiquidityRank,
  WATCHLIST,
} from '../scanner/watchlist';
import { WatchlistItem } from './entities/watchlist-item.entity';

@Injectable()
export class WatchlistService implements OnModuleInit {
  private readonly logger = new Logger(WatchlistService.name);
  private _activeCache: { ts: number; data: WatchlistItem[] } | null = null;
  private readonly ACTIVE_TTL_MS = 2 * 60 * 1000;

  constructor(
    @InjectRepository(WatchlistItem)
    private readonly repo: Repository<WatchlistItem>,
    private readonly signalService: SignalService,
    private readonly stockService: StockService,
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

  invalidateActiveCache(): void {
    this._activeCache = null;
  }

  /** Active, ưu tiên vốn hoá/thanh khoản (theo thứ tự WATCHLIST) rồi avgVolume giảm dần. */
  async findActiveSortedByPriority(): Promise<WatchlistItem[]> {
    if (this._activeCache && Date.now() - this._activeCache.ts < this.ACTIVE_TTL_MS) {
      return this._activeCache.data;
    }
    const items = await this.repo.find({ where: { active: true } });
    const sorted = [...items].sort((a, b) => {
      const ra = tickerCapLiquidityRank(a.ticker);
      const rb = tickerCapLiquidityRank(b.ticker);
      if (ra !== rb) return ra - rb;
      const va = Number(a.avgVolume ?? 0);
      const vb = Number(b.avgVolume ?? 0);
      if (va !== vb) return vb - va;
      return a.ticker.localeCompare(b.ticker);
    });
    this._activeCache = { ts: Date.now(), data: sorted };
    return sorted;
  }

  async getActiveTickers(): Promise<string[]> {
    const items = await this.findActiveSortedByPriority();
    return items.map((i) => i.ticker);
  }

  /**
   * Gộp WATCHLIST (file) + mọi dòng watchlist DB — dùng autocomplete tìm mã.
   * Thứ tự: ưu tiên như WATCHLIST (vốn hoá/thanh khoản), rồi theo mã.
   */
  async getTickerPickerUniverse(): Promise<
    Array<{ ticker: string; name: string; sector: string; active?: boolean }>
  > {
    const map = new Map<
      string,
      { ticker: string; name: string; sector: string; active?: boolean }
    >();

    for (const s of WATCHLIST) {
      const t = s.ticker.toUpperCase();
      map.set(t, { ticker: t, name: s.name, sector: s.sector });
    }

    const rows = await this.repo.find();
    for (const row of rows) {
      const t = row.ticker.toUpperCase();
      const cur = map.get(t);
      if (cur) {
        if (row.name) cur.name = row.name;
        if (row.sector) cur.sector = row.sector;
        cur.active = row.active;
      } else {
        map.set(t, {
          ticker: t,
          name: row.name ?? '',
          sector: row.sector ?? '',
          active: row.active,
        });
      }
    }

    return [...map.values()].sort((a, b) => {
      const ra = tickerCapLiquidityRank(a.ticker);
      const rb = tickerCapLiquidityRank(b.ticker);
      if (ra !== rb) return ra - rb;
      return a.ticker.localeCompare(b.ticker);
    });
  }

  // ─── Thêm / Sửa / Xoá ────────────────────────────────────────────────────

  async add(
    ticker: string,
    name: string,
    sector: string,
  ): Promise<
    WatchlistItem & {
      _sync: {
        barsInserted: number;
        analyzed: boolean;
        error?: string;
      };
    }
  > {
    const t = ticker.toUpperCase().trim();
    const existing = await this.repo.findOne({ where: { ticker: t } });
    let item: WatchlistItem;
    if (existing) {
      // Reactivate nếu đang inactive
      existing.active = true;
      existing.deactivateReason = null;
      existing.name = name || existing.name;
      existing.sector = sector || existing.sector;
      item = await this.repo.save(existing);
    } else {
      item = await this.repo.save(
        this.repo.create({ ticker: t, name, sector, active: true }),
      );
    }
    this.invalidateActiveCache();
    const _sync = await this.syncPricesAndAnalyze(t);
    return { ...item, _sync };
  }

  /** Giống POST /stocks/:ticker/sync — sau khi thêm mã vào watchlist. */
  private async syncPricesAndAnalyze(ticker: string): Promise<{
    barsInserted: number;
    analyzed: boolean;
    error?: string;
  }> {
    try {
      const sync = await this.stockService.syncHistorySmart(
        ticker,
        undefined,
        undefined,
      );
      const barsInserted = sync.saved;
      try {
        await this.signalService.analyze(ticker);
        if (
          shouldRunAnalyzeAllHistoryAfterSync({
            isFullPriceSync: false,
            smartMode: sync.mode,
            savedBarCount: sync.saved,
          })
        ) {
          await this.signalService.analyzeAllHistory(ticker);
        }
      } catch {
        /* analyze* đã log trong SignalService — giống StockController */
      }
      return { barsInserted, analyzed: true };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logger.warn(
        `Sau thêm watchlist ${ticker}: đồng bộ giá / phân tích lỗi — ${msg}`,
      );
      return { barsInserted: 0, analyzed: false, error: msg };
    }
  }

  async remove(id: number): Promise<void> {
    await this.repo.delete(id);
    this.invalidateActiveCache();
  }

  async deactivate(ticker: string, reason: string): Promise<void> {
    await this.repo.update(
      { ticker: ticker.toUpperCase() },
      { active: false, deactivateReason: reason },
    );
    this.invalidateActiveCache();
  }

  async activate(ticker: string): Promise<void> {
    await this.repo.update(
      { ticker: ticker.toUpperCase() },
      { active: true, deactivateReason: null },
    );
    this.invalidateActiveCache();
  }

  // ─── Đồng bộ danh sách chuẩn (WATCHLIST) → DB: thêm mã mới, cập nhật tên/ngành ─

  async syncCanonicalWatchlist(): Promise<{
    inserted: number;
    updated: number;
  }> {
    let inserted = 0;
    let updated = 0;

    for (const s of WATCHLIST) {
      const ticker = s.ticker.toUpperCase();
      const existing = await this.repo.findOne({ where: { ticker } });

      if (!existing) {
        await this.repo.save(
          this.repo.create({
            ticker,
            name: s.name,
            sector: s.sector,
            active: true,
          }),
        );
        inserted++;
        this.logger.log(`➕ Watchlist chuẩn: thêm ${ticker}`);
      } else if (existing.name !== s.name || existing.sector !== s.sector) {
        await this.repo.update(existing.id, { name: s.name, sector: s.sector });
        updated++;
      }
    }

    if (inserted || updated) {
      this.logger.log(
        `Đồng bộ WATCHLIST: +${inserted} mã mới, ${updated} cập nhật metadata`,
      );
    }
    return { inserted, updated };
  }

  /**
   * Quy tắc tự động: (1) đồng bộ mã từ file chuẩn (2) áp ngưỡng thanh khoản như checkLiquidity —
   * tắt mã không đạt, bật lại khi đạt (trừ mã deactivate thủ công MANUAL).
   */
  async runWatchlistAutoRules(): Promise<{
    sync: { inserted: number; updated: number };
    liquidity: {
      checked: number;
      deactivated: string[];
      reactivated: string[];
    };
  }> {
    this.logger.log(
      '▶ Tự động watchlist: đồng bộ danh sách chuẩn → kiểm tra thanh khoản...',
    );
    const sync = await this.syncCanonicalWatchlist();
    const liquidity = await this.checkAllLiquidity();
    this.logger.log(
      `✅ Xong: thêm ${sync.inserted} mã, cập nhật ${sync.updated} dòng; ` +
        `tắt ${liquidity.deactivated.length}, bật lại ${liquidity.reactivated.length}`,
    );
    return { sync, liquidity };
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

      if (isMarketIndexTicker(item.ticker)) {
        continue;
      }

      if (!liq.pass && item.active) {
        await this.repo.update(item.id, {
          active: false,
          deactivateReason: liq.reason,
        });
        deactivated.push(item.ticker);
        this.logger.warn(`❌ Deactivated ${item.ticker}: ${liq.reason}`);
      } else if (
        liq.pass &&
        !item.active &&
        item.deactivateReason !== 'MANUAL'
      ) {
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

  // ─── Cron: đồng bộ danh sách chuẩn + quét thanh khoản (mỗi ngày 7:30) ─────
  @Cron('30 7 * * *', { timeZone: 'Asia/Ho_Chi_Minh' })
  async scheduledWatchlistAutoRules() {
    this.logger.log(
      '⏰ [Cron] Tự động watchlist (chuẩn + thanh khoản theo quy tắc đã định)...',
    );
    await this.runWatchlistAutoRules();
  }
}
