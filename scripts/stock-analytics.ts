/* eslint-disable no-console */
/**
 * Phân tích lịch sử giả lập cổ phiếu từ `simulated_trades` + `positions`.
 *
 * Chạy:   yarn analytics:stocks [--ticker=XXX] [--from=YYYY-MM-DD] [--to=YYYY-MM-DD]
 *
 * Kết nối DB: dùng ANALYTICS_DB_* nếu có, fallback về DB_* (xem .env).
 * Chỉ đọc — script không ghi/sửa dữ liệu.
 */
import 'reflect-metadata';
import { config as loadEnv } from 'dotenv';
import { DataSource } from 'typeorm';
import { BacktestRun } from '../src/signal/entities/backtest-run.entity';
import { SimulatedTrade } from '../src/signal/entities/simulated-trade.entity';
import { Position } from '../src/position/entities/position.entity';

loadEnv();

const pick = (k: string, fallback: string): string =>
  process.env[`ANALYTICS_${k}`] ?? process.env[k] ?? fallback;

function parseArgs(argv: string[]): {
  ticker?: string;
  from?: string;
  to?: string;
} {
  const out: { ticker?: string; from?: string; to?: string } = {};
  for (const a of argv) {
    const m = /^--(ticker|from|to)=(.+)$/.exec(a);
    if (m) out[m[1] as 'ticker' | 'from' | 'to'] = m[2];
  }
  return out;
}

const r2 = (v: number) => Math.round((v + Number.EPSILON) * 100) / 100;
const signed = (v: number) => (v > 0 ? `+${r2(v)}` : `${r2(v)}`);
const pct = (v: number) => `${v >= 0 ? '+' : ''}${r2(v)}%`;

// ─── Simulated trades analytics ──────────────────────────────────────────────

function summarizeSim(
  label: string,
  trades: SimulatedTrade[],
  from?: string,
  to?: string,
): void {
  const filtered = trades.filter((t) => {
    if (from && String(t.exitDate).slice(0, 10) < from) return false;
    if (to && String(t.exitDate).slice(0, 10) > to) return false;
    return true;
  });

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`📊 ${label}`);
  console.log(`${'─'.repeat(60)}`);

  if (!filtered.length) {
    console.log('  (không có lệnh nào khớp bộ lọc)');
    return;
  }

  const ordered = [...filtered].sort((a, b) =>
    String(a.exitDate).localeCompare(String(b.exitDate)),
  );

  const wins = ordered.filter((t) => Number(t.pnlPercent) > 0);
  const losses = ordered.filter((t) => Number(t.pnlPercent) < 0);
  const breakeven = ordered.filter((t) => Number(t.pnlPercent) === 0);
  const wr = wins.length + losses.length
    ? (wins.length / (wins.length + losses.length)) * 100
    : 0;

  const sumPnl = ordered.reduce((s, t) => s + Number(t.pnlPercent), 0);
  const compound =
    (ordered.reduce((acc, t) => acc * (1 + Number(t.pnlPercent) / 100), 1) - 1) * 100;
  const avgWin = wins.length
    ? wins.reduce((s, t) => s + Number(t.pnlPercent), 0) / wins.length
    : 0;
  const avgLoss = losses.length
    ? losses.reduce((s, t) => s + Number(t.pnlPercent), 0) / losses.length
    : 0;
  const expectancy = wins.length + losses.length
    ? (wr / 100) * avgWin - (1 - wr / 100) * Math.abs(avgLoss)
    : 0;

  const fromDate = ordered[0].exitDate;
  const toDate = ordered[ordered.length - 1].exitDate;
  console.log(`  Kỳ đóng lệnh:   ${fromDate} → ${toDate}`);
  console.log(`  Tổng lệnh:      ${ordered.length} (win ${wins.length} | loss ${losses.length} | hòa ${breakeven.length})`);
  console.log(`  Win-rate:       ${r2(wr)}%`);
  console.log(`  Avg win:        ${pct(avgWin)} | Avg loss: ${pct(avgLoss)}`);
  console.log(`  Expectancy:     ${pct(expectancy)}/lệnh`);
  console.log(`  Σ PnL:          ${pct(sumPnl)}`);
  console.log(`  Compound PnL:   ${pct(compound)}`);

  // Phân bổ theo exit reason
  const byReason = new Map<string, number>();
  for (const t of ordered) {
    const r = t.exitRecommendation ?? 'UNKNOWN';
    byReason.set(r, (byReason.get(r) ?? 0) + 1);
  }
  console.log('\n  Phân bổ exit reason:');
  for (const [reason, count] of [...byReason.entries()].sort((a, b) => b[1] - a[1])) {
    const reasonTrades = ordered.filter((t) => t.exitRecommendation === reason);
    const rNet = reasonTrades.reduce((s, t) => s + Number(t.pnlPercent), 0);
    console.log(`    ${reason.padEnd(24)} ${String(count).padStart(3)} lệnh | NET ${pct(rNet)}`);
  }

  // Phân tích theo tháng
  const byMonth = new Map<string, SimulatedTrade[]>();
  for (const t of ordered) {
    const m = String(t.exitDate).slice(0, 7);
    if (!byMonth.has(m)) byMonth.set(m, []);
    byMonth.get(m)!.push(t);
  }
  const months = [...byMonth.keys()].sort();
  if (months.length > 1) {
    console.log('\n  PnL theo tháng (đóng lệnh):');
    for (const m of months) {
      const mt = byMonth.get(m)!;
      const mWins = mt.filter((t) => Number(t.pnlPercent) > 0).length;
      const mCompound =
        (mt.reduce((acc, t) => acc * (1 + Number(t.pnlPercent) / 100), 1) - 1) * 100;
      const mSum = mt.reduce((s, t) => s + Number(t.pnlPercent), 0);
      const bar = mCompound >= 0
        ? '▓'.repeat(Math.min(20, Math.round(mCompound / 2)))
        : '░'.repeat(Math.min(20, Math.round(Math.abs(mCompound) / 2)));
      console.log(
        `    ${m}  ${String(mt.length).padStart(2)} lệnh  WR ${String(mWins).padStart(2)}/${mt.length}  Σ${pct(mSum).padStart(7)}  cmpd${pct(mCompound).padStart(8)}  ${bar}`,
      );
    }
  }

  // Chuỗi thua liên tiếp
  let maxLoss = 0;
  let cur = 0;
  for (const t of ordered) {
    if (Number(t.pnlPercent) < 0) {
      cur++;
      maxLoss = Math.max(maxLoss, cur);
    } else if (Number(t.pnlPercent) > 0) {
      cur = 0;
    }
  }
  console.log(`\n  Chuỗi thua liên tiếp dài nhất: ${maxLoss}`);
}

// ─── Live positions analytics ────────────────────────────────────────────────

function summarizeLive(positions: Position[], label: string): void {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`🔴 ${label}`);
  console.log(`${'─'.repeat(60)}`);

  if (!positions.length) {
    console.log('  (không có dữ liệu)');
    return;
  }

  const closed = positions.filter((p) => p.status === 'CLOSED' as any && p.closePnlPercent != null);
  const open = positions.filter((p) => p.status === 'OPEN' as any);

  if (open.length) {
    console.log(`\n  🟡 Đang mở: ${open.length} vị thế`);
    for (const p of open) {
      const pnl = p.pnlPercent != null ? pct(Number(p.pnlPercent)) : '?';
      console.log(
        `    ${p.ticker.padEnd(10)} vào ${p.entryDate} @ ${Number(p.entryPrice).toLocaleString('vi-VN')} | PnL ${pnl}`,
      );
    }
  }

  if (!closed.length) {
    console.log('\n  (chưa có lệnh đóng)');
    return;
  }

  const ordered = [...closed].sort((a, b) =>
    String(a.closeDate).localeCompare(String(b.closeDate)),
  );
  const wins = ordered.filter((p) => Number(p.closePnlPercent) > 0);
  const losses = ordered.filter((p) => Number(p.closePnlPercent) < 0);
  const wr = wins.length + losses.length
    ? (wins.length / (wins.length + losses.length)) * 100
    : 0;
  const sumPnl = ordered.reduce((s, p) => s + Number(p.closePnlPercent), 0);
  const compound =
    (ordered.reduce((acc, p) => acc * (1 + Number(p.closePnlPercent) / 100), 1) - 1) * 100;

  console.log(`\n  Lệnh đã đóng:   ${ordered.length} (win ${wins.length} | loss ${losses.length})`);
  console.log(`  Win-rate:       ${r2(wr)}%`);
  console.log(`  Σ PnL:          ${pct(sumPnl)}`);
  console.log(`  Compound PnL:   ${pct(compound)}`);

  console.log('\n  Chi tiết từng lệnh đã đóng:');
  for (const p of ordered) {
    const pnl = Number(p.closePnlPercent);
    const emoji = pnl > 0 ? '✅' : '❌';
    console.log(
      `    ${emoji} ${p.ticker.padEnd(10)} vào ${p.entryDate} → ${p.closeDate} | ${pct(pnl).padStart(8)} | ${p.closeReason ?? '?'}`,
    );
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const ds = new DataSource({
    type: 'mysql',
    host: pick('DB_HOST', 'localhost'),
    port: Number(pick('DB_PORT', '3306')),
    username: pick('DB_USERNAME', 'root'),
    password: pick('DB_PASSWORD', ''),
    database: pick('DB_NAME', 'stock_analysis'),
    entities: [BacktestRun, SimulatedTrade, Position],
    synchronize: false,
    logging: false,
  });
  await ds.initialize();
  console.log(
    `\nKết nối: ${pick('DB_HOST', 'localhost')}/${pick('DB_NAME', 'stock_analysis')}` +
      (process.env.ANALYTICS_DB_HOST ? '  [ANALYTICS override]' : '  [DB_* mặc định]'),
  );

  const filterDesc = [
    args.ticker ? `ticker=${args.ticker.toUpperCase()}` : 'all tickers',
    args.from ? `from=${args.from}` : '',
    args.to ? `to=${args.to}` : '',
  ]
    .filter(Boolean)
    .join(' | ');
  console.log(`Bộ lọc: ${filterDesc || 'không lọc'}\n`);

  try {
    // ── Simulated trades (backtest) ──────────────────────────────────────
    const tradeRepo = ds.getRepository(SimulatedTrade);
    const runRepo = ds.getRepository(BacktestRun);

    let latestRunPerTicker: BacktestRun[];
    if (args.ticker) {
      const run = await runRepo.findOne({
        where: { ticker: args.ticker.toUpperCase() },
        order: { createdAt: 'DESC' },
      });
      latestRunPerTicker = run ? [run] : [];
    } else {
      const allRuns = await runRepo.find({ order: { id: 'DESC' } });
      const byTicker = new Map<string, BacktestRun>();
      for (const r of allRuns) {
        if (!byTicker.has(r.ticker)) byTicker.set(r.ticker, r);
      }
      latestRunPerTicker = [...byTicker.values()];
    }

    if (latestRunPerTicker.length) {
      const runIds = latestRunPerTicker.map((r) => r.id);
      const allTrades = await tradeRepo
        .createQueryBuilder('t')
        .where('t.backtestRunId IN (:...ids)', { ids: runIds })
        .orderBy('t.exitDate', 'ASC')
        .getMany();

      // Gắn ticker vào từng trade qua map runId→ticker
      const runIdToTicker = new Map(latestRunPerTicker.map((r) => [r.id, r.ticker]));
      type TradeWithTicker = SimulatedTrade & { ticker: string };
      const tradesWithTicker: TradeWithTicker[] = allTrades.map((t) => ({
        ...t,
        ticker: runIdToTicker.get(t.backtestRunId) ?? '?',
      }));

      // Tổng hợp toàn bộ
      summarizeSim(
        `BACKTEST — ${latestRunPerTicker.length} mã (run mới nhất mỗi mã)`,
        tradesWithTicker,
        args.from,
        args.to,
      );

      // Nếu lọc theo ticker, show chi tiết từng lệnh
      if (args.ticker) {
        const tickerTrades = tradesWithTicker.filter((t) => t.ticker === args.ticker!.toUpperCase());
        if (tickerTrades.length) {
          console.log(`\n  Chi tiết lệnh ${args.ticker.toUpperCase()}:`);
          for (const t of tickerTrades) {
            const filtered =
              (args.from && String(t.exitDate).slice(0, 10) < args.from) ||
              (args.to && String(t.exitDate).slice(0, 10) > args.to);
            if (filtered) continue;
            const p = Number(t.pnlPercent);
            const emoji = p > 0 ? '✅' : p < 0 ? '❌' : '➖';
            console.log(
              `    ${emoji} vào ${t.entryDate} → ${t.exitDate} | ${pct(p).padStart(8)} | ${t.exitRecommendation}`,
            );
          }
        }
      }
    } else {
      console.log('Không tìm thấy backtest nào.');
    }

    // ── Live positions ───────────────────────────────────────────────────
    const posRepo = ds.getRepository(Position);
    const posQb = posRepo.createQueryBuilder('p').orderBy('p.entryDate', 'ASC');
    if (args.ticker) posQb.where('p.ticker = :ticker', { ticker: args.ticker.toUpperCase() });
    const allPositions = await posQb.getMany();

    summarizeLive(allPositions, 'LIVE POSITIONS (positions table)');
  } finally {
    await ds.destroy();
  }
}

main().catch((e) => {
  console.error('Lỗi phân tích:', e instanceof Error ? e.message : e);
  process.exit(1);
});
