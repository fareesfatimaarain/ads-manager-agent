import { describe, expect, it } from 'vitest';
import {
  addDays,
  currentDateInZone,
  endOfDayUtc,
  isSettled,
  latestSettledDate,
  startOfDayUtc,
  timezoneOffsetMs,
  TimezoneError,
} from '../../src/time/zonedDate.js';

const H = 3_600_000;

describe('timezoneOffsetMs', () => {
  it('is zero for UTC', () => {
    expect(timezoneOffsetMs(new Date('2026-06-15T12:00:00Z'), 'UTC')).toBe(0);
  });

  it('reflects standard and daylight offsets in New York', () => {
    // January: EST = UTC-5. July: EDT = UTC-4.
    expect(timezoneOffsetMs(new Date('2026-01-15T12:00:00Z'), 'America/New_York')).toBe(-5 * H);
    expect(timezoneOffsetMs(new Date('2026-07-15T12:00:00Z'), 'America/New_York')).toBe(-4 * H);
  });

  it('handles a southern-hemisphere zone, where the seasons invert', () => {
    // Sydney: AEDT = UTC+11 in January, AEST = UTC+10 in July.
    expect(timezoneOffsetMs(new Date('2026-01-15T12:00:00Z'), 'Australia/Sydney')).toBe(11 * H);
    expect(timezoneOffsetMs(new Date('2026-07-15T12:00:00Z'), 'Australia/Sydney')).toBe(10 * H);
  });

  it('handles a half-hour offset zone', () => {
    expect(timezoneOffsetMs(new Date('2026-06-15T12:00:00Z'), 'Asia/Kolkata')).toBe(5.5 * H);
  });

  it('rejects an unknown timezone loudly', () => {
    expect(() => timezoneOffsetMs(new Date(), 'Mars/Olympus')).toThrow(TimezoneError);
  });
});

describe('startOfDayUtc / endOfDayUtc', () => {
  it('matches UTC midnight for UTC', () => {
    expect(startOfDayUtc('2026-08-04', 'UTC').toISOString()).toBe('2026-08-04T00:00:00.000Z');
    expect(endOfDayUtc('2026-08-04', 'UTC').toISOString()).toBe('2026-08-05T00:00:00.000Z');
  });

  it('shifts by the zone offset', () => {
    // Midnight in New York during EDT is 04:00 UTC.
    expect(startOfDayUtc('2026-08-04', 'America/New_York').toISOString()).toBe(
      '2026-08-04T04:00:00.000Z',
    );
    // Midnight in Sydney during AEST is 14:00 UTC the previous day.
    expect(startOfDayUtc('2026-08-04', 'Australia/Sydney').toISOString()).toBe(
      '2026-08-03T14:00:00.000Z',
    );
  });

  it('gets the spring-forward day right', () => {
    // US DST begins 2026-03-08. The day is 23 hours long, not 24.
    const start = startOfDayUtc('2026-03-08', 'America/New_York');
    const end = endOfDayUtc('2026-03-08', 'America/New_York');
    expect((end.getTime() - start.getTime()) / H).toBe(23);
  });

  it('gets the fall-back day right', () => {
    // US DST ends 2026-11-01. The day is 25 hours long.
    const start = startOfDayUtc('2026-11-01', 'America/New_York');
    const end = endOfDayUtc('2026-11-01', 'America/New_York');
    expect((end.getTime() - start.getTime()) / H).toBe(25);
  });

  it('gets a southern-hemisphere transition right', () => {
    // Sydney DST ends 2026-04-05; that day has 25 hours.
    const start = startOfDayUtc('2026-04-05', 'Australia/Sydney');
    const end = endOfDayUtc('2026-04-05', 'Australia/Sydney');
    expect((end.getTime() - start.getTime()) / H).toBe(25);
  });

  it('rejects malformed dates', () => {
    expect(() => startOfDayUtc('04-08-2026', 'UTC')).toThrow(TimezoneError);
    expect(() => startOfDayUtc('2026-8-4', 'UTC')).toThrow(TimezoneError);
  });
});

describe('addDays / currentDateInZone', () => {
  it('shifts calendar dates without timezone involvement', () => {
    expect(addDays('2026-08-04', 1)).toBe('2026-08-05');
    expect(addDays('2026-08-04', -1)).toBe('2026-08-03');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29'); // leap year
  });

  it('reports the local calendar date, which can differ from the UTC one', () => {
    const instant = new Date('2026-08-04T22:00:00Z');
    expect(currentDateInZone(instant, 'UTC')).toBe('2026-08-04');
    // Already tomorrow in Sydney.
    expect(currentDateInZone(instant, 'Australia/Sydney')).toBe('2026-08-05');
    // Still yesterday evening in Los Angeles.
    expect(currentDateInZone(instant, 'America/Los_Angeles')).toBe('2026-08-04');
  });
});

describe('isSettled — the rule that stops decisions on incomplete data', () => {
  const tz = 'America/New_York';

  it('is not settled while the day is still running', () => {
    // Midday on the day itself.
    expect(isSettled('2026-08-04', tz, 72, new Date('2026-08-04T16:00:00Z'))).toBe(false);
  });

  it('is not settled the moment the day ends', () => {
    // 2026-08-04 ends at 04:00Z on the 5th. Settling has not started elapsing.
    expect(isSettled('2026-08-04', tz, 72, new Date('2026-08-05T04:00:01Z'))).toBe(false);
  });

  it('is not settled one second before the window closes', () => {
    expect(isSettled('2026-08-04', tz, 72, new Date('2026-08-08T03:59:59Z'))).toBe(false);
  });

  it('is settled exactly when the window closes', () => {
    // 04:00Z on the 5th + 72h = 04:00Z on the 8th.
    expect(isSettled('2026-08-04', tz, 72, new Date('2026-08-08T04:00:00Z'))).toBe(true);
  });

  it('treats a zero settling window as settled at end of day', () => {
    expect(isSettled('2026-08-04', tz, 0, new Date('2026-08-05T03:59:59Z'))).toBe(false);
    expect(isSettled('2026-08-04', tz, 0, new Date('2026-08-05T04:00:00Z'))).toBe(true);
  });

  it('accounts for the zone, not UTC', () => {
    const at = new Date('2026-08-08T02:00:00Z');
    // In UTC the day ended at 00:00Z on the 5th, so 72h elapsed at 00:00Z on the 8th.
    expect(isSettled('2026-08-04', 'UTC', 72, at)).toBe(true);
    // In New York it ended four hours later, so it is not settled yet.
    expect(isSettled('2026-08-04', tz, 72, at)).toBe(false);
  });

  it('rejects a negative settling window', () => {
    expect(() => isSettled('2026-08-04', tz, -1, new Date())).toThrow(TimezoneError);
  });
});

describe('latestSettledDate', () => {
  it('lands three days back for a 72h window', () => {
    const now = new Date('2026-08-08T12:00:00Z');
    expect(latestSettledDate('UTC', 72, now)).toBe('2026-08-04');
  });

  it('lands on yesterday when nothing needs to settle', () => {
    const now = new Date('2026-08-08T12:00:00Z');
    expect(latestSettledDate('UTC', 0, now)).toBe('2026-08-07');
  });

  it('always returns a date that is genuinely settled', () => {
    const now = new Date('2026-11-02T09:00:00Z'); // just after a DST transition
    for (const tz of ['UTC', 'America/New_York', 'Australia/Sydney', 'Asia/Kolkata']) {
      const d = latestSettledDate(tz, 72, now);
      expect(isSettled(d, tz, 72, now)).toBe(true);
      expect(isSettled(addDays(d, 1), tz, 72, now)).toBe(false);
    }
  });
});
