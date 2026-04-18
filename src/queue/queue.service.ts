import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { Queue } from 'bullmq';
import { JobName, STOCK_QUEUE } from './queue.constants';

@Injectable()
export class QueueService {
  constructor(
    @InjectQueue(STOCK_QUEUE)
    private readonly queue: Queue,
  ) {}

  // ─── Enqueue jobs ──────────────────────────────────────────────────────────

  async enqueueSyncAll(from?: string, full?: boolean) {
    return this.queue.add(JobName.SYNC_ALL, { from, full }, this.defaultOpts());
  }

  async enqueueSyncTicker(
    ticker: string,
    from?: string,
    full?: boolean,
    windowDays?: number,
  ) {
    return this.queue.add(
      JobName.SYNC_TICKER,
      { ticker, from, full, windowDays },
      this.defaultOpts(),
    );
  }

  async enqueueScanAll() {
    return this.queue.add(JobName.SCAN_ALL, {}, this.defaultOpts());
  }

  async enqueueAnalyzeHistoryAll(from?: string) {
    return this.queue.add(
      JobName.ANALYZE_HISTORY_ALL,
      { from },
      this.defaultOpts(),
    );
  }

  async enqueueAnalyzeHistoryTicker(ticker: string, from?: string) {
    return this.queue.add(
      JobName.ANALYZE_HISTORY_TICKER,
      { ticker, from },
      this.defaultOpts(),
    );
  }

  // ─── Status ────────────────────────────────────────────────────────────────

  async getJobStatus(jobId: string) {
    const job = await this.queue.getJob(jobId);
    if (!job) return null;

    const state = await job.getState();
    const progress: unknown = job.progress;
    const result: unknown = state === 'completed' ? job.returnvalue : null;
    const failReason: unknown =
      state === 'failed' ? job.failedReason : undefined;

    return {
      id: job.id,
      name: job.name,
      state,
      progress,
      result,
      failReason,
      data: job.data as unknown,
      createdAt: new Date(job.timestamp).toISOString(),
    };
  }

  async getQueueStats() {
    const [waiting, active, completed, failed] = await Promise.all([
      this.queue.getWaitingCount(),
      this.queue.getActiveCount(),
      this.queue.getCompletedCount(),
      this.queue.getFailedCount(),
    ]);
    return { waiting, active, completed, failed };
  }

  // ─── Private ───────────────────────────────────────────────────────────────

  private defaultOpts() {
    return {
      removeOnComplete: 50, // giữ 50 jobs hoàn thành gần nhất
      removeOnFail: 20,
      attempts: 2,
      backoff: { type: 'fixed' as const, delay: 5000 },
    };
  }
}
