import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { WatchlistService } from './watchlist.service';

@Controller('watchlist')
export class WatchlistController {
  constructor(private readonly watchlistService: WatchlistService) {}

  // GET /watchlist — toàn bộ (kể cả inactive)
  @Get()
  findAll() {
    return this.watchlistService.findAll();
  }

  // GET /watchlist/active — chỉ active
  @Get('active')
  findActive() {
    return this.watchlistService.findActive();
  }

  // POST /watchlist — thêm mã mới
  @UseGuards(JwtAuthGuard)
  @Post()
  add(@Body() body: { ticker: string; name: string; sector: string }) {
    return this.watchlistService.add(body.ticker, body.name, body.sector);
  }

  // PUT /watchlist/:ticker/activate — kích hoạt lại
  @UseGuards(JwtAuthGuard)
  @Put(':ticker/activate')
  activate(@Param('ticker') ticker: string) {
    return this.watchlistService.activate(ticker);
  }

  // PUT /watchlist/:ticker/deactivate — tắt thủ công
  @UseGuards(JwtAuthGuard)
  @Put(':ticker/deactivate')
  deactivate(@Param('ticker') ticker: string) {
    return this.watchlistService.deactivate(ticker, 'MANUAL');
  }

  // DELETE /watchlist/:id — xoá hẳn
  @UseGuards(JwtAuthGuard)
  @Delete(':id')
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.watchlistService.remove(id);
  }

  // POST /watchlist/check-liquidity — đồng bộ mã từ danh sách chuẩn + kiểm tra thanh khoản (cùng cron)
  @UseGuards(JwtAuthGuard)
  @Post('check-liquidity')
  checkLiquidity() {
    return this.watchlistService.runWatchlistAutoRules();
  }
}
