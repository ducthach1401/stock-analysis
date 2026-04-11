import { Controller, Get, Param, Post, Query } from '@nestjs/common';
import { RecommendationService } from './recommendation.service';
import { SignalService } from './signal.service';

@Controller('signals')
export class SignalController {
  constructor(
    private readonly signalService: SignalService,
    private readonly recommendationService: RecommendationService,
  ) {}

  // POST /signals/:ticker/analyze — phân tích và lưu tín hiệu
  @Post(':ticker/analyze')
  analyze(@Param('ticker') ticker: string) {
    return this.signalService.analyze(ticker);
  }

  // POST /signals/:ticker/notify — phân tích + gửi tín hiệu lên Telegram
  @Post(':ticker/notify')
  analyzeAndNotify(@Param('ticker') ticker: string) {
    return this.signalService.analyzeAndNotify(ticker);
  }

  // POST /signals/:ticker/recommend — lời khuyên mua/bán
  @Post(':ticker/recommend')
  recommend(@Param('ticker') ticker: string) {
    return this.recommendationService.recommend(ticker);
  }

  // POST /signals/:ticker/recommend/notify — lời khuyên + gửi Telegram
  @Post(':ticker/recommend/notify')
  recommendAndNotify(@Param('ticker') ticker: string) {
    return this.recommendationService.recommendAndNotify(ticker);
  }

  // GET /signals/:ticker?date=2024-12-01 — lấy tín hiệu đã lưu
  @Get(':ticker')
  getSignals(@Param('ticker') ticker: string, @Query('date') date?: string) {
    return this.signalService.getSignals(ticker, date);
  }
}
