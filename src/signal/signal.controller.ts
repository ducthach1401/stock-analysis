import { Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RecommendationService } from './recommendation.service';
import { SignalBacktestService } from './signal-backtest.service';
import { SignalService } from './signal.service';

@Controller('signals')
export class SignalController {
  constructor(
    private readonly signalService: SignalService,
    private readonly recommendationService: RecommendationService,
    private readonly signalBacktestService: SignalBacktestService,
  ) {}

  /** GET /signals/backtest/summary — compound % 12 tháng gần nhất (ngày đóng lệnh); run full lịch sử. */
  @Get('backtest/summary')
  getBacktestSummary(@Query('limit') limit?: string) {
    const n = limit ? parseInt(limit, 10) : 10;
    const lim = Number.isFinite(n) && n > 0 && n <= 50 ? n : 10;
    return this.signalBacktestService.getBacktestGoodBad(lim);
  }

  // POST /signals/:ticker/analyze — phân tích và lưu tín hiệu
  @UseGuards(JwtAuthGuard)
  @Post(':ticker/analyze')
  analyze(@Param('ticker') ticker: string) {
    return this.signalService.analyze(ticker);
  }

  // POST /signals/:ticker/analyze-history?from=YYYY-MM-DD — phân tích lịch sử
  @UseGuards(JwtAuthGuard)
  @Post(':ticker/analyze-history')
  analyzeHistory(
    @Param('ticker') ticker: string,
    @Query('from') from?: string,
  ) {
    return this.signalService.analyzeAllHistory(ticker, from);
  }

  // POST /signals/:ticker/notify — phân tích + gửi tín hiệu lên Telegram
  @UseGuards(JwtAuthGuard)
  @Post(':ticker/notify')
  analyzeAndNotify(@Param('ticker') ticker: string) {
    return this.signalService.analyzeAndNotify(ticker);
  }

  // POST /signals/:ticker/recommend — lời khuyên mua/bán (public — dùng cho chart)
  @Post(':ticker/recommend')
  recommend(@Param('ticker') ticker: string) {
    return this.recommendationService.recommend(ticker);
  }

  // POST /signals/:ticker/recommend/notify — lời khuyên + gửi Telegram
  @UseGuards(JwtAuthGuard)
  @Post(':ticker/recommend/notify')
  recommendAndNotify(@Param('ticker') ticker: string) {
    return this.recommendationService.recommendAndNotify(ticker);
  }

  // GET /signals/:ticker?date=2024-12-01 — lấy tín hiệu đã lưu (20 mới nhất)
  @Get(':ticker')
  getSignals(@Param('ticker') ticker: string, @Query('date') date?: string) {
    return this.signalService.getSignals(ticker, date);
  }

  // GET /signals/:ticker/chart?from=YYYY-MM-DD — tất cả tín hiệu cho chart markers
  @Get(':ticker/chart')
  getSignalsForChart(
    @Param('ticker') ticker: string,
    @Query('from') from?: string,
  ) {
    return this.signalService.getSignalsForChart(ticker, from);
  }

  /** POST .../backtest/run — trong service: sync giá tăng dần rồi giả lập full nến trong DB. */
  @UseGuards(JwtAuthGuard)
  @Post(':ticker/backtest/run')
  runSignalBacktest(@Param('ticker') ticker: string) {
    return this.signalBacktestService.runBacktest(ticker);
  }

  @Get(':ticker/backtest/runs')
  listBacktestRuns(
    @Param('ticker') ticker: string,
    @Query('take') take?: string,
  ) {
    const n = take ? parseInt(take, 10) : 20;
    return this.signalBacktestService.listRuns(
      ticker,
      Number.isFinite(n) && n > 0 ? Math.min(n, 100) : 20,
    );
  }

  @Get(':ticker/backtest/runs/:runId')
  getBacktestRun(
    @Param('ticker') ticker: string,
    @Param('runId') runId: string,
  ) {
    return this.signalBacktestService.getRun(ticker, parseInt(runId, 10));
  }
}
