# AI Ad Manager

Autonomous ad creative generation, structured testing, and guardrailed scale/kill/mutate
decisions. Platform-agnostic behind an adapter layer.

See [PLAN.md](PLAN.md) for the design rationale, the statistical approach, and the current
state of each build stage.

## Running it locally

Requires Docker (Postgres + Redis) and Node 22+.

```bash
npm install
npm run db:up        # postgres on :5433, redis on :6380
npm run db:migrate   # apply schema
npm run seed         # populate a worked example
npm start            # build the dashboard and serve it
```

Then open **http://localhost:3000**

`npm start` is `web:build` followed by `serve`. For UI work, run `npm run serve` in one
terminal and `npm run web:dev` in another, then use http://localhost:5173 — Vite proxies
`/api` through to the API server and gives you hot reload.

## The seeded example

`npm run seed` is not fixture data. It generates 60 days of performance through the
deterministic mock adapter, then runs the **real** decision engine and executor over it. What
the dashboard shows is genuinely what the system concluded — change the engine and the demo
changes with it.

The example produces one of each outcome: a clear winner queued for approval, and three ads
stopped autonomously for different reasons (one on click-through rate, two on conversion
performance). The never-empty-a-campaign guardrail stops the last kill, leaving one ad running.

## Tests

```bash
npm test              # 262 unit tests, no infrastructure needed
npm run test:integration   # 37 tests against real Postgres (needs db:up)
npm run test:all
npm run typecheck     # backend
npx tsc -p tsconfig.web.json --noEmit   # dashboard
```

## Running it autonomously

```bash
npm run scheduler     # ingestion every 3h, decision cycle daily at 06:00
```

The scheduler reconciles any action interrupted by a previous shutdown before it starts, so a
crash mid-action is resolved against the platform rather than guessed at. The same cycle can be
triggered by hand from **Operations → Run now** — it is the same code path with the same
limits; only the timing changes.

`EXECUTION_ENABLED=false` halts all execution at the deployment level. It is deliberately not
changeable from the dashboard: a global stop should require access to the deployment, not a
misplaced click. Per-client pausing *is* in the UI.

## The dashboard

| Tab | What it is for |
|---|---|
| Live position | What is running, what it costs, against target |
| Creative | Every ad grouped by the *argument* it tests, with a verdict per angle |
| Decision history | Every action in plain language, expandable to evidence and all guardrail checks |
| Awaiting you | Budget increases queued for approval |
| Operations | Account health, spend headroom, dead letters, manual run controls |
| Settings | Every limit, editable, with the consequence of changing it stated |

## Layout

| Path | What lives there |
|---|---|
| `src/stats/` | Significance math — always-valid sequential tests, Gamma/Poisson CPA bounds, BH correction, bootstrap |
| `src/guardrails/` | Hard limits, checked in code at the point of execution |
| `src/decisions/` | The deterministic decision engine and the executor |
| `src/platform/` | `PlatformAdapter` contract, deterministic mock, retry/circuit-breaker |
| `src/performance/` | Append-only snapshot reader with the attribution settling window |
| `src/time/` | Timezone-aware stat-date arithmetic |
| `src/api/` | Reporting API and approval endpoints |
| `web/` | React dashboard |
| `report/` | Client-facing PDF briefing and its build script |

## Safety properties

These are enforced structurally, not by convention, and each is covered by a test:

- No autonomous action bypasses the guardrail check — it runs inside the same transaction that
  writes the decision, against state re-read under a per-client advisory lock.
- Every action is written to `decisions_log` **before** it executes. If the write fails, the
  action does not happen.
- Budget updates are absolute, never deltas, and carry an idempotency key — so a retry after a
  lost response cannot spend twice.
- Decisions are never made on statistically insufficient data, and never on unsettled
  conversion figures.
- No plaintext credentials: tokens are AES-256-GCM encrypted at rest and never leave the
  adapter layer.
