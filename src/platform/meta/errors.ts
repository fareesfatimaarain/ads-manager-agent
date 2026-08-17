/**
 * Translates a Meta Graph API error response into this codebase's PlatformError taxonomy.
 *
 * This classification is the single most safety-critical part of a real adapter — see the
 * doc comment on PlatformError. Getting AUTH classified as TRANSIENT would mean hammering a
 * dead token until the circuit breaker trips; getting a genuine transient 5xx classified as
 * non-retryable would dead-letter things that would have succeeded on the next attempt.
 *
 * Reference: https://developers.facebook.com/docs/marketing-api/error-reference
 */
import {
  PlatformAuthError,
  PlatformError,
  PlatformNotFoundError,
  PlatformPreconditionFailedError,
  PlatformRateLimitError,
  PlatformTransientError,
  PlatformUnknownError,
  PlatformValidationError,
} from '../errors.js';

export interface MetaGraphErrorBody {
  readonly error?: {
    readonly message?: string;
    readonly type?: string;
    readonly code?: number;
    readonly error_subcode?: number;
    readonly error_user_msg?: string;
    readonly fbtrace_id?: string;
  };
}

/** OAuth/token errors. Not retryable with the same credentials — the account needs reconnecting. */
const AUTH_CODES = new Set([190, 102, 2500]);

/** Application- and account-level rate limiting. Retryable with backoff. */
const RATE_LIMIT_CODES = new Set([4, 17, 32, 613, 80004]);

/** "Does not exist" / was deleted out from under us. */
const NOT_FOUND_SUBCODES = new Set([33, 2635]);

export function classifyMetaError(
  httpStatus: number,
  body: MetaGraphErrorBody | null,
  context: { platform: string; method: string; idempotencyKey?: string },
): PlatformError {
  const err = body?.error;
  const message = err?.error_user_msg || err?.message || `Meta API returned HTTP ${httpStatus}`;
  // exactOptionalPropertyTypes forbids `platformCode: undefined` — only include the key when
  // there's a real value to attach.
  const ctx = err?.code !== undefined ? { ...context, platformCode: err.code } : context;

  if (err?.code !== undefined && AUTH_CODES.has(err.code)) {
    return new PlatformAuthError(message, ctx);
  }
  if (httpStatus === 401 || httpStatus === 403) {
    return new PlatformAuthError(message, ctx);
  }

  if (err?.code !== undefined && RATE_LIMIT_CODES.has(err.code)) {
    // Meta does not reliably send a numeric Retry-After for these; a conservative fixed
    // backoff is safer than assuming immediate availability.
    return new PlatformRateLimitError(message, ctx, 60_000);
  }
  if (httpStatus === 429) {
    return new PlatformRateLimitError(message, ctx, 60_000);
  }

  if (err?.error_subcode !== undefined && NOT_FOUND_SUBCODES.has(err.error_subcode)) {
    return new PlatformNotFoundError(message, ctx);
  }
  if (httpStatus === 404) {
    return new PlatformNotFoundError(message, ctx);
  }

  // 400 with an invalid-parameter/validation-shaped code: not retryable, the payload itself
  // is the problem.
  if (httpStatus === 400 || err?.code === 100) {
    return new PlatformValidationError(message, ctx);
  }

  if (httpStatus >= 500 || httpStatus === 0) {
    return new PlatformTransientError(message, ctx);
  }

  return new PlatformUnknownError(message, { ...ctx, cause: body });
}

/** Raised by updateBudget's own precondition check — not a Meta error, a local comparison. */
export function budgetPreconditionError(
  expected: number,
  actual: number,
  context: { platform: string; method: string; idempotencyKey?: string },
): PlatformPreconditionFailedError {
  return new PlatformPreconditionFailedError(
    `budget precondition failed: expected ${expected}, found ${actual}`,
    context,
  );
}
