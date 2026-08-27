# M0 handoff — partial

**Status: T0.1 → T0.4 complete and committed. T0.5, T0.6, T0.7 not started.**
Session stopped at the founder's request after T0.4. M0's exit gate (T0.7) has
not run, so **M0 is not complete** and no wave-1 lane should start against it yet.

Branch: `main`, four commits, one per card. Repo was `git init`-ed at session start.

---

## What exists now

A pnpm monorepo with the constitution's package layout, a Next.js app that
builds, Postgres 16 with schema wave 1 applied, and a worker runtime that is
effectively-once. **181 tests pass**; lint, typecheck and build are clean.

Concretely, the enforcement layer M0 exists to build first is in place:

- A threshold number cannot be written outside `packages/rules` without lint
  failing, and CI proves that by planting a violation on every run.
- `packages/core` cannot import Next, React or a provider SDK — a test proves it.
- A repository call without an account scope does not compile.
- Duplicate domains, webhook ids, Stripe events and notification triples all
  conflict at the database level, not in application code.
- A worker that is killed mid-step resumes at its checkpoint; re-running
  completed work returns the stored output without executing.

---

## Done-when evidence, per card

### T0.1 — Repo skeleton, package boundaries, lint, CI · `9fd5854`

| Check | Result |
|---|---|
| `pnpm lint` fails on a planted raw SDK import | **PASS** — `pnpm lint:prove`: `PASS lint rejects raw @anthropic-ai/sdk import outside packages/llm (invariant 25)` |
| `pnpm lint` fails on a planted `if (position < 15)` outside rules | **PASS** — `PASS lint rejects threshold literal outside packages/rules (invariant 9)` |
| Boundary test passes | **PASS** — `packages/core/src/boundaries.test.ts`, 4 tests |
| CI green on an empty app | **PASS locally** — every step of `.github/workflows/ci.yml` run by hand: lint, `env:check`, `lint:prove`, typecheck, test, build. GitHub Actions has never run: no remote is configured. |
| `railway.toml` deploys `app` + `postgres` to a throwaway environment | **PARKED** — see below |

**Parked:** the Railway deploy. Railway is authenticated in-session as the
founder, but deploying creates billable infrastructure on their account. Asked;
answer was to leave it parked. `railway.toml` is written and committed
(`app` service, memory pinned to 384 MB per tech §2.1, healthcheck on
`/api/health`, `sleepApplication = false`, one replica). The `postgres` service
is template-provisioned — Railway cannot declare database services in repo
config. **Nothing downstream depends on this**; it needs a founder to authorise
the spend.

### T0.2 — Rules & config module · `1dbaf87`

| Check | Result |
|---|---|
| A test enumerates the spec's named thresholds and asserts each key exists | **PASS** — 100-row enumeration, each row citing its section |
| Invalid YAML fails startup | **PASS** — 5 cases: unparseable YAML, missing section, out-of-range value, unknown key, invalid locale override |
| `rules_version` changes when any value changes | **PASS** — asserted against `sha256` of the file bytes, and against a mutated copy |
| Snapshot of the loaded config committed | **PASS** — `packages/rules/snapshot/loaded-config.json`, the *resolved* defaults plus every resolved locale |

117 tests. Covers all 18 signals in the §7.3 catalog, the §7.6 confidence points
and clamps, §8.2 demand floors, §8.4 gate floors, all of §9.6, §10.2 and §14.5.

### T0.3 — Schema wave 1 + constraint tests · `4ac2d17` · **AUDIT REQUIRED**

| Check | Result |
|---|---|
| Duplicate domain conflicts | **PASS** |
| Duplicate webhook id conflicts | **PASS** |
| Duplicate Stripe event conflicts | **PASS** |
| Duplicate notification triple conflicts | **PASS** |
| A repository call without scope fails to compile | **PASS** — `packages/db/src/scope.test-d.ts`; clean `tsc` means every `@ts-expect-error` matched a real error |

21 constraint tests against Postgres 16.15. All 16 tables from the card's list.

### T0.4 — Worker runtime & step state machine · `776d4b5` · **AUDIT REQUIRED**

| Check | Result |
|---|---|
| Guard mismatch stops a second worker | **PASS** |
| Re-running a completed key returns stored output without executing | **PASS** |
| Two workers on one account serialise | **PASS** (and different accounts run in parallel) |
| A step crashed mid-checkpoint resumes at the cursor | **PASS** — pages 1–3 are not re-fetched |
| Retries follow 1m/5m/25m ±20% | **PASS** — 1500 samples in-band, plus both jitter extremes |
| DLQ entry carries step + key + error | **PASS** — plus attempts, checkpoint and replay context; one-action replay, double replay a no-op |
| SIGTERM drains | **PASS** — a real Graphile worker, signalled mid-job; the job completed (401 ms) and the queue emptied before exit 0 |

39 tests.

---

## Audit status

The build plan flags **T0.3, T0.4 and T0.5** for a fresh-session audit before
dependents start. T0.3 and T0.4 are done and **both need that audit**; T0.5 was
not started. The auditor should be a session that did not write this code.

Highest-value things for an auditor to attack:

1. **The completed-key ledger is `job_steps` itself.** Deleting a job cascades
   its steps and erases those ledger entries. Argued acceptable in DECISIONS;
   worth a second opinion, because it is the mechanism invariant 18 rests on.
2. **The session-scoped advisory lock.** §14.3.3 names `pg_advisory_xact_lock`;
   we take a session lock on a dedicated connection instead, because the
   transaction-scoped form cannot coexist with §14.3.4 checkpointing. Check the
   release paths — a leaked lock stalls an account silently.
3. **`SystemScope`.** It admits an exception to "no unscoped table access". Check
   that the five tables using it genuinely have no account at write time.
4. **The step dependency graph.** `gsc_connect` is the judgement call.
5. **Whether any threshold escaped into code.** The lint rule matches field
   *names*; a number reaching a comparison through a differently-named
   intermediate is not caught.

---

## DECISIONS entries made

26 entries, all dated 2026-08-27, none yet classified (a/b/c). Grouped by card:

- **T0.1 (9)** — pnpm workspaces with no build orchestrator; packages consumed
  as TypeScript source; custom ESLint plugin for the three constitution rules;
  the threshold rule's field-term list and test exemption; `lint:prove` as a
  standing CI check; vitest as the runner; local Postgres on port 54329;
  `.env` keeping non-secret defaults; Railway `postgres` template-provisioned.
- **T0.2 (8)** — per-locale demand floors (**needs sign-off**); five further
  UNSIGNED numbers (**need sign-off**); §8.4 gate floors added beyond the card's
  enumeration; §14.1 drift thresholds deliberately left out; `rules_version` as
  full sha256 of file bytes; locale overrides validated after merging;
  hand-written types alongside the JSON Schema; snapshot of the resolved config.
- **T0.3 (9)** — Drizzle (**founder decision, asked in session**); branded scope
  types; `SystemScope`; three columns added beyond §13; two lifecycle columns;
  partial unique indexes on `ops_flags`; `notifications.dedupe_key` NOT NULL;
  constraint suite fails loudly without a database; extensionless imports.
- **T0.4 (9)** — session-scoped advisory lock; `job_dlq` as a wave-1 addendum;
  ledger in `job_steps`; the step dependency graph; cron off until tasks exist;
  UTC crontab with per-account clocks resolved in-task; typed failure classes;
  worker bootstrap via `instrumentation.ts`; per-suite test databases.

### Three that want a founder or integrator answer

1. **The UNSIGNED numbers in `signals.config.yaml`** (T0.2). The specs mandate
   these knobs and state no values, so I picked starting heuristics and marked
   each `UNSIGNED` in the file. The per-locale demand floors matter most —
   they decide which topics Gate 1 admits, which is user-visible. Nothing
   consumes them until T4.1, so each is a one-line YAML edit today.
   The others: winnability constant for Limited Intelligence (0.25), substance
   floor (8 facts / 4 fields / 3 products), account LLM hard cap ($5/day),
   DataForSEO global cap ($50/day), preview cap ($10/day), intent-gap cap
   (10/account/day), "impressions not collapsed" ratio (0.5).

2. **`job_dlq` breaks the letter of the migration rule** (T0.4). CLAUDE.md says
   migrations land only in schema-wave cards; T0.4 is not one. It is a wave-1
   addendum committed minutes after wave 1, in the same milestone, by the same
   session, because §14.3.5 requires a DLQ with replay context and §13 lists no
   table for it. The integrator should fold it into wave 1 or accept the
   mini-wave.

3. **§8.4's gate floors live in `signals.config.yaml`** (T0.2), though T0.2's
   card does not name §8.4. Without this, invariant 11's four numbers become
   literals in Lane D's T4.4 and the lint rule cannot catch them. Reversible by
   deleting one YAML block and one schema block.

---

## Contradictions surfaced (not resolved silently)

- **`.env` "identical with empty values"** vs. not blanking working defaults.
  Resolved by keeping secrets blank and carrying over non-secret local defaults
  (`DATABASE_URL`, `APP_URL`, `SEO_PROVIDER_MODE=mock`, `WORKER_*`), so a fresh
  clone runs. `pnpm env:check` fails if the two files' key sets ever diverge.
- **"Every repository method requires an `accountId` scope"** vs. five wave-1
  tables that have no account at write time. Resolved with `SystemScope`,
  which keeps the rule's intent rather than carving a hole in it.
- **`pg_advisory_xact_lock` (§14.3.3)** vs. **checkpointing inside long steps
  (§14.3.4)**. The two cannot both hold. Took §14.3.3's own "or equivalent".
- **`job_dlq` and the migration rule**, above.

---

## What is left in M0

**T0.5 — Provider wrappers** (audit-flagged). Not started. Instrumented
`LlmClient`, `SeoDataProvider` + DataForSEO impl + mock + endpoint→price map,
`EmailProvider` + Resend impl + mock, `PosthogCapture`, envelope encryption
helper, log scrubber. Note: observability is PostHog only — Sentry is not to be
wired, per the founder's brief.

**T0.6 — Test harnesses.** Not started. Chaos harness, eval-set runner,
synthetic-store fixture generator, Playwright scaffold, PostHog provisioning
script in check mode.

**T0.7 — Contracts & API schemas (M0 exit gate).** Not started. Every seam in
build plan §4 as an interface + double + fixtures, zod + OpenAPI for all
`/api/*` routes, MSW handlers, `stub_used` telemetry and the wired-stub report.

`.env.example` already documents the variables T0.5 will need
(`ANTHROPIC_API_KEY`, `POSTHOG_*`, `DATAFORSEO_*`, `RESEND_*`,
`ENCRYPTION_MASTER_KEY`), all currently blank.

---

## Running it

```
pnpm install
pnpm db:up            # docker compose, Postgres 16 on localhost:54329
pnpm db:migrate       # applies both migrations
pnpm lint && pnpm lint:prove && pnpm typecheck && pnpm test && pnpm build
```

Integration suites create their own databases (`sortiva_test_<label>`) and fail
loudly rather than skipping when Postgres is absent.

There is no git remote, so CI has never executed on GitHub's runners — only its
individual steps, locally.
