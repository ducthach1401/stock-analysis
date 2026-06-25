/* eslint-disable no-console */
/**
 * Phân tích lịch sử quyết định phái sinh VN30 từ bảng `derivative_decisions`.
 *
 * Chạy:   yarn analytics:derivatives [--algo=V3] [--from=YYYY-MM-DD] [--to=YYYY-MM-DD]
 *
 * Kết nối DB: dùng ANALYTICS_DB_* nếu có, fallback về DB_* (xem .env).
 * Để phân tích PRODUCTION từ máy dev: đặt ANALYTICS_DB_* trỏ sang prod (user read-only).
 *
 * Chỉ đọc — script không ghi/sửa dữ liệu.
 */
import 'reflect-metadata';
import { config as loadEnv } from 'dotenv';
import { DataSource } from 'typeorm';
import {
  DerivativeDecision,
  DerivativeDecisionAction,
  DerivativeDecisionOutcome,
  DerivativeDecisionStatus,
} from '../src/derivatives/entities/derivative-decision.entity';

loadEnv();

const pick = (k: string, fallback: string): string =>
  process.env[`ANALYTICS_${k}`] ?? process.env[k] ?? fallback;

function parseArgs(argv: string[]): {
  algo?: string;
  from?: string;
  to?: string;
} {
  const out: { algo?: string; from?: string; to?: string } = {};
  for (const a of argv) {
    const m = /^--(algo|from|to)=(.+)$/.exec(a);
    if (m) out[m[1] as 'algo' | 'from' | 'to'] = m[2];
  }
  return out;
}

const r2 = (v: number) => Math.round((v + Number.EPSILON) * 100) / 100;
const signed = (v: number) => (v > 0 ? `+${r2(v)}` : `${r2(v)}`);

type Row = {
  action: DerivativeDecisionAction;
  outcome: DerivativeDecisionOutcome | null;
  pnl: number;
  rsi: number | null;
  atr: number | null;
  hour: number;
  algorithm: string;
};

function summarize(label: string, rows: Row[]): void {
  const trades = rows.filter(
    (r) =>
      r.action === DerivativeDecisionAction.LONG ||
      r.action === DerivativeDecisionAction.SHORT,
  );
  if (!trades.length) {
    console.log(`\n=== ${label} === (không có lệnh)`);
    return;
  }
  const wins = trades.filter(
    (t) => t.outcome === DerivativeDecisionOutcome.WIN,
  );
  const losses = trades.filter(
    (t) => t.outcome === DerivativeDecisionOutcome.LOSS,
  );
  const neutral = trades.filter(
    (t) => t.outcome === DerivativeDecisionOutcome.TIME_EXIT,
  );
  const net = trades.reduce((s, t) => s + t.pnl, 0);
  const gp = trades.filter((t) => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
  const gl = trades.filter((t) => t.pnl < 0).reduce((s, t) => s + t.pnl, 0);
  const decided = wins.length + losses.length;
  const wr = decided ? (wins.length / decided) * 100 : 0;
  const pf = gl !== 0 ? gp / Math.abs(gl) : Infinity;

  console.log(`\n=== ${label} ===`);
  console.log(`Tổng lệnh thực: ${trades.length}`);
  console.log(
    `WIN ${wins.length} | LOSS ${losses.length} | TIME_EXIT/hòa ${neutral.length}`,
  );
  console.log(`Win-rate (WIN/LOSS): ${r2(wr)}%`);
  console.log(
    `NET P/L: ${signed(net)} điểm | Expectancy/lệnh: ${signed(net / trades.length)}`,
  );
  console.log(
    `Gross profit ${signed(gp)} | Gross loss ${signed(gl)} | Profit Factor ${pf === Infinity ? '∞' : r2(pf)}`,
  );

  for (const side of [
    DerivativeDecisionAction.LONG,
    DerivativeDecisionAction.SHORT,
  ]) {
    const s = trades.filter((t) => t.action === side);
    if (!s.length) continue;
    const w = s.filter(
      (t) => t.outcome === DerivativeDecisionOutcome.WIN,
    ).length;
    const l = s.filter(
      (t) => t.outcome === DerivativeDecisionOutcome.LOSS,
    ).length;
    const sNet = s.reduce((acc, t) => acc + t.pnl, 0);
    const sWr = w + l ? (w / (w + l)) * 100 : 0;
    console.log(
      `  ${side}: ${s.length} lệnh | WIN ${w} LOSS ${l} | win-rate ${r2(sWr)}% | NET ${signed(sNet)}`,
    );
  }

  // Chuỗi thua liên tiếp dài nhất (theo thứ tự thời gian đã sort sẵn)
  let maxLoss = 0;
  let cur = 0;
  for (const t of trades) {
    if (t.outcome === DerivativeDecisionOutcome.LOSS) {
      cur += 1;
      maxLoss = Math.max(maxLoss, cur);
    } else if (t.outcome === DerivativeDecisionOutcome.WIN) {
      cur = 0;
    }
  }
  console.log(`  Chuỗi thua liên tiếp dài nhất: ${maxLoss}`);

  // Phân bố win-rate theo RSI vào lệnh (phát hiện đu đỉnh/đáy)
  const rsiBuckets: Array<[string, (r: number) => boolean]> = [
    ['<30', (x) => x < 30],
    ['30-50', (x) => x >= 30 && x < 50],
    ['50-70', (x) => x >= 50 && x < 70],
    ['70-80', (x) => x >= 70 && x < 80],
    ['>=80', (x) => x >= 80],
  ];
  const withRsi = trades.filter((t) => t.rsi != null);
  if (withRsi.length) {
    console.log('  Win-rate theo RSI vào lệnh:');
    for (const [name, fn] of rsiBuckets) {
      const b = withRsi.filter((t) => fn(t.rsi as number));
      if (!b.length) continue;
      const w = b.filter(
        (t) => t.outcome === DerivativeDecisionOutcome.WIN,
      ).length;
      const l = b.filter(
        (t) => t.outcome === DerivativeDecisionOutcome.LOSS,
      ).length;
      const bNet = b.reduce((acc, t) => acc + t.pnl, 0);
      console.log(
        `    RSI ${name.padEnd(6)}: ${String(b.length).padStart(3)} lệnh | WR ${w + l ? r2((w / (w + l)) * 100) : 0}% | NET ${signed(bNet)}`,
      );
    }
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const ds = new DataSource({
    type: 'mysql',
    host: pick('DB_HOST', 'localhost'),
    port: Number(pick('DB_PORT', '3306')),
    username: pick('DB_USERNAME', 'root'),
    password: pick('DB_PASSWORD', ''),
    database: pick('DB_NAME', 'stock_analysis'),
    entities: [DerivativeDecision],
    synchronize: false,
    logging: false,
  });
  await ds.initialize();
  console.log(
    `Kết nối: ${pick('DB_HOST', 'localhost')}/${pick('DB_NAME', 'stock_analysis')}` +
      (process.env.ANALYTICS_DB_HOST
        ? '  [ANALYTICS override]'
        : '  [DB_* mặc định]'),
  );

  try {
    const repo = ds.getRepository(DerivativeDecision);
    const qb = repo
      .createQueryBuilder('d')
      .where('d.symbol = :symbol', { symbol: 'VN30' })
      .andWhere('d.status = :status', {
        status: DerivativeDecisionStatus.CLOSED,
      })
      .andWhere('d.action IN (:...actions)', {
        actions: [
          DerivativeDecisionAction.LONG,
          DerivativeDecisionAction.SHORT,
        ],
      })
      .orderBy('d.decidedAt', 'ASC');
    if (args.algo)
      qb.andWhere('d.algorithm LIKE :algo', { algo: `%${args.algo}%` });
    if (args.from) qb.andWhere('d.tradingDate >= :from', { from: args.from });
    if (args.to) qb.andWhere('d.tradingDate <= :to', { to: args.to });

    const raw = await qb.getMany();

    // Dedup theo symbol|action|decidedAt (cùng quy ước recentDecisions)
    const seen = new Set<string>();
    const rows: Row[] = [];
    for (const d of raw) {
      const key = `${d.action}|${d.decidedAt.toISOString()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (d.pnlPoints == null) continue;
      const metrics = (d.metadata?.metrics ?? {}) as Record<string, unknown>;
      const rsi = Number(metrics.rsi14);
      const atr = Number(metrics.atr14);
      rows.push({
        action: d.action,
        outcome: d.outcome,
        pnl: Number(d.pnlPoints),
        rsi: Number.isFinite(rsi) ? rsi : null,
        atr: Number.isFinite(atr) ? atr : null,
        hour: new Date(d.decidedAt).getUTCHours(),
        algorithm: d.algorithm,
      });
    }

    if (!rows.length) {
      console.log('\nKhông có lệnh đã đóng nào khớp bộ lọc.');
      return;
    }

    const range = `${args.from ?? raw[0].tradingDate} → ${args.to ?? raw[raw.length - 1].tradingDate}`;
    const algos = [...new Set(rows.map((r) => r.algorithm))].sort();
    const algoTag = algos
      .map((a) => a.replace(/^VN30_EMA_VWAP_RSI_ATR_5M_/, ''))
      .join(', ');
    summarize(`TỔNG [${algoTag}] (${range})`, rows);

    // Tách theo từng phiên bản thuật toán để so sánh các đời (V1 / V2 / V3 ...)
    if (algos.length > 1) {
      for (const algo of algos) {
        summarize(
          algo,
          rows.filter((r) => r.algorithm === algo),
        );
      }
    }
  } finally {
    await ds.destroy();
  }
}

main().catch((e) => {
  console.error('Lỗi phân tích:', e instanceof Error ? e.message : e);
  process.exit(1);
});
