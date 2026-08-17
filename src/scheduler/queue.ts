/**
 * BullMQ queues for the two recurring jobs. Cron gave the previous version of this file no
 * retry, no visibility into a stuck job, and no way to run it as more than one process. BullMQ
 * over Redis gives all three: a failed ingest retries with backoff instead of silently waiting
 * for the next scheduled tick, and `npm run scheduler` can be run as a managed, restartable
 * process rather than a bare `node-cron` timer living inside whatever process happened to
 * import it.
 */
import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { env } from '../config/env.js';

// BullMQ blocks on Redis commands that must not time out on their own; it manages retries
// internally and expects this.
export const connection = new IORedis(env.redisUrl, { maxRetriesPerRequest: null });

export const INGEST_QUEUE = 'ad-manager-ingest';
export const CYCLE_QUEUE = 'ad-manager-cycle';

export const ingestQueue = new Queue(INGEST_QUEUE, { connection });
export const cycleQueue = new Queue(CYCLE_QUEUE, { connection });

const RETRY_OPTS = {
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 30_000 },
  removeOnComplete: { count: 100 },
  removeOnFail: { count: 200 },
};

/**
 * Registers the two recurring jobs. Safe to call on every process start: it checks for an
 * existing repeatable job with the same pattern before adding, so restarting the scheduler
 * never produces a second, duplicate schedule ticking alongside the first.
 */
export async function scheduleRecurringJobs(): Promise<void> {
  await ensureRepeatable(ingestQueue, 'ingest', '0 */3 * * *');
  await ensureRepeatable(cycleQueue, 'cycle', '0 6 * * *');
}

async function ensureRepeatable(queue: Queue, name: string, pattern: string): Promise<void> {
  const existing = await queue.getRepeatableJobs();
  if (existing.some((j) => j.pattern === pattern && j.name === name)) return;
  await queue.add(name, {}, { ...RETRY_OPTS, repeat: { pattern } });
}

export async function closeQueues(): Promise<void> {
  await ingestQueue.close();
  await cycleQueue.close();
  await connection.quit();
}
