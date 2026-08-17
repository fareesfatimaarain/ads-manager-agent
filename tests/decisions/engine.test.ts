import { describe, expect, it } from 'vitest';
import { decideCohort } from '../../src/decisions/engine.js';
import type { CohortInput, VariantDecision } from '../../src/decisions/types.js';
import { cohort, config, metrics, NOW, variant } from '../fixtures.js';

const find = (r: { decisions: readonly VariantDecision[] }, id: string): VariantDecision => {
  const d = r.decisions.find((x) => x.variantId === id);
  if (!d) throw new Error(`no decision for ${id}`);
  return d;
};

/**
 * Four-arm cohort with a genuine winner.
 *
 * v1:    120 conversions on 3000 clicks (4.00% CVR), $3000 spend => $25.00 CPA vs a $50 target.
 * v2-v4:  50 conversions on 3000 clicks (1.67% CVR), $3000 spend => $60.00 CPA, missing target.
 *
 * The magnitudes here are deliberately larger than a naive fixed-sample calculation would
 * require. Under an always-valid test, evidence that clears a one-shot p < 0.05 is nowhere
 * near enough to justify acting when you are looking every single day — a 3.4% vs 2.0% split
 * on 1000 clicks per arm carries an anytime-valid p of roughly 0.17, not 0.006. These numbers
 * represent a winner the engine should genuinely be willing to spend money on.
 */
function winnerCohort(over: Partial<CohortInput> = {}): CohortInput {
  const proxy = metrics({ impressions: 150_000, clicks: 3_000 });
  const mk = (id: string, conversions: number) =>
    variant({
      variantId: id,
      adSetId: `as-${id}`,
      platformAdId: `ad-${id}`,
      settled: metrics({ impressions: 150_000, clicks: 3_000, spendCents: 300_000, conversions }),
      proxy,
    });
  return cohort({
    variants: [mk('v1', 120), mk('v2', 50), mk('v3', 50), mk('v4', 50)],
    ...over,
  });
}

describe('evidence floors — nothing is decided before there is evidence', () => {
  it('takes no action before the minimum runtime has elapsed', () => {
    const r = decideCohort(
      cohort({
        variants: [
          variant({
            testStartedAt: new Date(NOW.getTime() - 24 * 3_600_000),
            settled: metrics({ clicks: 1_000, spendCents: 100_000, conversions: 40 }),
          }),
        ],
      }),
    );
    const d = find(r, 'v1');
    expect(d.kind).toBe('NO_ACTION');
    expect(d.reasonCode).toBe('INSUFFICIENT_RUNTIME');
  });

  it('takes no action before the minimum spend floor is met', () => {
    const r = decideCohort(
      cohort({
        variants: [variant({ settled: metrics({ spendCents: 1_000, clicks: 50, conversions: 1 }) })],
      }),
    );
    const d = find(r, 'v1');
    expect(d.kind).toBe('NO_ACTION');
    expect(d.reasonCode).toBe('INSUFFICIENT_SPEND');
  });

  it('applies the larger of the absolute and CPA-multiple spend floors', () => {
    // Target CPA $200 => multiple floor is $200, above the $50 absolute floor.
    const r = decideCohort(
      cohort({
        objective: { type: 'CPA', targetCpaCents: 20_000 },
        variants: [variant({ settled: metrics({ spendCents: 15_000, clicks: 200, conversions: 0 }) })],
      }),
    );
    expect(find(r, 'v1').reasonCode).toBe('INSUFFICIENT_SPEND');
  });
});

describe('partial data — a biased baseline is worse than no decision', () => {
  it('skips the entire cohort when any variant is missing data', () => {
    const r = decideCohort(winnerCohort({ variantsWithMissingData: ['v3'] }));
    expect(r.skipped).toBe(true);
    expect(r.decisions).toHaveLength(0);
    expect(r.skipReason).toMatch(/biased baseline/);
  });

  it('skips a cohort with no active variants', () => {
    const r = decideCohort(cohort({ variants: [] }));
    expect(r.skipped).toBe(true);
  });
});

describe('KILL — absolute rules', () => {
  it('kills on spend past the zero-conversion threshold', () => {
    // $110 spent, no conversions, against a 2x $50 = $100 threshold.
    const r = decideCohort(
      cohort({
        variants: [variant({ settled: metrics({ clicks: 300, spendCents: 11_000, conversions: 0 }) })],
      }),
    );
    const d = find(r, 'v1');
    expect(d.kind).toBe('KILL');
    expect(d.reasonCode).toBe('ZERO_CONVERSIONS_PAST_SPEND_THRESHOLD');
    expect(d.proposedAction?.type).toBe('KILL');
  });

  it('does not kill on zero conversions before the threshold', () => {
    const r = decideCohort(
      cohort({
        variants: [variant({ settled: metrics({ clicks: 300, spendCents: 9_000, conversions: 0 }) })],
      }),
    );
    expect(find(r, 'v1').kind).toBe('NO_ACTION');
  });

  it('uses the absolute cents threshold for ROAS clients, who have no target CPA', () => {
    const r = decideCohort(
      cohort({
        objective: { type: 'ROAS', targetRoas: 3 },
        variants: [variant({ settled: metrics({ clicks: 400, spendCents: 16_000, conversions: 0 }) })],
      }),
    );
    expect(find(r, 'v1').reasonCode).toBe('ZERO_CONVERSIONS_PAST_SPEND_THRESHOLD');
  });
});

describe('KILL — comparative rules', () => {
  it('kills a variant converting far worse than its cohort', () => {
    const r = decideCohort(
      cohort({
        variants: [
          variant({
            variantId: 'bad',
            settled: metrics({ clicks: 1_000, spendCents: 100_000, conversions: 5 }),
            proxy: metrics({ impressions: 50_000, clicks: 1_000 }),
          }),
          ...['g1', 'g2', 'g3'].map((id) =>
            variant({
              variantId: id,
              settled: metrics({ clicks: 1_000, spendCents: 100_000, conversions: 40 }),
              proxy: metrics({ impressions: 50_000, clicks: 1_000 }),
            }),
          ),
        ],
      }),
    );
    const d = find(r, 'bad');
    expect(d.kind).toBe('KILL');
    expect(d.reasonCode).toBe('COMPARATIVE_UNDERPERFORMANCE');
  });

  it('is reachable for a low-conversion loser — the floor sits on the baseline, not the variant', () => {
    // Regression guard: an earlier draft required the VARIANT to reach the 25-conversion
    // floor before it could be killed, which made this branch unreachable for exactly the
    // ads it exists to stop.
    const r = decideCohort(
      cohort({
        variants: [
          variant({
            variantId: 'bad',
            settled: metrics({ clicks: 1_000, spendCents: 100_000, conversions: 3 }),
            proxy: metrics({ impressions: 50_000, clicks: 1_000 }),
          }),
          ...['g1', 'g2', 'g3'].map((id) =>
            variant({
              variantId: id,
              settled: metrics({ clicks: 1_000, spendCents: 100_000, conversions: 45 }),
              proxy: metrics({ impressions: 50_000, clicks: 1_000 }),
            }),
          ),
        ],
      }),
    );
    const d = find(r, 'bad');
    expect(d.evidence.settled.conversions).toBeLessThan(config().minConversionsPerArm);
    expect(d.kind).toBe('KILL');
  });

  it('refuses a comparative kill when the baseline itself carries no signal', () => {
    // Everyone is quiet. Noise against noise is not evidence.
    const r = decideCohort(
      cohort({
        variants: [
          variant({
            variantId: 'a',
            settled: metrics({ clicks: 900, spendCents: 100_000, conversions: 1 }),
            proxy: metrics({ impressions: 50_000, clicks: 900 }),
          }),
          variant({
            variantId: 'b',
            settled: metrics({ clicks: 900, spendCents: 100_000, conversions: 8 }),
            proxy: metrics({ impressions: 50_000, clicks: 900 }),
          }),
        ],
      }),
    );
    expect(find(r, 'a').kind).not.toBe('KILL');
  });

  it('kills on a catastrophic click rate before conversion data exists', () => {
    const r = decideCohort(
      cohort({
        variants: [
          variant({
            variantId: 'dud',
            settled: metrics({ clicks: 25, spendCents: 8_000, conversions: 0 }),
            proxy: metrics({ impressions: 5_000, clicks: 25 }),
          }),
          ...['g1', 'g2', 'g3'].map((id) =>
            variant({
              variantId: id,
              settled: metrics({ clicks: 250, spendCents: 8_000, conversions: 40 }),
              proxy: metrics({ impressions: 5_000, clicks: 250 }),
            }),
          ),
        ],
      }),
    );
    const d = find(r, 'dud');
    expect(d.kind).toBe('KILL');
    expect(d.reasonCode).toBe('PROXY_CTR_UNDERPERFORMANCE');
  });

  it('will not proxy-kill on a statistically significant but commercially trivial CTR gap', () => {
    // Huge samples make a 10% relative gap significant; the 50% materiality floor blocks it.
    const r = decideCohort(
      cohort({
        variants: [
          variant({
            variantId: 'slightly-worse',
            settled: metrics({ clicks: 9_000, spendCents: 9_000, conversions: 0 }),
            proxy: metrics({ impressions: 500_000, clicks: 9_000 }),
          }),
          variant({
            variantId: 'g1',
            settled: metrics({ clicks: 10_000, spendCents: 9_000, conversions: 40 }),
            proxy: metrics({ impressions: 500_000, clicks: 10_000 }),
          }),
        ],
      }),
    );
    expect(find(r, 'slightly-worse').reasonCode).not.toBe('PROXY_CTR_UNDERPERFORMANCE');
  });
});

describe('KILL — the profitable-ad protection', () => {
  it('never comparatively kills a variant that is meeting its objective', () => {
    // v1 converts at 1.5% against a cohort at 5% — overwhelmingly "worse" — but its $40 CPA
    // still beats the $50 target. Killing it would be killing a profitable ad.
    const r = decideCohort(
      cohort({
        variants: [
          variant({
            variantId: 'profitable',
            settled: metrics({ clicks: 2_000, spendCents: 120_000, conversions: 30 }),
            proxy: metrics({ impressions: 100_000, clicks: 2_000 }),
          }),
          ...['g1', 'g2', 'g3'].map((id) =>
            variant({
              variantId: id,
              settled: metrics({ clicks: 2_000, spendCents: 120_000, conversions: 100 }),
              proxy: metrics({ impressions: 100_000, clicks: 2_000 }),
            }),
          ),
        ],
      }),
    );
    const d = find(r, 'profitable');
    expect(d.kind).toBe('NO_ACTION');
    expect(d.reasonCode).toBe('PROTECTED_MEETING_OBJECTIVE');
    expect(d.evidence.observedCpaCents!).toBeLessThan(5_000);
  });

  it('still kills a comparatively worse variant that is missing its objective', () => {
    const r = decideCohort(
      cohort({
        variants: [
          variant({
            variantId: 'unprofitable',
            settled: metrics({ clicks: 2_000, spendCents: 120_000, conversions: 15 }),
            proxy: metrics({ impressions: 100_000, clicks: 2_000 }),
          }),
          ...['g1', 'g2', 'g3'].map((id) =>
            variant({
              variantId: id,
              settled: metrics({ clicks: 2_000, spendCents: 120_000, conversions: 100 }),
              proxy: metrics({ impressions: 100_000, clicks: 2_000 }),
            }),
          ),
        ],
      }),
    );
    expect(find(r, 'unprofitable').kind).toBe('KILL');
  });
});

describe('SCALE', () => {
  it('scales a clear winner by exactly the capped increment', () => {
    const r = decideCohort(winnerCohort());
    const d = find(r, 'v1');
    expect(d.kind).toBe('SCALE');
    expect(d.reasonCode).toBe('MEETS_OBJECTIVE_WITH_CONFIDENCE');
    expect(d.proposedAction).toMatchObject({
      type: 'SCALE',
      currentBudgetCents: 3_000,
      targetBudgetCents: 3_600, // +20%, never a lump jump
    });
  });

  it('never proposes an increase above the configured cap', () => {
    for (const pct of [5, 10, 20, 33.3]) {
      const r = decideCohort(winnerCohort({ config: config({ maxBudgetIncreasePct: pct }) }));
      const a = find(r, 'v1').proposedAction;
      if (a?.type !== 'SCALE') continue;
      const actualPct = ((a.targetBudgetCents - a.currentBudgetCents) / a.currentBudgetCents) * 100;
      expect(actualPct).toBeLessThanOrEqual(pct + 1e-9);
    }
  });

  it('refuses to scale when observed CPA beats target but confidence does not', () => {
    // 25 conversions at $1240 spend => $49.60 observed CPA, just under a $50 target. The
    // posterior says only ~54% confidence the TRUE CPA beats target. Not enough to spend on.
    const r = decideCohort(
      cohort({
        variants: [
          variant({
            settled: metrics({ clicks: 1_000, spendCents: 124_000, conversions: 25 }),
            proxy: metrics({ impressions: 50_000, clicks: 1_000 }),
          }),
        ],
      }),
    );
    const d = find(r, 'v1');
    expect(d.evidence.observedCpaCents!).toBeLessThan(5_000);
    expect(d.evidence.probabilityMeetsCpaTarget!).toBeLessThan(0.95);
    expect(d.kind).toBe('NO_ACTION');
    expect(d.reasonCode).toBe('NOT_SIGNIFICANT');
  });

  it('refuses to scale below the conversion floor however good the ratio looks', () => {
    const r = decideCohort(
      cohort({
        variants: [
          variant({
            settled: metrics({ clicks: 100, spendCents: 10_000, conversions: 10 }),
            proxy: metrics({ impressions: 5_000, clicks: 100 }),
          }),
        ],
      }),
    );
    const d = find(r, 'v1');
    expect(d.evidence.observedCpaCents).toBe(1_000); // $10 CPA vs a $50 target
    expect(d.kind).not.toBe('SCALE');
    expect(d.reasonCode).toBe('INSUFFICIENT_CONVERSIONS');
  });

  it('scales a lone variant on absolute evidence when configured to allow it', () => {
    const r = decideCohort(
      cohort({
        variants: [
          variant({
            settled: metrics({ clicks: 1_000, spendCents: 100_000, conversions: 40 }),
            proxy: metrics({ impressions: 50_000, clicks: 1_000 }),
          }),
        ],
      }),
    );
    const d = find(r, 'v1');
    expect(d.evidence.baselineArmCount).toBe(0);
    expect(d.kind).toBe('SCALE');
  });

  it('refuses a lone variant when comparative evidence is required', () => {
    const r = decideCohort(
      cohort({
        config: config({ allowScaleWithoutComparativeBaseline: false }),
        variants: [
          variant({
            settled: metrics({ clicks: 1_000, spendCents: 100_000, conversions: 40 }),
            proxy: metrics({ impressions: 50_000, clicks: 1_000 }),
          }),
        ],
      }),
    );
    const d = find(r, 'v1');
    expect(d.kind).toBe('NO_ACTION');
    expect(d.reasonCode).toBe('NO_COMPARATIVE_BASELINE');
  });

  it('reports no headroom rather than proposing an illegal budget', () => {
    const r = decideCohort(
      winnerCohort({
        headroom: {
          todayAutonomousIncreaseCents: 20_000, // daily cap fully consumed
          clientTotalDailyBudgetCents: 12_000,
          platformDailySpendCapCents: null,
        },
      }),
    );
    const d = find(r, 'v1');
    expect(d.kind).toBe('NO_ACTION');
    expect(d.reasonCode).toBe('NO_BUDGET_HEADROOM');
    expect(d.proposedAction).toBeNull();
  });

  it('clips the proposed increase to the remaining daily headroom', () => {
    const r = decideCohort(
      winnerCohort({
        headroom: {
          todayAutonomousIncreaseCents: 19_800, // only $2 of headroom left
          clientTotalDailyBudgetCents: 12_000,
          platformDailySpendCapCents: null,
        },
      }),
    );
    const a = find(r, 'v1').proposedAction;
    expect(a).toMatchObject({ type: 'SCALE', targetBudgetCents: 3_200 });
  });

  it('respects a platform daily spend cap when computing the target', () => {
    const r = decideCohort(
      winnerCohort({
        headroom: {
          todayAutonomousIncreaseCents: 0,
          clientTotalDailyBudgetCents: 12_000,
          platformDailySpendCapCents: 12_300,
        },
      }),
    );
    const a = find(r, 'v1').proposedAction;
    expect(a).toMatchObject({ type: 'SCALE', targetBudgetCents: 3_300 });
  });
});

describe('SCALE — ROAS objective', () => {
  const roasCohort = (v1Value: number) =>
    cohort({
      objective: { type: 'ROAS', targetRoas: 3 },
      variants: [
        variant({
          variantId: 'v1',
          settled: metrics({
            clicks: 3_000,
            spendCents: 300_000,
            conversions: 120,
            conversionValueCents: v1Value,
          }),
          proxy: metrics({ impressions: 150_000, clicks: 3_000 }),
        }),
        ...['g1', 'g2', 'g3'].map((id) =>
          variant({
            variantId: id,
            settled: metrics({
              clicks: 3_000,
              spendCents: 300_000,
              conversions: 50,
              conversionValueCents: 600_000,
            }),
            proxy: metrics({ impressions: 150_000, clicks: 3_000 }),
          }),
        ),
      ],
    });

  it('scales when ROAS clears the safety margin', () => {
    // $12,000 revenue on $3,000 spend = 4.0x, against a 3.3x requirement.
    const d = find(decideCohort(roasCohort(1_200_000)), 'v1');
    expect(d.evidence.observedRoas).toBe(4);
    expect(d.kind).toBe('SCALE');
  });

  it('refuses to scale when ROAS beats target but misses the safety margin', () => {
    const d = find(decideCohort(roasCohort(930_000)), 'v1'); // 3.1x vs a 3.3x requirement
    expect(d.kind).toBe('NO_ACTION');
    expect(d.reasonCode).toBe('NOT_SIGNIFICANT');
  });

  it('reports a bootstrapped lower bound rather than a bare threshold comparison', () => {
    const d = find(decideCohort(roasCohort(1_200_000)), 'v1');
    expect(d.evidence.probabilityMeetsCpaTarget).toBeNull();
    const bound = d.evidence.roasLowerBound!;
    expect(bound.valid).toBe(true);
    expect(bound.lowerBound!).toBeLessThanOrEqual(bound.pointEstimate!);
  });

  it('refuses to scale when day-to-day variation leaves the bound below target', () => {
    // Average of 4.0x, but produced almost entirely by one enormous day. The point estimate
    // clears the margin; the lower bound does not, and the lower bound wins.
    const spiky = cohort({
      objective: { type: 'ROAS', targetRoas: 3 },
      variants: [
        variant({
          variantId: 'v1',
          settled: metrics({
            clicks: 1_000,
            spendCents: 100_000,
            conversions: 34,
            conversionValueCents: 400_000,
          }),
          proxy: metrics({ impressions: 50_000, clicks: 1_000 }),
          settledDaily: [
            { statDate: '2026-07-29', spendCents: 20_000, conversionValueCents: 0, conversions: 2 },
            { statDate: '2026-07-30', spendCents: 20_000, conversionValueCents: 0, conversions: 2 },
            { statDate: '2026-07-31', spendCents: 20_000, conversionValueCents: 0, conversions: 2 },
            { statDate: '2026-08-01', spendCents: 20_000, conversionValueCents: 0, conversions: 2 },
            { statDate: '2026-08-02', spendCents: 20_000, conversionValueCents: 400_000, conversions: 26 },
          ],
        }),
        ...['g1', 'g2', 'g3'].map((id) =>
          variant({
            variantId: id,
            settled: metrics({
              clicks: 1_000,
              spendCents: 100_000,
              conversions: 20,
              conversionValueCents: 200_000,
            }),
            proxy: metrics({ impressions: 50_000, clicks: 1_000 }),
          }),
        ),
      ],
    });
    const d = find(decideCohort(spiky), 'v1');
    expect(d.evidence.observedRoas).toBe(4);
    expect(d.evidence.roasLowerBound!.lowerBound!).toBeLessThan(3);
    expect(d.kind).toBe('NO_ACTION');
  });

  it('withholds scaling when there are too few settled days to bound the ratio', () => {
    const thin = cohort({
      objective: { type: 'ROAS', targetRoas: 3 },
      variants: [
        variant({
          variantId: 'v1',
          settled: metrics({
            clicks: 1_000,
            spendCents: 100_000,
            conversions: 34,
            conversionValueCents: 400_000,
          }),
          proxy: metrics({ impressions: 50_000, clicks: 1_000 }),
          settledDaily: [
            { statDate: '2026-08-01', spendCents: 50_000, conversionValueCents: 200_000, conversions: 17 },
            { statDate: '2026-08-02', spendCents: 50_000, conversionValueCents: 200_000, conversions: 17 },
          ],
        }),
        ...['g1', 'g2', 'g3'].map((id) =>
          variant({
            variantId: id,
            settled: metrics({
              clicks: 1_000,
              spendCents: 100_000,
              conversions: 20,
              conversionValueCents: 200_000,
            }),
            proxy: metrics({ impressions: 50_000, clicks: 1_000 }),
          }),
        ),
      ],
    });
    const d = find(decideCohort(thin), 'v1');
    expect(d.kind).toBe('NO_ACTION');
    expect(d.evidence.roasLowerBound!.invalidReason).toBe('TOO_FEW_DAYS');
    expect(d.evidence.notes.join(' ')).toMatch(/confidence bound unavailable/);
  });
});

describe('MUTATE', () => {
  const nearWinner = (mutationDepth = 0) =>
    cohort({
      variants: [
        variant({
          variantId: 'near',
          mutationDepth,
          settled: metrics({ clicks: 1_000, spendCents: 125_000, conversions: 20 }),
          proxy: metrics({ impressions: 50_000, clicks: 1_000 }),
        }),
        variant({
          variantId: 'peer',
          settled: metrics({ clicks: 1_000, spendCents: 125_000, conversions: 22 }),
          proxy: metrics({ impressions: 50_000, clicks: 1_000 }),
        }),
      ],
    });

  it('mutates a near-winner rather than killing it', () => {
    // $62.50 CPA sits inside the (target, target x 1.5] = ($50, $75] band.
    const d = find(decideCohort(nearWinner()), 'near');
    expect(d.kind).toBe('MUTATE');
    expect(d.reasonCode).toBe('NEAR_WINNER_WORTH_MUTATING');
  });

  it('changes exactly one variable', () => {
    const a = find(decideCohort(nearWinner()), 'near').proposedAction;
    expect(a?.type).toBe('MUTATE');
    if (a?.type === 'MUTATE') {
      expect(['HEADLINE', 'PRIMARY_TEXT', 'CTA', 'IMAGE']).toContain(a.mutatedField);
    }
  });

  it('stops mutating once the depth limit is reached', () => {
    const d = find(decideCohort(nearWinner(2)), 'near');
    expect(d.kind).not.toBe('MUTATE');
  });

  it('does not mutate a variant far outside the near-winner band', () => {
    const r = decideCohort(
      cohort({
        variants: [
          variant({
            variantId: 'far',
            settled: metrics({ clicks: 1_000, spendCents: 300_000, conversions: 20 }),
            proxy: metrics({ impressions: 50_000, clicks: 1_000 }),
          }),
          variant({
            variantId: 'peer',
            settled: metrics({ clicks: 1_000, spendCents: 125_000, conversions: 22 }),
            proxy: metrics({ impressions: 50_000, clicks: 1_000 }),
          }),
        ],
      }),
    );
    expect(find(r, 'far').kind).not.toBe('MUTATE');
  });
});

describe('statistical corrections are actually applied', () => {
  it('reports a BH-adjusted p-value above the raw one for a multi-arm cohort', () => {
    // Anytime-validity covers repeated looks at one hypothesis; BH covers testing several
    // variants at once. Both are needed, and both must be visible in the record.
    const d = find(decideCohort(winnerCohort()), 'v1');
    expect(d.evidence.outcomeTest.better.rawP).not.toBeNull();
    expect(d.evidence.outcomeTest.better.bhAdjustedP!).toBeGreaterThan(
      d.evidence.outcomeTest.better.rawP!,
    );
  });

  it('records both tails of the outcome test, with their differing thresholds', () => {
    const d = find(decideCohort(winnerCohort()), 'v1');
    // Scale is held to 0.05, kill to 0.10. Both must be legible in the audit record.
    expect(d.evidence.outcomeTest.better.threshold).toBeCloseTo(0.05, 9);
    expect(d.evidence.outcomeTest.worse.threshold).toBeCloseTo(0.1, 9);
  });

  it('decides on the always-valid p-value, not the fixed-sample one', () => {
    const d = find(decideCohort(winnerCohort()), 'v1');
    const t = d.evidence.outcomeTest.better;
    // Both are recorded, but only one is carried forward into the threshold comparison.
    expect(t.fixedSampleP).not.toBeNull();
    expect(t.alwaysValid!.valid).toBe(true);
    expect(t.rawP).toBe(t.alwaysValid!.pValue);
    // (The "always-valid is the more conservative of the two" property is asserted in
    // alwaysValid.test.ts, at magnitudes where neither figure hits its reporting floor —
    // this cohort is emphatic enough that both clamp, which would mask the comparison.)
  });

  it('is unaffected by how many times the variant has already been evaluated', () => {
    // The whole reason for the always-valid test: daily evaluation cannot erode the guarantee,
    // so a winner on look 1 is still a winner on look 40 given the same evidence.
    const base = find(decideCohort(winnerCohort()), 'v1');
    expect(base.kind).toBe('SCALE');

    const later = decideCohort(
      winnerCohort({
        variants: winnerCohort().variants.map((v) =>
          v.variantId === 'v1' ? { ...v, evaluationsOutcome: 39, evaluationsProxy: 39 } : v,
        ),
      }),
    );
    const d = find(later, 'v1');
    expect(d.kind).toBe('SCALE');
    expect(d.evidence.outcomeTest.better.rawP).toBeCloseTo(
      base.evidence.outcomeTest.better.rawP!,
      12,
    );
  });

  it('only counts an evaluation when a valid test statistic was produced', () => {
    // Single-arm cohort: no comparative test exists, so nothing is counted.
    const r = decideCohort(
      cohort({
        variants: [
          variant({ settled: metrics({ clicks: 1_000, spendCents: 100_000, conversions: 40 }) }),
        ],
      }),
    );
    const d = find(r, 'v1');
    expect(d.newEvaluationsProxy).toBe(0);
    expect(d.newEvaluationsOutcome).toBe(0);
  });

  it('increments the audit counter when a valid test ran', () => {
    const d = find(decideCohort(winnerCohort()), 'v1');
    expect(d.newEvaluationsOutcome).toBe(1);
  });
});

describe('structural invariants', () => {
  it('never returns a proposed action on a NO_ACTION decision', () => {
    const inputs = [winnerCohort(), cohort({ variants: [variant()] })];
    for (const input of inputs) {
      for (const d of decideCohort(input).decisions) {
        if (d.kind === 'NO_ACTION') expect(d.proposedAction).toBeNull();
      }
    }
  });

  it('always returns a proposed action on an actionable decision', () => {
    for (const d of decideCohort(winnerCohort()).decisions) {
      if (d.kind !== 'NO_ACTION') {
        expect(d.proposedAction).not.toBeNull();
        expect(d.proposedAction!.type).toBe(d.kind);
      }
    }
  });

  it('gives every decision a human-readable summary with no placeholder text', () => {
    for (const d of decideCohort(winnerCohort()).decisions) {
      expect(d.humanSummary.length).toBeGreaterThan(10);
      expect(d.humanSummary).not.toMatch(/undefined|NaN|\[object/);
    }
  });

  it('produces byte-identical results across repeated runs', () => {
    const a = JSON.stringify(decideCohort(winnerCohort()));
    const b = JSON.stringify(decideCohort(winnerCohort()));
    expect(a).toBe(b);
  });

  it('never proposes a non-integer or negative budget', () => {
    for (const d of decideCohort(winnerCohort()).decisions) {
      const a = d.proposedAction;
      if (a?.type === 'SCALE') {
        expect(Number.isInteger(a.targetBudgetCents)).toBe(true);
        expect(a.targetBudgetCents).toBeGreaterThan(0);
      }
      if (a?.type === 'MUTATE') {
        expect(Number.isInteger(a.newAdSetBudgetCents)).toBe(true);
        expect(a.newAdSetBudgetCents).toBeGreaterThan(0);
      }
    }
  });
});
