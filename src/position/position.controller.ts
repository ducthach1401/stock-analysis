import {
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Query,
  ParseFloatPipe,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PositionService } from './position.service';

@Controller('positions')
export class PositionController {
  constructor(private readonly positionService: PositionService) {}

  // GET /positions — tất cả vị thế
  @Get()
  getAll() {
    return this.positionService.getAllPositions();
  }

  // GET /positions/open — vị thế đang mở
  @Get('open')
  getOpen() {
    return this.positionService.getOpenPositions();
  }

  // GET /positions/closed — lịch sử đóng
  @Get('closed')
  getClosed() {
    return this.positionService.getClosedPositions();
  }

  // POST /positions/track — cập nhật giá + check target/stop thủ công
  @UseGuards(JwtAuthGuard)
  @Post('track')
  track() {
    return this.positionService.trackAll();
  }

  // DELETE /positions/:id — đóng vị thế thủ công
  @UseGuards(JwtAuthGuard)
  @Delete(':id')
  closeManual(
    @Param('id', ParseIntPipe) id: number,
    @Query('price', new ParseFloatPipe({ optional: true })) price?: number,
  ) {
    return this.positionService.closeManual(id, price);
  }
}
