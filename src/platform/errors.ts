/**
 * Platform error taxonomy.
 *
 * Retry logic reads `retryable` and nothing else. This exists because "retry on any error"
 * is actively dangerous: retrying a validation failure burns the retry budget and delays a
 * real fix, while retrying a request that actually SUCCEEDED but timed out on the response
 * is how budgets get doubled. Adapters are responsible for classifying correctly — that
 * classification is the contract, and it is the adapter's most safety-critical job.
 */

export type PlatformErrorKind =
  | 'RATE_LIMIT'
  | 'TRANSIENT'
  | 'AUTH'
  | 'VALIDATION'
  | 'CONFLICT'
  | 'NOT_FOUND'
  | 'PRECONDITION_FAILED'
  | 'UNKNOWN';

export abstract class PlatformError extends Error {
  abstract readonly kind: PlatformErrorKind;
  abstract readonly retryable: boolean;

  constructor(
    message: string,
    readonly context: {
      readonly platform: string;
      readonly method: string;
      readonly idempotencyKey?: string;
      readonly platformCode?: string | number;
      readonly cause?: unknown;
    },
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** Back off and retry; honour `retryAfterMs` when the platform supplies it. */
export class PlatformRateLimitError extends PlatformError {
  readonly kind = 'RATE_LIMIT' as const;
  readonly retryable = true;
  constructor(
    message: string,
    context: PlatformError['context'],
    readonly retryAfterMs: number | null = null,
  ) {
    super(message, context);
  }
}

/** Network blip, 5xx, timeout. Safe to retry ONLY because every mutation is idempotent. */
export class PlatformTransientError extends PlatformError {
  readonly kind = 'TRANSIENT' as const;
  readonly retryable = true;
}

/**
 * Token expired or revoked. Not retryable with the same credentials — the account must be
 * marked TOKEN_EXPIRED and a human prompted to reconnect. Retrying here just locks the
 * account out faster.
 */
export class PlatformAuthError extends PlatformError {
  readonly kind = 'AUTH' as const;
  readonly retryable = false;
}

/** Malformed request or rejected creative. Retrying an identical payload cannot help. */
export class PlatformValidationError extends PlatformError {
  readonly kind = 'VALIDATION' as const;
  readonly retryable = false;
}

/** The same idempotency key was already used with a different payload. Never retry. */
export class PlatformConflictError extends PlatformError {
  readonly kind = 'CONFLICT' as const;
  readonly retryable = false;
}

export class PlatformNotFoundError extends PlatformError {
  readonly kind = 'NOT_FOUND' as const;
  readonly retryable = false;
}

/**
 * Optimistic-concurrency failure: the entity's current state on the platform did not match
 * what the decision was based on. Something else changed the budget underneath us — often a
 * human in Ads Manager. The decision must be re-derived from fresh data, never forced.
 */
export class PlatformPreconditionFailedError extends PlatformError {
  readonly kind = 'PRECONDITION_FAILED' as const;
  readonly retryable = false;
}

/**
 * Unclassified. Treated as NOT retryable, deliberately. An unknown error may or may not have
 * applied its mutation; retrying risks double-execution, so it goes to the dead-letter queue
 * for a human instead. Silent money movement is worse than a delayed action.
 */
export class PlatformUnknownError extends PlatformError {
  readonly kind = 'UNKNOWN' as const;
  readonly retryable = false;
}

export function isPlatformError(e: unknown): e is PlatformError {
  return e instanceof PlatformError;
}

export function isRetryable(e: unknown): boolean {
  return isPlatformError(e) && e.retryable;
}
