import { Controller, Get } from '@nestjs/common';
import {
  listUpcomingVn30FuturesContracts,
  nearestVn30FuturesContract,
} from './vn30-contracts.util';

@Controller('derivatives')
export class DerivativesController {
  /**
   * Danh sách kỳ hạn tham chiếu + mã nguồn giá (VN30) — không có OHLC từng HĐTL trên API Entrade công khai.
   */
  @Get('vn30/contracts')
  getVn30Contracts() {
    const contracts = listUpcomingVn30FuturesContracts(10);
    const nearest = nearestVn30FuturesContract();
    return {
      priceTicker: 'VN30',
      priceSourceNote:
        'Nến và tín hiệu dùng chỉ số VN30 (Entrade). Hợp đồng gần nhất chỉ để tham chiếu kỳ đáo hạn; không phải giá từng mã HĐTL.',
      nearest,
      contracts,
    };
  }
}
