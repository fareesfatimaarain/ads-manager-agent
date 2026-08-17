/**
 * Timezone arithmetic for stat dates.
 *
 * Ad platforms bucket performance by *the ad account's* calendar day, not UTC. Deciding
 * whether a given day's figures have finished settling therefore means answering "when did
 * that day actually end, in that account's timezone, expressed as an instant" — which is not
 * something Date does natively, and which naive `+24h` arithmetic gets wrong twice a year.
 *
 * Getting this wrong is not cosmetic. Treating a day as settled an hour early means deciding
 * on conversion figures that are still rising, which biases every decision toward killing
 * good ads. Implemented with Intl rather than a date library so there is no dependency to
 * drift, and tested against real DST transitions in both hemispheres.
 */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export class TimezoneError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TimezoneError';
  }
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(timeZone);
  if (cached) return cached;
  let fmt: Intl.DateTimeFormat;
  try {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    throw new TimezoneError(`unknown IANA timezone: ${timeZone}`);
  }
  formatterCache.set(timeZone, fmt);
  return fmt;
}

/** Offset of `timeZone` from UTC at a given instant, in milliseconds (positive = east). */
export function timezoneOffsetMs(instant: Date, timeZone: string): number {
  const parts = formatterFor(timeZone).formatToParts(instant);
  const get = (type: string): number => {
    const found = parts.find((p) => p.type === type);
    if (!found) throw new TimezoneError(`missing ${type} for ${timeZone}`);
    return Number(found.value);
  };
  // Reconstruct the wall-clock reading as if it were UTC; the difference is the offset.
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/**
 * The instant at which local midnight occurs on `isoDate` in `timeZone`.
 *
 * Resolved by guessing the offset and correcting once, which handles DST transitions. On a
 * spring-forward day where local midnight does not exist the result lands on the first valid
 * instant after the jump, which is the conservative direction for a day boundary.
 */
export function startOfDayUtc(isoDate: string, timeZone: string): Date {
  if (!ISO_DATE.test(isoDate)) {
    throw new TimezoneError(`expected an ISO date (YYYY-MM-DD), received "${isoDate}"`);
  }
  const naive = Date.parse(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(naive)) throw new TimezoneError(`invalid date: ${isoDate}`);

  const firstGuess = new Date(naive - timezoneOffsetMs(new Date(naive), timeZone));
  // Re-derive the offset at the candidate instant; they differ across a DST boundary.
  const corrected = new Date(naive - timezoneOffsetMs(firstGuess, timeZone));
  return corrected;
}

/** The instant at which `isoDate` ends in `timeZone` — i.e. local midnight of the next day. */
export function endOfDayUtc(isoDate: string, timeZone: string): Date {
  return startOfDayUtc(addDays(isoDate, 1), timeZone);
}

/** Calendar date shift on an ISO date string, without timezone involvement. */
export function addDays(isoDate: string, days: number): string {
  if (!ISO_DATE.test(isoDate)) {
    throw new TimezoneError(`expected an ISO date (YYYY-MM-DD), received "${isoDate}"`);
  }
  const t = Date.parse(`${isoDate}T00:00:00Z`);
  return new Date(t + days * 86_400_000).toISOString().slice(0, 10);
}

/** The calendar date currently in effect in `timeZone`. */
export function currentDateInZone(now: Date, timeZone: string): string {
  const parts = formatterFor(timeZone).formatToParts(now);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/**
 * Whether a stat date's figures may be treated as final.
 *
 * Settled means: the day has ended in the account's timezone, AND the platform's attribution
 * window has since elapsed. Both conditions matter — a day that ended ten minutes ago is over,
 * but its conversion figures will keep climbing for days.
 */
export function isSettled(
  isoDate: string,
  timeZone: string,
  settlingHours: number,
  now: Date,
): boolean {
  if (!Number.isFinite(settlingHours) || settlingHours < 0) {
    throw new TimezoneError(`settlingHours must be >= 0, received ${settlingHours}`);
  }
  const settledAt = endOfDayUtc(isoDate, timeZone).getTime() + settlingHours * 3_600_000;
  return now.getTime() >= settledAt;
}

/** The most recent date that is fully settled. Useful for bounding queries. */
export function latestSettledDate(
  timeZone: string,
  settlingHours: number,
  now: Date,
): string {
  let candidate = currentDateInZone(now, timeZone);
  // Walk backwards until settled. Bounded so a bad timezone cannot spin forever.
  for (let i = 0; i < 400; i++) {
    if (isSettled(candidate, timeZone, settlingHours, now)) return candidate;
    candidate = addDays(candidate, -1);
  }
  throw new TimezoneError(
    `could not find a settled date within 400 days for ${timeZone} at ${settlingHours}h`,
  );
}
