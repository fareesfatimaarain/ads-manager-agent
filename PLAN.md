# AI Ad Manager — Build Plan

## Decisions locked (from clarifying round)

| Question | Answer |
|---|---|
| Autonomy | **Tiered** — kill/pause auto-execute; scale + budget increase require human approval; mutate auto-executes at test budget |
| Objective | **Per-client CPA or ROAS**, declared in config, resolvable per campaign |
| Significance | **Balanced two-tier** — proxy (CTR) can kill at p<0.10; only conversion data at p<0.05 can scale |
| Performance data | **Append-only snapshots + 72h attribution settling window** |

## Statistical approach (revised)

The first cut used **Pocock alpha spending** for repeated looks. That has been **replaced with
an always-valid mSPRT**, because Pocock's guarantee assumes the number of looks `K` is fixed in
advance and evenly spaced in information. Neither holds here — a variant's look count grows for
as long as it runs, and the engine cannot know at the outset how many times it will evaluate.
Feeding a growing `K` into a fixed-`K` formula produces a number that looks principled and is
not.

The mSPRT makes no such assumption: under the null the mixture likelihood ratio is a
non-negative martingale, so by Ville's inequality `P(∃n : p_n ≤ α) ≤ α` over the *entire*
sequence of looks. The engine may evaluate as often as it likes. The look count is now an audit
fact only, not a statistical input.

Consequence, measured: evidence that clears a one-shot `p < 0.05` is nowhere near sufficient
when you look daily. A 3.4% vs 2.0% conversion split on 1,000 clicks per arm carries a
fixed-sample p of 0.006 but an anytime-valid p of **0.17**. The engine now demands materially
more evidence before spending — which is the correct direction for the error we cannot afford.

**ROAS now gets a real confidence bound.** Revenue is compound Poisson and daily aggregates
cannot support a parametric interval, so rather than assert a figure the data does not carry,
the engine bootstraps whole days (seeded from the variant id, so it is reproducible) and
requires the one-sided lower bound to clear target. This catches the case a bare average
misses: an average of 4.0x ROAS built almost entirely from one enormous day yields a lower
bound under 1.0x, and is refused.

## Two problems I found that were not in the spec

Both are silent, systematic, and cost money. I am building the fixes in rather than
asking, because neither has a defensible "no" — but flagging loudly since they change
how often the engine acts.

### 1. Multiple comparisons

Testing 8 variants against the field, each at p<0.05, gives a family-wise false
positive rate of `1 - 0.95^8 ≈ 34%`, not 5%. Roughly one in three test cohorts would
produce a spurious "winner" that then gets scaled with real money.

**Fix:** Benjamini–Hochberg FDR correction across all variants evaluated in one cycle
within one test cohort. Raw and adjusted p-values both logged.

### 2. Peeking / repeated significance testing

The engine evaluates daily. Testing the same hypothesis every day at a fixed p<0.05
inflates the true error rate badly — over 30 daily looks, the chance of crossing p<0.05
at least once by chance approaches ~25-40% even when variants are identical. A daily
cron that scales the first thing to cross 0.05 is, in effect, a machine for finding noise.

**Fix:** an always-valid mSPRT — see "Statistical approach (revised)" above. A simulation of
300 runs × 60 looks at two genuinely identical arms is part of the test suite and asserts the
false-positive rate stays near the nominal 5%, rather than the 25-40% an uncorrected daily
gate produces.

Net effect: the engine acts **less** often than the preset preview suggested. That is the
correct direction for the error we can't afford.

## Assumptions I am making — correct any of these

1. **ORM: Drizzle.** Chosen over Prisma because the spend ledger needs `SELECT … FOR UPDATE`
   row locking for atomic check-and-reserve, and Drizzle expresses that natively without
   dropping to `$queryRaw` and losing type safety.

2. **One variant per ad set (ABO), not multiple ads in a shared ad set.** This is a
   statistical necessity, not a convenience: Meta's delivery optimizer allocates impressions
   non-randomly toward what it predicts will win. Variants sharing an ad set are therefore
   not randomly assigned, which violates the independence assumption underneath every
   z-test in this system. Shared-ad-set tests would produce confident, wrong answers.

3. **Comparative baseline = pooled performance of all *other* variants in the same test
   cohort.** There is no designated control ad. Consequence: **a single-variant test cannot
   use any comparative test** — only absolute rules apply (zero-conversion spend kill,
   CPA-vs-target). Handled explicitly rather than silently returning garbage.

4. **ROAS significance is weaker than CPA significance and I will not pretend otherwise.**
   CPA gets a proper Gamma/Poisson posterior bound on true CPA. Revenue is compound Poisson
   (count × value); with only daily aggregates we cannot estimate per-conversion value
   variance, so ROAS decisions gate on *conversion-count* significance plus a deterministic
   `observed ROAS ≥ target × margin` check. The confidence figure logged for ROAS clients
   refers to the conversion-rate test only. If per-conversion value data becomes available,
   this can be upgraded to a real bound.

5. **Currency:** guardrail spend caps are denominated in the ad account's own currency. No FX
   conversion. A client whose accounts span multiple currencies cannot have a single
   client-level cap in v1 — the engine will refuse to enforce and escalate instead of
   guessing a conversion rate.

6. **Timezone:** stat dates are in the ad account's timezone (matching how Meta reports).
   Settling is computed as `end_of_day(stat_date, account_tz) + settling_hours`.

7. **Mutation lineage:** a mutant is a new `ad_variant` row with `parent_variant_id` and
   `mutated_field` ∈ {HEADLINE, PRIMARY_TEXT, CTA, IMAGE}. Exactly one field changes. The
   parent keeps running (it's a near-winner, not a loser) until it independently hits kill
   criteria. Mutant launches at test budget and starts its own significance clock.

8. **Approval staleness:** a pending scale approval expires after 48h. A human approving a
   4-day-old recommendation would be executing on data the engine no longer stands behind,
   so expired decisions must be re-evaluated, not approved.

9. **"Never pause the client's only active campaign":** active = status ACTIVE with ≥1 active
   ad set with ≥1 active ad. If a kill would drop the client to zero active campaigns, the
   action is blocked and escalated to a human — the engine never makes that call alone.

10. **Cadence:** performance ingestion every 3h; decision cycle once daily per client. With a
    72h settling window, higher decision frequency only adds looks (tightening alpha) without
    adding information.

11. **Image provider:** Ideogram concretely (strongest at legible in-image text, which ad
    creative needs), behind `CreativeProvider`. A deterministic mock provider backs all tests
    so the suite runs with no API keys and no spend.

## Failure modes I am designing against

| Failure | Consequence if unhandled | Mitigation |
|---|---|---|
| Retry after timeout on a budget increase | Budget raised twice — real overspend | Idempotency key persisted before call; reconcile against platform state before any retry |
| `decisions_log` write succeeds, execution crashes | Logged action never happened — audit trail lies | Status machine: PENDING → EXECUTING → EXECUTED/FAILED; orphaned EXECUTING rows reconciled on startup |
| Execution succeeds, status write fails | Action invisible to guardrails; next cycle may repeat it | Idempotency key checked against platform before re-execution |
| Partial performance data (some variants fetched, some failed) | Cohort baseline computed from a biased subset | Cohort evaluation is all-or-nothing; any missing variant skips the whole cohort for that cycle |
| Stale data mistaken for fresh | Decisions on numbers that stopped updating | Every snapshot carries `fetched_at`; staleness check before evaluation |
| Guardrail config edited mid-cycle | Decision evaluated under one config, executed under another | Configs are append-only versioned; `decisions_log` pins `guardrail_config_id` |
| Concurrent decision cycles for one client | Two cycles each approve an increase inside the daily cap; together they exceed it | Advisory lock per client per cycle + `SELECT … FOR UPDATE` on the spend ledger |
| Float arithmetic on money | Rounding drift in spend caps | All money is integer minor units (cents). No floats anywhere in the money path |
| Zero-denominator stats (0 clicks, 0 impressions) | NaN p-value read as "significant" | Explicit guards return INCONCLUSIVE; NaN can never satisfy a threshold |
| Normal approximation invalid at small n | Bogus p-value from the z-test | Expected-successes ≥5 per arm precondition; fails → INCONCLUSIVE, not a number |

## Build order & status

- [x] **1.** DB schema + migrations — 13 tables, applied to Postgres 16, 14 CHECK constraints verified live
- [x] **2.** `PlatformAdapter` interface + deterministic mock adapter (attribution lag, failure injection)
- [x] **3a.** Statistics core — 76 tests against closed forms and hand-computed values
- [x] **3b.** Guardrail engine + config parsing — 52 tests
- [x] **3c.** Decision engine — always-valid tests + bootstrapped ROAS bound
- [x] **3d.** Timezone-aware settling window + performance reader
- [x] **3e.** Execution path: log-before-execute, idempotency, transactional spend ledger
- [x] **3f.** Retry / backoff / circuit breaker / dead-letter queue
- [x] **3g.** Integration suite against real Postgres (constraints + executor)
- [ ] 4. Creative generation engine
- [ ] 5. Scheduler / queue wiring (cron → BullMQ → executor)
- [ ] 6. Reporting API
- [ ] 7. React dashboard
- [ ] 8. Meta adapter against the sandbox

**299 tests passing** — 262 unit (`npm test`), 37 integration (`npm run test:integration`,
needs `npm run db:up`).

### Verified, not assumed
- Significance math checked against closed forms (`P(1,x) = 1-e^-x`, `P(½,x) = erf(√x)`,
  factorial identities) and hand-computed z/p values, not just self-consistency.
- Anytime-validity demonstrated by simulation, not asserted.
- BH demonstrably bites: p=0.03 passes a naive gate and is refused after correction across
  8 arms.
- The 14 DB CHECK constraints are proven to *reject bad rows*, against a live database —
  previously they were only proven to exist.
- Double-spend guarantee proven end to end: a budget change whose response is lost is applied
  exactly once, verified by both the adapter's own counter and the resulting budget.
- Ordering guarantee proven: when every platform attempt fails, a complete `decisions_log`
  record with evidence and reasoning still exists.

### Remaining gaps, stated plainly
- **Meta adapter is not written.** Only the interface and the mock exist. This is deliberate
  sequencing — the core is proven first so that debugging Meta means debugging one adapter.
- **MUTATE execution is not wired.** It needs the creative pipeline (step 4); the executor
  throws explicitly rather than pretending to handle it.
- **No cron/queue wiring yet**, so nothing runs on a schedule. Everything is invoked directly.
- **`tau` for the mSPRT is a judgement call** (0.5 × pooled rate). It affects sensitivity only,
  never validity, but the default is reasoned rather than derived from your data.
- **The ROAS bootstrap is coarse below ~10 settled days.** It fails toward refusing to scale.
