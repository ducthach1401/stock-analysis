import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { JobName, DERIVATIVES_QUEUE } from '../queue/queue.constants';
import { BacktestParams, Vn30BacktestService } from './vn30-backtest.service';

@Processor(DERIVATIVES_QUEUE, { concurrency: 1 })
export class DerivativesJobProcessor extends WorkerHost {
  private readonly logger = new Logger(DerivativesJobProcessor.name);

  constructor(private readonly backtestService: Vn30BacktestService) {
    super();
  }

  async process(job: Job): Promise<unknown> {
    this.logger.log(`▶ Job [${job.name}] #${job.id} bắt đầu`);
    switch (job.name as JobName) {
      case JobName.BACKTEST_VN30:
        return this.backtestService.computeAndCache(job.data as BacktestParams);
      default:
        throw new Error(`DerivativesQueue: unknown job ${job.name}`);
    }
  }
}
