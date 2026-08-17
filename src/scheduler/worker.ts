/**
 * BullMQ workers. Concurrency is deliberately 1 per queue: these are whole-deployment duty
 * cycles, not per-item jobs, and running two decision cycles at once would fight over the
 * same advisory locks for no benefit — the correct amount of parallelism here is none.
 */
import { Worker, type Job } from 'bullmq';
import { connection, CYCLE_QUEUE, INGEST_QUEUE } from './queue.js';
import { ingestPerformance, runCycleNow } from './index.js';

export function startWorkers(): Worker[] {
  const ingestWorker = new Worker(
    INGEST_QUEUE,
    async () => {
      const result = await ingestPerformance();
      console.log(
        `[ingest] wrote ${result.rowsWritten} snapshot(s)` +
          (result.errors.length ? `, ${result.errors.length} error(s)` : ''),
      );
      for (const e of result.errors) console.error(`[ingest] ${e}`);
      return result;
    },
    { connection, concurrency: 1 },
  );

  const cycleWorker = new Worker(
    CYCLE_QUEUE,
    async () => {
      const result = await runCycleNow();
      console.log(
        `[cycle ${result.cycleId.slice(0, 8)}] ${result.clientsProcessed} client(s), ` +
          `${result.cohortsEvaluated} cohort(s) evaluated, ${result.cohortsSkipped} skipped, ` +
          `${result.decisions.length} decision(s), ${result.errors.length} error(s)`,
      );
      for (const e of result.errors) console.error(`[cycle] ${e.scope} ${e.id}: ${e.message}`);
      return result;
    },
    { connection, concurrency: 1 },
  );

  const onFailed = (label: string) => (job: Job | undefined, error: Error) => {
    console.error(`[${label}] job ${job?.id ?? '?'} failed after ${job?.attemptsMade ?? '?'} attempt(s):`, error);
  };
  ingestWorker.on('failed', onFailed('ingest'));
  cycleWorker.on('failed', onFailed('cycle'));

  return [ingestWorker, cycleWorker];
}
