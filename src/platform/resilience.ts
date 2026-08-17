/**
 * Retry, backoff and circuit breaking for platform calls.
 *
 * The governing rule: **only errors explicitly classified as retryable are retried.** An
 * unclassified failure is treated as possibly-applied and is never retried automatically,
 * because retrying a mutation that actually succeeded is how budgets get doubled. Those go to
 * the dead-letter queue for a human instead. A delayed action is recoverable; a silent
 * duplicate spend is not.
 */
import { isRetryable, PlatformError, PlatformUnknownError } from './errors.js';

export interface RetryOptions {
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  /** Deterministic jitter source; injected so tests are reproducible. */
  readonly random?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly onAttemptFailed?: (attempt: number, error: unknown, delayMs: number) => void;
}

export const DEFAULT_RETRY: RetryOptions = {
  maxAttempts: 5,
  baseDelayMs: 500,
  maxDelayMs: 30_000,
};

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Full-jitter exponential backoff, honouring a platform-supplied Retry-After when present. */
export function backoffDelayMs(
  attempt: number,
  options: RetryOptions,
  retryAfterMs: number | null,
  random: () => number,
): number {
  if (retryAfterMs !== null && Number.isFinite(retryAfterMs) && retryAfterMs > 0) {
    return Math.min(retryAfterMs, options.maxDelayMs);
  }
  const exponential = Math.min(options.baseDelayMs * 2 ** (attempt - 1), options.maxDelayMs);
  // Full jitter: uniform in [0, exponential]. Prevents synchronised retry storms across
  // many variants failing at once against the same platform.
  return Math.floor(random() * exponential);
}

export interface RetryOutcome<T> {
  readonly value: T;
  readonly attempts: number;
}

export async function withRetry<T>(
  operation: (attempt: number) => Promise<T>,
  options: RetryOptions = DEFAULT_RETRY,
): Promise<RetryOutcome<T>> {
  const random = options.random ?? Math.random;
  const sleep = options.sleep ?? defaultSleep;

  let lastError: unknown;
  for (let attempt = 1; attempt <= options.maxAttempts; attempt++) {
    try {
      const value = await operation(attempt);
      return { value, attempts: attempt };
    } catch (error) {
      lastError = error;

      if (!isRetryable(error)) throw error;
      if (attempt === options.maxAttempts) break;

      const retryAfter =
        error instanceof PlatformError && 'retryAfterMs' in error
          ? ((error as { retryAfterMs: number | null }).retryAfterMs ?? null)
          : null;
      const delay = backoffDelayMs(attempt, options, retryAfter, random);
      options.onAttemptFailed?.(attempt, error, delay);
      await sleep(delay);
    }
  }
  throw lastError;
}

// ---------------------------------------------------------------------------
// Circuit breaker
// ---------------------------------------------------------------------------

export type BreakerState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export class CircuitOpenError extends Error {
  constructor(
    readonly key: string,
    readonly retryAt: Date,
  ) {
    super(`circuit open for ${key} until ${retryAt.toISOString()}`);
    this.name = 'CircuitOpenError';
  }
}

interface BreakerEntry {
  consecutiveFailures: number;
  state: BreakerState;
  openedAt: number | null;
}

/**
 * One breaker per key (platform + ad account). Opening stops us hammering a failing platform,
 * which matters beyond politeness: sustained hammering is what gets an ad account rate-limited
 * or suspended, turning a temporary outage into a lasting one.
 */
export class CircuitBreaker {
  private readonly entries = new Map<string, BreakerEntry>();

  constructor(
    private readonly failureThreshold = 5,
    private readonly openDurationMs = 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  state(key: string): BreakerState {
    const entry = this.entries.get(key);
    if (!entry) return 'CLOSED';
    if (entry.state === 'OPEN' && entry.openedAt !== null) {
      if (this.now() - entry.openedAt >= this.openDurationMs) {
        entry.state = 'HALF_OPEN';
      }
    }
    return entry.state;
  }

  /** Throws CircuitOpenError when the circuit is open. A half-open circuit permits one probe. */
  assertClosed(key: string): void {
    const state = this.state(key);
    if (state === 'OPEN') {
      const entry = this.entries.get(key)!;
      throw new CircuitOpenError(key, new Date((entry.openedAt ?? this.now()) + this.openDurationMs));
    }
  }

  recordSuccess(key: string): void {
    this.entries.set(key, { consecutiveFailures: 0, state: 'CLOSED', openedAt: null });
  }

  recordFailure(key: string): void {
    const entry = this.entries.get(key) ?? {
      consecutiveFailures: 0,
      state: 'CLOSED' as BreakerState,
      openedAt: null,
    };
    entry.consecutiveFailures += 1;
    // A probe that fails in half-open sends it straight back to open.
    if (entry.state === 'HALF_OPEN' || entry.consecutiveFailures >= this.failureThreshold) {
      entry.state = 'OPEN';
      entry.openedAt = this.now();
    }
    this.entries.set(key, entry);
  }

  async run<T>(key: string, operation: () => Promise<T>): Promise<T> {
    this.assertClosed(key);
    try {
      const value = await operation();
      this.recordSuccess(key);
      return value;
    } catch (error) {
      this.recordFailure(key);
      throw error;
    }
  }

  reset(key?: string): void {
    if (key === undefined) this.entries.clear();
    else this.entries.delete(key);
  }
}

/** Normalises anything thrown by an adapter into a PlatformError, defaulting to non-retryable. */
export function asPlatformError(
  error: unknown,
  context: { platform: string; method: string; idempotencyKey?: string },
): PlatformError {
  if (error instanceof PlatformError) return error;
  return new PlatformUnknownError(
    error instanceof Error ? error.message : String(error),
    { ...context, cause: error },
  );
}
