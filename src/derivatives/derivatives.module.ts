import { Module } from '@nestjs/common';
import { DerivativesController } from './derivatives.controller';

@Module({
  controllers: [DerivativesController],
})
export class DerivativesModule {}
