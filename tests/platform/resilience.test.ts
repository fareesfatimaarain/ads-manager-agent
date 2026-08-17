import { describe, expect, it, vi } from 'vitest';
import {
  backoffDelayMs,
  CircuitBreaker,
  CircuitOpenError,
  DEFAULT_RETRY,
  asPlatformError,
  withRetry,
  type RetryOptions,
} from '../../src/platform/resilience.js';
import {
  PlatformRateLimitError,
  PlatformTransientError,
  PlatformValidationError,
  PlatformUnknownError,
} from '../../src/platform/errors.js';

const ctx = { platform: 'MOCK', method: 'updateBudget' };

/** No real waiting, deterministic jitter. */
const testOptions = (over: Partial<RetryOptions> = {}): RetryOptions => ({
  ...DEFAULT_RETRY,
  baseDelayMs: 100,
  random: () => 0.5,
  sleep: async () => {},
  ...over,
});

describe('withRetry', () => {
  it('returns immediately on success', async () => {
    const op = vi.fn().mockResolvedValue('ok');
    const result = await withRetry(op, testOptions());
    expect(result.value).toBe('ok');
    expect(result.attempts).toBe(1);
    expect(op).toHaveBeenCalledTimes(1);
  });

  it('retries a transient failure and eventually succeeds', async () => {
    const op = vi
      .fn()
      .mockRejectedValueOnce(new PlatformTransientError('blip', ctx))
      .mockRejectedValueOnce(new PlatformTransientError('blip', ctx))
      .mockResolvedValue('ok');
    const result = await withRetry(op, testOptions());
    expect(result.value).toBe('ok');
    expect(result.attempts).toBe(3);
  });

  it('does NOT retry a validation error — retrying an identical payload cannot help', async () => {
    const op = vi.fn().mockRejectedValue(new PlatformValidationError('bad field', ctx));
    await expect(withRetry(op, testOptions())).rejects.toBeInstanceOf(PlatformValidationError);
    expect(op).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry an unknown error, because it may already have applied', async () => {
    // This is the safety-critical case: an unclassified failure might have mutated the
    // account. Retrying would risk a double spend, so it goes to a human instead.
    const op = vi.fn().mockRejectedValue(new PlatformUnknownError('???', ctx));
    await expect(withRetry(op, testOptions())).rejects.toBeInstanceOf(PlatformUnknownError);
    expect(op).toHaveBeenCalledTimes(1);
  });

  it('gives up after maxAttempts and rethrows the last error', async () => {
    const op = vi.fn().mockRejectedValue(new PlatformTransientError('down', ctx));
    await expect(withRetry(op, testOptions({ maxAttempts: 3 }))).rejects.toBeInstanceOf(
      PlatformTransientError,
    );
    expect(op).toHaveBeenCalledTimes(3);
  });

  it('passes the attempt number, so callers can reconcile before retrying', async () => {
    const seen: number[] = [];
    const op = vi.fn(async (attempt: number) => {
      seen.push(attempt);
      if (attempt < 3) throw new PlatformTransientError('blip', ctx);
      return 'ok';
    });
    await withRetry(op, testOptions());
    expect(seen).toEqual([1, 2, 3]);
  });

  it('honours a platform-supplied retry-after', async () => {
    const delays: number[] = [];
    const op = vi
      .fn()
      .mockRejectedValueOnce(new PlatformRateLimitError('slow down', ctx, 5_000))
      .mockResolvedValue('ok');
    await withRetry(
      op,
      testOptions({ onAttemptFailed: (_a, _e, delay) => delays.push(delay) }),
    );
    expect(delays[0]).toBe(5_000);
  });
});

describe('backoffDelayMs', () => {
  const opts = testOptions({ baseDelayMs: 100, maxDelayMs: 10_000 });

  it('grows exponentially', () => {
    const at = (n: number) => backoffDelayMs(n, opts, null, () => 1);
    expect(at(1)).toBe(100);
    expect(at(2)).toBe(200);
    expect(at(3)).toBe(400);
    expect(at(4)).toBe(800);
  });

  it('is capped', () => {
    expect(backoffDelayMs(20, opts, null, () => 1)).toBe(10_000);
  });

  it('applies full jitter, so retries do not synchronise into a storm', () => {
    expect(backoffDelayMs(4, opts, null, () => 0)).toBe(0);
    expect(backoffDelayMs(4, opts, null, () => 0.5)).toBe(400);
    expect(backoffDelayMs(4, opts, null, () => 1)).toBe(800);
  });

  it('caps a retry-after that exceeds the maximum', () => {
    expect(backoffDelayMs(1, opts, 999_999, () => 1)).toBe(10_000);
  });
});

describe('CircuitBreaker', () => {
  const key = 'MOCK:acc-1';

  it('starts closed', () => {
    expect(new CircuitBreaker().state(key)).toBe('CLOSED');
  });

  it('opens after the failure threshold', () => {
    const b = new CircuitBreaker(3, 60_000);
    b.recordFailure(key);
    b.recordFailure(key);
    expect(b.state(key)).toBe('CLOSED');
    b.recordFailure(key);
    expect(b.state(key)).toBe('OPEN');
  });

  it('refuses calls while open', async () => {
    const b = new CircuitBreaker(1, 60_000);
    b.recordFailure(key);
    await expect(b.run(key, async () => 'never')).rejects.toBeInstanceOf(CircuitOpenError);
  });

  it('half-opens after the cooldown and closes on a successful probe', async () => {
    let now = 1_000;
    const b = new CircuitBreaker(1, 5_000, () => now);
    b.recordFailure(key);
    expect(b.state(key)).toBe('OPEN');

    now += 5_000;
    expect(b.state(key)).toBe('HALF_OPEN');

    await expect(b.run(key, async () => 'ok')).resolves.toBe('ok');
    expect(b.state(key)).toBe('CLOSED');
  });

  it('reopens immediately when the probe fails', async () => {
    let now = 1_000;
    const b = new CircuitBreaker(1, 5_000, () => now);
    b.recordFailure(key);
    now += 5_000;
    expect(b.state(key)).toBe('HALF_OPEN');

    await expect(
      b.run(key, async () => {
        throw new PlatformTransientError('still down', ctx);
      }),
    ).rejects.toBeInstanceOf(PlatformTransientError);
    expect(b.state(key)).toBe('OPEN');
  });

  it('resets the failure count on success', () => {
    const b = new CircuitBreaker(3, 60_000);
    b.recordFailure(key);
    b.recordFailure(key);
    b.recordSuccess(key);
    b.recordFailure(key);
    b.recordFailure(key);
    expect(b.state(key)).toBe('CLOSED');
  });

  it('keeps separate accounts isolated — one failing account must not stop another', () => {
    const b = new CircuitBreaker(1, 60_000);
    b.recordFailure('MOCK:acc-1');
    expect(b.state('MOCK:acc-1')).toBe('OPEN');
    expect(b.state('MOCK:acc-2')).toBe('CLOSED');
  });
});

describe('asPlatformError', () => {
  it('passes platform errors through unchanged', () => {
    const original = new PlatformTransientError('blip', ctx);
    expect(asPlatformError(original, ctx)).toBe(original);
  });

  it('wraps anything else as non-retryable', () => {
    const wrapped = asPlatformError(new Error('boom'), ctx);
    expect(wrapped).toBeInstanceOf(PlatformUnknownError);
    expect(wrapped.retryable).toBe(false);
  });

  it('handles a thrown non-Error', () => {
    expect(asPlatformError('a string', ctx).message).toBe('a string');
  });
});
