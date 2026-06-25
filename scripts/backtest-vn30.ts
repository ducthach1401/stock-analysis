/* eslint-disable no-console */
/**
 * Backtest VN30 5m — CLI offline, kết quả in ra terminal + file HTML.
 *
 * Chạy:
 *   yarn backtest:vn30 [--from=YYYY-MM-DD] [--to=YYYY-MM-DD]
 *                      [--trailing=off] [--rsicap=off]
 *                      [--long=normal|tight|off]
 *                      [--chart=backtest-chart.html]
 *
 * Logic tính toán nằm trong src/derivatives/vn30-backtest-core.ts (dùng chung với API).
 */
import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';
import {
  BacktestFlags,
  Bar,
  LongMode,
  MIN_BARS,
  Trade,
  buildSeries,
  runBacktest,
  vnDate,
  vnHhmm,
} from '../src/derivatives/vn30-backtest-core';

const DNSE_CHART_INDEX =
  'https://services.entrade.com.vn/chart-api/v2/ohlcs/index';

const r2 = (v: number) => Math.round((v + Number.EPSILON) * 100) / 100;
const signed = (v: number) => (v > 0 ? `+${r2(v)}` : `${r2(v)}`);

function report(label: string, trades: Trade[]): void {
  if (!trades.length) {
    console.log(`\n[${label}] không có lệnh`);
    return;
  }
  const series = buildSeries(label, '', '', trades);
  const s = series.stats;
  console.log(
    `\n[${label}]  ${s.trades} lệnh | WR ${s.wr}% | NET ${signed(s.net)} | ` +
      `PF ${s.pf ?? '∞'} | Exp/lệnh ${signed(s.exp)}`,
  );
  console.log(
    `         LONG ${s.longTrades} (NET ${signed(s.longNet)})  |  ` +
      `SHORT ${s.shortTrades} (NET ${signed(s.shortNet)})`,
  );
  if (series.monthly.length > 1) {
    for (const m of series.monthly) {
      const lN = trades.filter(
        (t) => t.side === 'LONG' && t.date.startsWith(m.month),
      ).length;
      const sN = trades.filter(
        (t) => t.side === 'SHORT' && t.date.startsWith(m.month),
      ).length;
      const mW = trades.filter(
        (t) => t.outcome === 'WIN' && t.date.startsWith(m.month),
      ).length;
      const mL = trades.filter(
        (t) => t.outcome === 'LOSS' && t.date.startsWith(m.month),
      ).length;
      const mTotal = trades.filter((t) => t.date.startsWith(m.month)).length;
      console.log(
        `    ${m.month}: ${mTotal}L (L${lN}/S${sN}) | ` +
          `WIN ${mW} LOSS ${mL} | NET ${signed(m.net)}`,
      );
    }
  }
}

// ── Chart generation ──────────────────────────────────────────────────────
type ChartSeriesInput = { label: string; color: string; trades: Trade[] };

function generateChart(
  series: ChartSeriesInput[],
  fromDate: string,
  toDate: string,
  outFile: string,
): void {
  const allDates = [
    ...new Set(series.flatMap((s) => s.trades.map((t) => t.date))),
  ].sort();

  function buildCumValues(trades: Trade[], dates: string[]): number[] {
    const dailyFinal = new Map<string, number>();
    let cum = 0;
    for (const t of trades) {
      cum += t.pnl;
      dailyFinal.set(t.date, r2(cum));
    }
    let last = 0;
    return dates.map((d) => {
      if (dailyFinal.has(d)) last = dailyFinal.get(d)!;
      return last;
    });
  }

  const chartDatasets = series.map((s) => ({
    label: s.label,
    color: s.color,
    values: buildCumValues(s.trades, allDates),
  }));

  const statCards = series.map((s) => {
    const sr = buildSeries(s.label, '', s.color, s.trades).stats;
    return { ...sr, label: s.label, color: s.color };
  });

  const months = [...new Set(allDates.map((d) => d.slice(0, 7)))].sort();
  const monthlyData = series.map((s) =>
    months.map((m) => {
      const mt = s.trades.filter((t) => t.date.startsWith(m));
      return r2(mt.reduce((a, t) => a + t.pnl, 0));
    }),
  );

  const labelsJson = JSON.stringify(allDates);
  const datasetsJson = JSON.stringify(chartDatasets);
  const statsJson = JSON.stringify(statCards);
  const monthsJson = JSON.stringify(months);
  const monthlyJson = JSON.stringify(monthlyData);

  const html =
    '<!DOCTYPE html>\n' +
    '<html lang="vi">\n' +
    '<head>\n' +
    '  <meta charset="UTF-8">\n' +
    '  <meta name="viewport" content="width=device-width, initial-scale=1">\n' +
    '  <title>VN30 Backtest — Chiến lược LONG</title>\n' +
    '  <style>\n' +
    '    *{box-sizing:border-box}\n' +
    '    body{font-family:system-ui,sans-serif;background:#0f172a;color:#e2e8f0;margin:0;padding:24px}\n' +
    '    h2{color:#38bdf8;margin:0 0 2px}\n' +
    '    .sub{color:#94a3b8;margin:0 0 20px;font-size:13px}\n' +
    '    .wrap{background:#1e293b;border-radius:12px;padding:20px;margin-bottom:20px}\n' +
    '    h3{color:#94a3b8;font-size:12px;letter-spacing:.8px;text-transform:uppercase;margin:0 0 14px}\n' +
    '    .cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:12px;margin-bottom:20px}\n' +
    '    .card{background:#1e293b;border-radius:10px;padding:16px 20px;border-left:4px solid var(--c)}\n' +
    '    .card-title{font-size:11px;color:#94a3b8;margin-bottom:8px;font-weight:700;letter-spacing:.5px;text-transform:uppercase}\n' +
    '    .card-net{font-size:28px;font-weight:700;line-height:1}\n' +
    '    .card-meta{font-size:12px;color:#64748b;margin-top:6px}\n' +
    '    .card-side{font-size:11px;color:#94a3b8;margin-top:4px}\n' +
    '    .pos{color:#4ade80}.neg{color:#f87171}\n' +
    '  </style>\n' +
    '</head>\n' +
    '<body>\n' +
    '  <h2>VN30 Backtest — Chiến lược LONG</h2>\n' +
    '  <p class="sub">' +
    fromDate +
    ' → ' +
    toDate +
    '</p>\n' +
    '  <div class="cards" id="cards"></div>\n' +
    '  <div class="wrap">\n' +
    '    <h3>Equity curve tích lũy (theo ngày)</h3>\n' +
    '    <canvas id="equity" height="110"></canvas>\n' +
    '  </div>\n' +
    '  <div class="wrap">\n' +
    '    <h3>NET P/L theo tháng</h3>\n' +
    '    <canvas id="monthly" height="90"></canvas>\n' +
    '  </div>\n' +
    '  <script src="https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js"></script>\n' +
    '  <script>\n' +
    '    var LABELS=' +
    labelsJson +
    ';\n' +
    '    var DS=' +
    datasetsJson +
    ';\n' +
    '    var STATS=' +
    statsJson +
    ';\n' +
    '    var MONTHS=' +
    monthsJson +
    ';\n' +
    '    var MONTHLY=' +
    monthlyJson +
    ';\n' +
    '    var cardsEl=document.getElementById("cards");\n' +
    '    STATS.forEach(function(s){\n' +
    '      var pos=s.net>=0;\n' +
    '      var netStr=(pos?"+":"")+s.net.toFixed(2)+"d";\n' +
    '      cardsEl.innerHTML+=\'<div class="card" style="--c:\'+s.color+\'">\'+\n' +
    "        '<div class=\"card-title\">'+s.label+'</div>'+\n" +
    '        \'<div class="card-net \'+( pos?"pos":"neg")+\'">\'+netStr+\'</div>\'+\n' +
    '        \'<div class="card-meta">PF \'+(s.pf||"∞")+" · WR "+s.wr+"% · "+s.trades+" lệnh</div>"+\n' +
    '        \'<div class="card-side">LONG \'+s.longTrades+" (NET "+(s.longNet>=0?"+":"")+s.longNet+"d) · SHORT "+s.shortTrades+" (NET "+(s.shortNet>=0?"+":"")+s.shortNet+"d)</div>"+\n' +
    '        "</div>";\n' +
    '    });\n' +
    '    new Chart(document.getElementById("equity"),{\n' +
    '      type:"line",\n' +
    '      data:{\n' +
    '        labels:LABELS,\n' +
    '        datasets:DS.map(function(d){\n' +
    '          return{label:d.label,data:d.values,borderColor:d.color,backgroundColor:d.color+"18",\n' +
    '            fill:true,pointRadius:0,pointHoverRadius:4,borderWidth:2,tension:0.3};\n' +
    '        })\n' +
    '      },\n' +
    '      options:{\n' +
    '        responsive:true,\n' +
    '        interaction:{mode:"index",intersect:false},\n' +
    '        plugins:{\n' +
    '          legend:{labels:{color:"#e2e8f0",boxWidth:12}},\n' +
    '          tooltip:{\n' +
    '            backgroundColor:"#1e293b",borderColor:"#334155",borderWidth:1,\n' +
    '            titleColor:"#94a3b8",bodyColor:"#e2e8f0",\n' +
    '            callbacks:{label:function(ctx){\n' +
    '              var v=ctx.parsed.y;\n' +
    '              return" "+ctx.dataset.label+": "+(v>=0?"+":"")+v.toFixed(2)+"d";\n' +
    '            }}\n' +
    '          }\n' +
    '        },\n' +
    '        scales:{\n' +
    '          x:{ticks:{color:"#64748b",maxTicksLimit:10,maxRotation:0},grid:{color:"#1e293b"}},\n' +
    '          y:{ticks:{color:"#94a3b8"},grid:{color:"#334155"},\n' +
    '             title:{display:true,text:"Diem tich luy (VN30)",color:"#94a3b8"}}\n' +
    '        }\n' +
    '      }\n' +
    '    });\n' +
    '    new Chart(document.getElementById("monthly"),{\n' +
    '      type:"bar",\n' +
    '      data:{\n' +
    '        labels:MONTHS,\n' +
    '        datasets:DS.map(function(d,i){\n' +
    '          return{label:d.label,data:MONTHLY[i],backgroundColor:d.color+"cc",borderRadius:4};\n' +
    '        })\n' +
    '      },\n' +
    '      options:{\n' +
    '        responsive:true,\n' +
    '        interaction:{mode:"index",intersect:false},\n' +
    '        plugins:{legend:{labels:{color:"#e2e8f0",boxWidth:12}}},\n' +
    '        scales:{\n' +
    '          x:{ticks:{color:"#94a3b8"},grid:{color:"#1e293b"}},\n' +
    '          y:{ticks:{color:"#94a3b8"},grid:{color:"#334155"},\n' +
    '             title:{display:true,text:"NET P/L (diem)",color:"#94a3b8"}}\n' +
    '        }\n' +
    '      }\n' +
    '    });\n' +
    '  </script>\n' +
    '</body>\n' +
    '</html>';

  fs.writeFileSync(outFile, html, 'utf8');
  console.log(`\nChart: ${outFile}`);
}

async function fetchBars(from: Date, to: Date): Promise<Bar[]> {
  const { data } = await axios.get(DNSE_CHART_INDEX, {
    params: {
      symbol: 'VN30',
      resolution: '5',
      from: Math.floor(from.getTime() / 1000),
      to: Math.floor(to.getTime() / 1000),
    },
    headers: { 'User-Agent': 'Mozilla/5.0 Chrome/124.0' },
    timeout: 60000,
  });
  const t: number[] = data?.t ?? [];
  const out: Bar[] = t.map((ts: number, i: number) => ({
    time: ts,
    o: Math.round((data.o[i] ?? 0) * 1000),
    h: Math.round((data.h[i] ?? 0) * 1000),
    l: Math.round((data.l[i] ?? 0) * 1000),
    c: Math.round((data.c[i] ?? 0) * 1000),
    v: Math.round(data.v[i] ?? 0),
  }));
  return out
    .filter((b) =>
      [b.o, b.h, b.l, b.c].every((x) => Number.isFinite(x) && x > 0),
    )
    .sort((a, b) => a.time - b.time);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const get = (k: string) =>
    args.find((a) => a.startsWith(`--${k}=`))?.split('=')[1];

  const to = get('to') ? new Date(get('to') + 'T23:59:59') : new Date();
  const from = get('from')
    ? new Date(get('from') + 'T00:00:00')
    : new Date(to.getTime() - 40 * 24 * 60 * 60 * 1000);

  const flagEma50 = get('ema50') === 'on';
  const flagTrailing = get('trailing') !== 'off';
  const flagRsicap = get('rsicap') !== 'off';
  const longArg = get('long') as LongMode | undefined;
  const chartOut = path.resolve(get('chart') ?? path.join(__dirname, '..', 'public', 'backtest-chart.html'));

  const bars = await fetchBars(from, to);
  console.log(
    `Nến 5m VN30: ${bars.length} (${vnDate(bars[0]?.time ?? 0)} → ${vnDate(bars[bars.length - 1]?.time ?? 0)})`,
  );
  if (bars.length < MIN_BARS) {
    console.log('Không đủ nến để backtest.');
    return;
  }

  // Xác nhận memoize đã warm — tránh re-import khi chạy nhiều lần
  vnHhmm(bars[0].time);

  const base: Omit<BacktestFlags, 'long'> = {
    ema50: flagEma50,
    trailing: flagTrailing,
    rsicap: flagRsicap,
    short: 'normal',
    session: 'all',
    minAtr: 1.5,
  };

  if (longArg) {
    report(
      `V3 [long=${longArg}]`,
      await runBacktest(bars, { ...base, long: longArg }),
    );
    return;
  }

  const normalTrades = await runBacktest(bars, { ...base, long: 'normal' });
  const tightTrades  = await runBacktest(bars, { ...base, long: 'tight' });
  const offTrades    = await runBacktest(bars, { ...base, long: 'off' });

  console.log('\n══════════════════════════════════════════════');
  console.log(' SO SÁNH CHẾ ĐỘ LONG (SHORT giữ nguyên)');
  console.log('══════════════════════════════════════════════');
  report('LONG bình thường — 4/5 check, RSI 50-75', normalTrades);
  report('LONG siết (tight) — 5/5 check, RSI 58-72', tightTrades);
  report('Tắt LONG — chỉ SHORT', offTrades);

  console.log('\n══════════════════════════════════════════════');
  console.log(' SO SÁNH TÍNH NĂNG (LONG=normal, tham khảo)');
  console.log('══════════════════════════════════════════════');
  report(
    '  + bật lại EMA50',
    await runBacktest(bars, { ...base, ema50: true, long: 'normal' }),
  );
  report(
    '  − bỏ trailing stop',
    await runBacktest(bars, { ...base, trailing: false, long: 'normal' }),
  );
  report(
    '  − bỏ trần RSI',
    await runBacktest(bars, { ...base, rsicap: false, long: 'normal' }),
  );

  generateChart(
    [
      { label: 'LONG bình thường (4/5)',        color: '#3b82f6', trades: normalTrades },
      { label: 'LONG siết tight (5/5, RSI 58-72)', color: '#10b981', trades: tightTrades },
      { label: 'SHORT only (tắt LONG)',         color: '#f59e0b', trades: offTrades },
    ],
    vnDate(bars[0].time),
    vnDate(bars[bars.length - 1].time),
    chartOut,
  );
}

main().catch((e) => {
  console.error('Backtest lỗi:', e instanceof Error ? e.message : e);
  process.exit(1);
});
