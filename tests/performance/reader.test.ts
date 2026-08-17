import { describe, expect, it } from 'vitest';
import {
  aggregateSnapshots,
  variantsWithMissingData,
  type PerformanceSnapshot,
} from '../../src/performance/reader.js';

const NOW = new Date('2026-08-08T12:00:00Z');
const TZ = 'UTC';

const snap = (over: Partial<PerformanceSnapshot> = {}): PerformanceSnapshot => ({
  adVariantId: 'v1',
  statDate: '2026-08-01',
  fetchedAt: new Date('2026-08-08T06:00:00Z'),
  impressions: 1_000,
  clicks: 20,
  spendCents: 3_000,
  conversions: 2,
  conversionValueCents: 12_000,
  ...over,
});

const opts = { timeZone: TZ, settlingHours: 72, now: NOW };

describe('aggregateSnapshots — restatement handling', () => {
  it('uses the latest snapshot for a date and discards earlier ones', () => {
    // The platform restated 2026-08-01: 2 conversions became 5.
    const result = aggregateSnapshots(
      [
        snap({ fetchedAt: new Date('2026-08-02T06:00:00Z'), conversions: 2 }),
        snap({ fetchedAt: new Date('2026-08-05T06:00:00Z'), conversions: 5 }),
        snap({ fetchedAt: new Date('2026-08-03T06:00:00Z'), conversions: 3 }),
      ],
      ['v1'],
      opts,
    );
    expect(result.get('v1')!.settled.conversions).toBe(5);
  });

  it('does not sum restatements of the same date', () => {
    const result = aggregateSnapshots(
      [snap({ conversions: 2 }), snap({ fetchedAt: new Date('2026-08-08T07:00:00Z'), conversions: 4 })],
      ['v1'],
      opts,
    );
    expect(result.get('v1')!.settled.conversions).toBe(4);
    expect(result.get('v1')!.settledDayCount).toBe(1);
  });

  it('reports the newest fetch timestamp across all dates', () => {
    const result = aggregateSnapshots(
      [
        snap({ statDate: '2026-08-01', fetchedAt: new Date('2026-08-08T06:00:00Z') }),
        snap({ statDate: '2026-08-02', fetchedAt: new Date('2026-08-08T09:00:00Z') }),
      ],
      ['v1'],
      opts,
    );
    expect(result.get('v1')!.newestFetchedAt!.toISOString()).toBe('2026-08-08T09:00:00.000Z');
  });
});

describe('aggregateSnapshots — the settling window', () => {
  it('excludes unsettled dates from conversion figures', () => {
    // 08-01 is settled at this `now`; 08-07 is not.
    const result = aggregateSnapshots(
      [
        snap({ statDate: '2026-08-01', conversions: 10, spendCents: 5_000 }),
        snap({ statDate: '2026-08-07', conversions: 99, spendCents: 5_000 }),
      ],
      ['v1'],
      opts,
    );
    const v = result.get('v1')!;
    expect(v.settled.conversions).toBe(10);
    expect(v.settled.spendCents).toBe(5_000);
    expect(v.settledDayCount).toBe(1);
  });

  it('includes every date in the proxy figures', () => {
    const result = aggregateSnapshots(
      [
        snap({ statDate: '2026-08-01', impressions: 1_000, clicks: 20 }),
        snap({ statDate: '2026-08-07', impressions: 4_000, clicks: 80 }),
      ],
      ['v1'],
      opts,
    );
    const v = result.get('v1')!;
    // Proxy sees all 5000 impressions; settled only the first day's 1000.
    expect(v.proxy.impressions).toBe(5_000);
    expect(v.settled.impressions).toBe(1_000);
    expect(v.totalDayCount).toBe(2);
  });

  it('would have undercounted badly without the window — the reason it exists', () => {
    // Recent days always under-report. If they were included, settled conversions would be
    // dragged down by dates that have not finished counting.
    const withRecent = aggregateSnapshots(
      [
        snap({ statDate: '2026-08-01', conversions: 30, spendCents: 10_000 }),
        snap({ statDate: '2026-08-07', conversions: 3, spendCents: 10_000 }), // still settling
      ],
      ['v1'],
      opts,
    ).get('v1')!;

    // Settled CPA is 10000/30 = 333. Including the unsettled day would give 20000/33 = 606,
    // nearly double, purely because the second day has not finished reporting.
    const settledCpa = withRecent.settled.spendCents / withRecent.settled.conversions;
    expect(settledCpa).toBeCloseTo(333.33, 1);
  });

  it('respects the account timezone when deciding settlement', () => {
    // At this instant 2026-08-05 is settled in UTC but not in New York (day ends 4h later).
    const at = new Date('2026-08-09T02:00:00Z');
    const rows = [snap({ statDate: '2026-08-05', conversions: 7 })];

    const utc = aggregateSnapshots(rows, ['v1'], { timeZone: 'UTC', settlingHours: 72, now: at });
    const ny = aggregateSnapshots(rows, ['v1'], {
      timeZone: 'America/New_York',
      settlingHours: 72,
      now: at,
    });

    expect(utc.get('v1')!.settled.conversions).toBe(7);
    expect(ny.get('v1')!.settled.conversions).toBe(0);
  });
});

describe('aggregateSnapshots — daily series', () => {
  it('returns settled days only, oldest first', () => {
    const result = aggregateSnapshots(
      [
        snap({ statDate: '2026-08-03', spendCents: 300 }),
        snap({ statDate: '2026-08-01', spendCents: 100 }),
        snap({ statDate: '2026-08-02', spendCents: 200 }),
        snap({ statDate: '2026-08-07', spendCents: 700 }), // unsettled
      ],
      ['v1'],
      opts,
    );
    const daily = result.get('v1')!.settledDaily;
    expect(daily.map((d) => d.statDate)).toEqual(['2026-08-01', '2026-08-02', '2026-08-03']);
    expect(daily.map((d) => d.spendCents)).toEqual([100, 200, 300]);
  });
});

describe('aggregateSnapshots — bookkeeping', () => {
  it('returns a zeroed entry for a variant with no data', () => {
    const result = aggregateSnapshots([], ['v1', 'v2'], opts);
    expect(result.size).toBe(2);
    expect(result.get('v2')!.settled.conversions).toBe(0);
    expect(result.get('v2')!.newestFetchedAt).toBeNull();
  });

  it('ignores snapshots for variants that were not requested', () => {
    const result = aggregateSnapshots([snap({ adVariantId: 'stranger' })], ['v1'], opts);
    expect(result.has('stranger')).toBe(false);
    expect(result.get('v1')!.totalDayCount).toBe(0);
  });

  it('keeps variants separate', () => {
    const result = aggregateSnapshots(
      [
        snap({ adVariantId: 'a', conversions: 5 }),
        snap({ adVariantId: 'b', conversions: 9 }),
      ],
      ['a', 'b'],
      opts,
    );
    expect(result.get('a')!.settled.conversions).toBe(5);
    expect(result.get('b')!.settled.conversions).toBe(9);
  });
});

describe('variantsWithMissingData', () => {
  const build = (rows: PerformanceSnapshot[], ids: string[]) =>
    aggregateSnapshots(rows, ids, opts);

  it('flags a variant with no rows at all', () => {
    const perf = build([], ['v1']);
    expect(variantsWithMissingData(perf, ['v1'], 36, NOW)).toEqual(['v1']);
  });

  it('flags a variant whose newest data is stale', () => {
    const perf = build([snap({ fetchedAt: new Date('2026-08-05T00:00:00Z') })], ['v1']);
    expect(variantsWithMissingData(perf, ['v1'], 36, NOW)).toEqual(['v1']);
  });

  it('flags a future-dated snapshot rather than treating it as fresh', () => {
    const perf = build([snap({ fetchedAt: new Date('2026-08-09T00:00:00Z') })], ['v1']);
    expect(variantsWithMissingData(perf, ['v1'], 36, NOW)).toEqual(['v1']);
  });

  it('passes a variant with fresh data', () => {
    const perf = build([snap({ fetchedAt: new Date('2026-08-08T06:00:00Z') })], ['v1']);
    expect(variantsWithMissingData(perf, ['v1'], 36, NOW)).toEqual([]);
  });

  it('flags only the affected variant, so the caller can skip the whole cohort', () => {
    const perf = build(
      [
        snap({ adVariantId: 'good', fetchedAt: new Date('2026-08-08T06:00:00Z') }),
        snap({ adVariantId: 'stale', fetchedAt: new Date('2026-08-01T06:00:00Z') }),
      ],
      ['good', 'stale'],
    );
    expect(variantsWithMissingData(perf, ['good', 'stale'], 36, NOW)).toEqual(['stale']);
  });
});
