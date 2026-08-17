import { describe, expect, it } from 'vitest';
import {
  GuardrailConfigError,
  assertCoherent,
  parseGuardrailConfig,
} from '../../src/guardrails/config.js';
import { config } from '../fixtures.js';

/** A row shaped the way node-postgres actually returns it: numerics as strings. */
function row(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'gc-1',
    clientId: 'client-1',
    version: 1,
    maxBudgetIncreasePct: '20.00',
    maxBudgetDecreasePct: '50.00',
    maxDailyAutonomousIncreaseCents: 20_000,
    maxTotalDailyBudgetCents: 100_000,
    minAdSetDailyBudgetCents: 500,
    maxAdSetDailyBudgetCents: 50_000,
    minRuntimeHours: 72,
    minSpendMultipleOfTargetCpa: '1.00',
    minConversionsPerArm: 25,
    minTestSpendCents: 5_000,
    zeroConversionKillSpendCents: 15_000,
    killPThreshold: '0.1000',
    scalePThreshold: '0.0500',
    proxyKillMinImpressions: 3_000,
    proxyKillCtrDropPct: '50.00',
    zeroConversionKillSpendMultiple: '2.00',
    roasScaleSafetyMargin: '1.100',
    roasBootstrapMinDays: 5,
    roasBootstrapIterations: 2_000,
    mSprtTauRelative: '0.500',
    mutateCpaBandMultiple: '1.50',
    maxMutationDepth: 2,
    mutateTestBudgetCents: 3_000,
    allowScaleWithoutComparativeBaseline: true,
    actionCooldownHours: 24,
    maxActionsPerCyclePerClient: 10,
    minActiveCampaigns: 1,
    allowTargetingChanges: false,
    allowAudienceExpansion: false,
    allowCampaignCreation: false,
    attributionSettlingHours: 72,
    maxPerformanceStalenessHours: 36,
    approvalExpiryHours: 48,
    ...over,
  };
}

describe('parseGuardrailConfig — the string/number boundary', () => {
  it('converts numeric-column strings into real numbers', () => {
    const cfg = parseGuardrailConfig(row());
    expect(cfg.maxBudgetIncreasePct).toBe(20);
    expect(typeof cfg.maxBudgetIncreasePct).toBe('number');
    expect(cfg.killPThreshold).toBe(0.1);
    expect(cfg.scalePThreshold).toBe(0.05);
  });

  it('produces a config that behaves correctly under addition', () => {
    // The specific landmine: an unparsed "20" would make this "205" rather than 25.
    const cfg = parseGuardrailConfig(row());
    expect(cfg.maxBudgetIncreasePct + 5).toBe(25);
  });

  it('matches the fixture config used throughout the test suite', () => {
    expect(parseGuardrailConfig(row())).toEqual(config());
  });

  it('rejects a missing field rather than defaulting it', () => {
    expect(() => parseGuardrailConfig(row({ maxBudgetIncreasePct: null }))).toThrow(
      GuardrailConfigError,
    );
    expect(() => parseGuardrailConfig(row({ minConversionsPerArm: undefined }))).toThrow(
      GuardrailConfigError,
    );
  });

  it('rejects a non-numeric string instead of yielding NaN', () => {
    expect(() => parseGuardrailConfig(row({ maxBudgetIncreasePct: 'twenty' }))).toThrow(
      /not a finite number/,
    );
  });

  it('rejects booleans and objects that would otherwise coerce', () => {
    // Number(true) is 1, Number([]) is 0 — both plausible-looking limits.
    expect(() => parseGuardrailConfig(row({ maxBudgetIncreasePct: true }))).toThrow(
      /must be a number/,
    );
    expect(() => parseGuardrailConfig(row({ maxBudgetIncreasePct: [] }))).toThrow(
      /must be a number/,
    );
  });

  it('rejects out-of-range values', () => {
    expect(() => parseGuardrailConfig(row({ maxBudgetIncreasePct: '150' }))).toThrow(
      /outside the permitted range/,
    );
    expect(() => parseGuardrailConfig(row({ killPThreshold: '0.6' }))).toThrow(
      /outside the permitted range/,
    );
  });

  it('rejects a non-integer cent amount', () => {
    expect(() => parseGuardrailConfig(row({ minTestSpendCents: 5_000.5 }))).toThrow(
      /must be an integer/,
    );
  });

  it('names the offending field in the error', () => {
    try {
      parseGuardrailConfig(row({ proxyKillMinImpressions: 10 }));
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(GuardrailConfigError);
      expect((e as GuardrailConfigError).field).toBe('proxyKillMinImpressions');
    }
  });
});

describe('assertCoherent — jointly nonsensical combinations', () => {
  it('rejects an ad set ceiling below its floor', () => {
    expect(() =>
      assertCoherent(config({ minAdSetDailyBudgetCents: 10_000, maxAdSetDailyBudgetCents: 5_000 })),
    ).toThrow(/below its floor/);
  });

  it('rejects an ad set ceiling above the client total ceiling', () => {
    expect(() =>
      assertCoherent(
        config({ maxAdSetDailyBudgetCents: 200_000, maxTotalDailyBudgetCents: 100_000 }),
      ),
    ).toThrow(/more than the client total ceiling/);
  });

  it('rejects a scale threshold looser than the kill threshold', () => {
    expect(() => assertCoherent(config({ scalePThreshold: 0.15, killPThreshold: 0.1 }))).toThrow(
      /stricter threshold than kill/,
    );
  });

  it('rejects a mutant budget that could never fit the daily cap', () => {
    expect(() =>
      assertCoherent(
        config({ mutateTestBudgetCents: 30_000, maxDailyAutonomousIncreaseCents: 20_000 }),
      ),
    ).toThrow(/no mutation could ever execute/);
  });

  it('rejects a mutant budget below the ad set floor', () => {
    expect(() =>
      assertCoherent(config({ mutateTestBudgetCents: 100, minAdSetDailyBudgetCents: 500 })),
    ).toThrow(/every mutation would be blocked/);
  });

  it('accepts the default preset', () => {
    expect(() => assertCoherent(config())).not.toThrow();
  });
});
