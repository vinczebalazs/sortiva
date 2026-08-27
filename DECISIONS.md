# DECISIONS.md — Implementation Decision Journal

Every choice the specs don't dictate gets an entry, written at the moment of the decision (not at task close-out). Audits reconcile this file against the specs periodically; entries may be promoted into the specs or flagged as contradictions.

Format:

```
## <date> — <task ID> — <one-line decision>
Decision: <what was chosen>
Why: <rationale, incl. alternatives considered if any>
Nearest spec: <the section closest to this gap, e.g. "main §7.4 — silent on X">
Class (filled by audit): a: fine as-is | b: promote to spec | c: contradicts spec
```

---

(entries below, newest first)

## 2026-08-27 — T0.3 — Drizzle ORM + drizzle-kit for schema and migrations
Decision: `packages/db` defines the schema in TypeScript (`src/schema/*.ts`); `drizzle-kit generate` diffs it into forward-only SQL in `packages/db/migrations`; `drizzle-kit migrate` applies it. Repositories query through Drizzle.
Why: **Founder decision, asked and answered in session** (alternatives offered: Kysely + hand-written SQL migrations; plain `pg` + node-pg-migrate). Consequence carried forward: the generated migration is the reviewed artefact — once merged it is never regenerated in place, and a schema-wave card commits the `.sql` alongside the schema change so the integrator reviews SQL, not a TypeScript diff.
Nearest spec: tech §2 names Postgres 16 and Graphile Worker; CLAUDE.md requires forward-only migrations in `packages/db/migrations`. Neither names a tool.

## 2026-08-27 — T0.3 — Scope is a branded type, not an `accountId: string` parameter
Decision: Repository methods take `AccountScope` (branded, only producible by `accountScope(id)`) as their first argument. `SystemScope` (branded, carries a written reason) covers the account-less tables. `packages/db/src/scope.test-d.ts` proves omission and substitution are compile errors via `@ts-expect-error`, checked by `pnpm typecheck`.
Why: CLAUDE.md requires "every repository method requires an `accountId` scope parameter", and T0.3's done-when is "a repository call without scope fails to compile". A plain string parameter satisfies neither in practice: any string type-checks, including one read straight from a request body — which tech §3 explicitly forbids ("resolves `account_id` from session — never from the request body"). The brand makes that specific mistake impossible rather than merely discouraged.
Nearest spec: tech §3; CLAUDE.md code-structure rules.

## 2026-08-27 — T0.3 — `SystemScope` for the five wave-1 tables that have no account
Decision: `stripe_events`, `webhook_events`, `request_cache`, `preview_cache` and `email_suppressions` are reached through repositories taking `SystemScope('<reason>')` rather than through unscoped access.
Why: CLAUDE.md says "there is no unscoped table access outside migrations and admin scripts", but these five genuinely have no `account_id` — a webhook is HMAC-verified and stored before it is routed (main §14.3.8), a preview happens pre-signup (main §3), the request cache is keyed by canonical params rather than by tenant (main §14.3.6), and a suppressed address stays suppressed across accounts (tech §1.5). **Flagged as a contradiction rather than resolved silently**: the rule as written has no case for them. `SystemScope` keeps the rule's intent (no method without a scope; system access is explicit and greppable) while admitting the exception in the type system instead of in a comment.
Nearest spec: CLAUDE.md code-structure rules vs main §13 — the rule does not contemplate account-less tables.

## 2026-08-27 — T0.3 — Three columns added beyond main §13's table sketches
Decision: `job_steps.output_ref` (jsonb), `webhook_events.source` (enum shopify|resend), `request_cache.kind` (text). Plus `request_cache.response_ref` is realised as `response_json` (jsonb).
Why, one at a time. **`job_steps.output_ref`**: main §14.3.2 requires "completed keys are stored with their output reference; a worker seeing a completed key returns the stored output without executing", and T0.4's done-when tests exactly that — but §13's `job_steps` sketch has nowhere to put the output. Without this column T0.4 cannot pass. **`webhook_events.source`**: tech §1.4 routes Resend webhooks through the same receiver pattern as Shopify's; without a discriminator the table cannot tell whose id it holds. The unique constraint stays on `webhook_id` alone exactly as §13 states — `source` is for routing, not identity. **`request_cache.kind`**: §14.3.6 distinguishes billable reads from LLM calls and the retention sweep and cost dashboards need to separate them; deriving that from the key's shape would be parsing. **`response_json`**: tech §2.1 rules out Redis and any blob store ("Postgres is the cache"), so there is nothing for a "ref" to point at.
Nearest spec: main §13 (sketches), §14.3.2, §14.3.6, §14.3.8; tech §1.4, §2.1.

## 2026-08-27 — T0.3 — Two columns added for lifecycle mechanics §13 implies but does not list
Decision: `domains.release_after` and `shopify_conns.invalidated_at`.
Why: main §14.6 requires the domain claim be "released after a 7-day grace window" on account deletion — the row must survive that window still holding the unique index, so the release needs a timestamp to sweep on (T8.3 fills it). main §14.4 requires a 401 from Shopify to move the account to `awaiting_shopify_auth`; recording *when* the token was found invalid is what lets the 24h reminder sweep (T2.1) be idempotent.
Nearest spec: main §14.6, §14.4 — both mandate the behaviour, §13 lists no column.

## 2026-08-27 — T0.3 — Partial unique indexes make an active kill switch singular
Decision: `ops_flags` carries two partial unique indexes — one active `global` flag per name, one active `account` flag per (account, name), both `WHERE reset_at IS NULL` — plus a check constraint that a `global` flag has no `account_id` and an `account` flag must have one.
Why: main §14.5 says auto-trips "never auto-reset" and "every flip is logged with actor + reason", which implies at most one open incident per flag. Without the index a retrying auto-trip writes a new incident row on every dequeue. With it, the second trip is a no-op at the database level and the repository returns `undefined` — the same insert-with-conflict shape as every other dedupe in this schema.
Nearest spec: main §14.5 — states the semantics, not the constraint.

## 2026-08-27 — T0.3 — `notifications.dedupe_key` is NOT NULL
Decision: Every notification row must name its dedupe key.
Why: tech §1.2 makes `(account_id, type, dedupe_key)` the exactly-once guarantee under at-least-once workers, and lists a key for every type (article_id, topic_id, opportunity_id, ISO week, date). A nullable column would silently disable the constraint for the one type someone forgot, since Postgres treats NULLs as distinct in a unique index — the exact failure mode invariant 26 exists to prevent.
Nearest spec: tech §1.2 — names the key per type, does not say the column is required.

## 2026-08-27 — T0.3 — The constraint suite fails loudly when no database is present
Decision: `constraints.test.ts` skips its cases when Postgres is unreachable, but a final test then throws with instructions to run `pnpm db:up`.
Why: A silently-skipped constraint suite reports green while proving nothing — and this is one of the three audit-flagged cards. Skip-plus-fail keeps the developer-experience benefit (a clear message rather than 21 connection errors) without letting CI or a local run pass on an empty result.
Nearest spec: tech §5, §6 — CI gates on integration tests; silent on absent-dependency behaviour.

## 2026-08-27 — T0.3 — Relative imports are extensionless repo-wide
Decision: `import { x } from './y'`, not `'./y.js'`, in every package.
Why: `moduleResolution: "Bundler"` (T0.1) makes extensionless the idiom, and drizzle-kit's config loader transpiles to CJS and cannot resolve `.js` specifiers pointing at `.ts` files. Applied consistently rather than per-package so there is one convention.
Nearest spec: none — internal.

## 2026-08-27 — T0.2 — Per-locale demand floors: values invented, flagged UNSIGNED
Decision: `gates.demand_floor.monthly_search_volume_min` defaults to 100/mo, with per-language overrides descending to 10/mo for the smallest EU markets (en 100 · de/fr/es 60 · it/pt 50 · nl/pl 40 · sv/da/nb/fi/cs/hu/ro/el 20 · sk 15 · sl/et/lv/lt 10). Keyed by language subtag; the resolver falls back full tag → language → global default.
Why: main §8.2 requires per-country floors ("50/mo in Danish ≠ 50/mo in English") and supplies no table, and T0.2's done-when requires the keys to exist. Floors are set roughly proportional to the search market's size so equivalent commercial seriousness clears the bar in a small language as in English. **These numbers need founder calibration sign-off** — they decide which topics Gate 1 admits, which is user-visible. Nothing consumes them until T4.1, so changing them is a one-line YAML edit.
Nearest spec: main §8.2 — mandates per-locale floors, states no values. Appendix B does not cover them.

## 2026-08-27 — T0.2 — Five further UNSIGNED numbers the specs mandate but do not state
Decision: `gates.winnability.limited_intelligence_constant: 0.25` (main §9.6.4 says "a conservative constant"); `gates.substance_floor` = 8 distinct facts / 4 populated fields per product / 3 contributing products, margin ×1.5 (main §8.2 defines the metric, no floor); `auto_trips.account_llm_spend.hard_cap_usd_per_day: 5.00`, `auto_trips.dataforseo_spend.global_cap_usd_per_day: 50.00`, `auto_trips.preview_spend.global_cap_usd_per_day: 10.00`, `budgets.intent_gap.analyses_per_account_per_day: 10` (main §14.5 names each cap as "configured"/"config", none with a number); `learning.outcomes.optimize.impressions_not_collapsed_ratio_min: 0.5` (main §9.6.10 says "impressions not collapsed").
Why: T0.2's scope is "**every** number from ... §14.5 (auto-trip thresholds)", so the keys must exist. Each is marked `UNSIGNED` in the YAML. Sizing rationale: the account LLM cap is a loud-failure ceiling far above the ~$2.90/day of revenue a $89/mo plan produces, not a budget; the preview cap follows main §14.5's own note that this trip firing "means Turnstile, rate limits, or the cache are being defeated — investigate, don't just raise the cap", so it is deliberately low.
Nearest spec: main §14.5, §8.2, §9.6.4, §9.6.10 — each mandates the knob, none states the value.

## 2026-08-27 — T0.2 — main §8.4's gate floors are in signals.config.yaml, beyond the card's enumeration
Decision: `gates.draft_grading` holds §8.4's numbers — information gain ≥ 4, grounding ≥ 4, other criteria ≥ 3, one repair loop max, 1–5 score range.
Why: T0.2's card enumerates §7.3/§7.6/§8.2/§9.6/§10.2/§14.5 and does not name §8.4, but invariant 11 gates on those four numbers and there is no other home for them; leaving them out guarantees Lane D writes them as literals in T4.4. The lint rule cannot catch it (it matches volume/position/impression/CTR field names, not judge scores), so the config is the only defence. Trivially reversible: delete one YAML block and one schema block.
Nearest spec: main §8.4 — states the floors; §7.10 does not list §8.4 among the sections it governs.

## 2026-08-27 — T0.2 — main §14.1 drift thresholds stay out of signals.config.yaml
Decision: The Product Change Impact drift numbers (OOS ≥ 14d, price ≥ 20%, deleted, family-axis change) stay with the drift/repair card; the signal entry here carries only priority and GSC-dependence, with a pointer.
Why: §7.10's config layer is scoped to §7.3/§7.6/§8.2 (+§9.6 via its parenthetical), and §7.3's row for this signal defers wholesale to §14.1 ("already built as the repair loop"). Pulling §14.1's table forward would put thresholds in this file that no §7.10 reader expects and that the drift card owns. Flagged for the integrator: if the invariant sweep prefers one home for every number, this is the block to move.
Nearest spec: main §7.3 (row) → §14.1 — silent on which module owns the values.

## 2026-08-27 — T0.2 — rules_version is the full sha256 hex of the file's bytes
Decision: `rules_version = sha256(utf8 bytes of signals.config.yaml)`, 64 hex chars, not truncated and not derived from the parsed document.
Why: main §7.10 and tech §2 both say "content hash". Hashing raw bytes rather than the parsed tree means a comment or ordering change also produces a new version — correct, because main §8.5's calibration posture treats every edit to this file as a reviewable change, and §14.7's weekly review breaks PostHog down by `rules_version`.
Nearest spec: main §7.10 — "its content hash", no format given.

## 2026-08-27 — T0.2 — Locale overrides are validated after merging, not in isolation
Decision: A locale layer restates only the keys it changes. The loader deep-merges it over `defaults` and validates the *merged* layer against the full schema (`additionalProperties: false`).
Why: A partial layer cannot be validated on its own without a second, weaker schema — which is exactly how a typo (`monthly_search_volume_typo`) becomes a value that is silently never read. Validating the merge turns that into a startup failure. Tested.
Nearest spec: main §7.10 — specifies the layering, not its validation.

## 2026-08-27 — T0.2 — Hand-written TypeScript types alongside the JSON Schema
Decision: `packages/rules/src/types.ts` mirrors `schema/signals.config.schema.json` by hand rather than being generated from it.
Why: Two sources of truth, accepted knowingly. The generator route (`json-schema-to-ts`) adds a dependency and a build step to a package that deliberately has neither, for a document that changes only through the §8.5 calibration process. The 100-row threshold-enumeration test walks the config through the typed accessor, so a drift between schema and types surfaces as a test failure rather than as a runtime surprise. Revisit if the document starts changing often.
Nearest spec: none — internal to packages/rules.

## 2026-08-27 — T0.2 — Committed snapshot is the fully resolved config, defaults plus every locale
Decision: `packages/rules/snapshot/loaded-config.json` holds `rules_version`, the resolved defaults, and each locale's fully merged layer, written and checked by vitest's file snapshot.
Why: A snapshot of the raw YAML would only restate the file. Snapshotting the *resolved* layers makes the merge semantics reviewable in a diff — a change to one default that silently alters twenty locale layers shows up as twenty lines in the PR. Also means editing a threshold without updating the snapshot fails CI, so no threshold change lands unreviewed.
Nearest spec: build plan T0.2 done-when — "snapshot of the loaded config committed".

## 2026-08-27 — T0.1 — pnpm workspaces with no build-orchestrator layer
Decision: Monorepo is plain pnpm workspaces (`apps/*`, `packages/*`, `tools/*`) with fan-out via `pnpm -r`. No Turborepo/Nx.
Why: The constitution names the package list and the tech spec names a single deployable; neither implies a task graph. One `pnpm -r run typecheck` and one root `vitest`/`eslint` invocation cover CI today, and adding a cache layer is reversible at any point without touching package boundaries.
Nearest spec: tech §2 — names the stack, silent on build tooling.

## 2026-08-27 — T0.1 — Workspace packages are consumed as TypeScript source
Decision: `@sortiva/*` packages point `main`/`types`/`exports` at `src/*.ts` and have no build step. `apps/web` lists them in `transpilePackages`; vitest and `tsc` read the sources directly.
Why: Removes an entire build-ordering problem between eight packages for a codebase that ships as one Next.js deployable. Consequence a later card must respect: any non-Next consumer (the Graphile worker bootstrap, scripts) must run through a TS-aware loader, which the worker bootstrap in T0.4 does.
Nearest spec: tech §2.1 — "same codebase", one image; silent on module format.

## 2026-08-27 — T0.1 — Constitution lint rules are a local ESLint plugin, not `no-restricted-imports`
Decision: `tools/eslint-plugin-sortiva` provides three rules: `no-direct-provider-sdk` (invariant 25), `no-threshold-literals` (invariant 9), `route-handler-imports` (code-structure rule).
Why: Two of the three cannot be expressed with built-in rules. The threshold ban must inspect *what a number is compared against*, and the route-handler rule must be an allowlist (handlers may import only core + serialisers) where `no-restricted-imports` only expresses a denylist. Making the SDK ban a custom rule too keeps all three in one place with spec citations in the messages, and makes the vendor list extensible as `SeoDataProvider`/`EmailProvider`/Stripe/PostHog wrappers land.
Nearest spec: main §7.10, §14.7; CLAUDE.md code-structure rules.

## 2026-08-27 — T0.1 — Threshold-literal rule: field-term list and test exemption
Decision: `no-threshold-literals` fires on a numeric literal compared against an identifier or property whose name (camelCase normalised to snake_case, whole name or trailing word) is one of `volume, position, impression(s), click(s), ctr`. It is disabled inside `packages/rules`, and inside `*.test.ts` / `fixtures/`.
Why: The constitution's wording is "numeric comparisons against volume/position/impression/CTR fields"; this is that list made mechanical. The test exemption is necessary because the tests that prove `packages/rules` serves the right numbers must state those numbers. The risk it accepts: a threshold smuggled into production code through an intermediate variable with an unrelated name is not caught by lint — the T0.2 config-key enumeration test is the second line of defence.
Nearest spec: main §7.10 — mandates the lint, does not define its matcher.

## 2026-08-27 — T0.1 — Planted lint violations are a CI check, not a one-time demonstration
Decision: `pnpm lint:prove` (`scripts/prove-lint.mjs`) writes the two violations the card names into throwaway files, asserts `eslint` rejects each with the expected rule id, and deletes them. It runs in CI.
Why: The done-when is a property of the lint config that can silently regress (a broadened ignore, a disabled rule). Proving it once at authoring time proves nothing about next month.
Nearest spec: build plan T0.1 done-when — silent on how the proof is retained.

## 2026-08-27 — T0.1 — Vitest as the unit/integration runner; Playwright reserved for UI flows
Decision: Vitest at the repo root for every `*.test.ts`; Playwright is scaffolded separately in T0.6 for the flows tech §6 assigns to it.
Why: tech §6 names Playwright only for UI flows and leaves everything else as "unit/integration tests". One root vitest project keeps the fixed-name suites the constitution requires (`distillation.eval`, `judge.eval`, `persona.smoke`, `signals.fixtures`, `chaos`) discoverable by a single glob.
Nearest spec: tech §6 — names the mapping, not the runner.

## 2026-08-27 — T0.1 — Local Postgres on port 54329
Decision: `docker-compose.yml` maps Postgres 16 to host port 54329, not 5432.
Why: Avoids colliding with a developer's system Postgres (one is installed on this machine). Purely local; CI and Railway are unaffected.
Nearest spec: tech §5 — "local: docker-compose Postgres", silent on ports.

## 2026-08-27 — T0.1 — `.env` keeps non-secret local defaults rather than being literally empty
Decision: `.env` mirrors every key in `.env.example`; secrets are blank, but `DATABASE_URL`, `NODE_ENV`, `APP_URL`, `POSTHOG_HOST`, `SEO_PROVIDER_MODE=mock` and the `WORKER_*` values are carried over. `pnpm env:check` fails if the two files' key sets ever diverge.
Why: The founder's instruction was "an identical `.env` with empty values"; blanking the local database URL and the mock-provider switch would make a fresh clone fail to run tests, which is the opposite of the intent. Flagged rather than resolved silently. `SEO_PROVIDER_MODE=mock` in particular is a cost guard — tech §5 puts real DataForSEO spend in prod only.
Nearest spec: tech §4 — "`.env.example` documents every required variable", silent on `.env`.

## 2026-08-27 — T0.1 — Railway `postgres` is template-provisioned, not declared in `railway.toml`
Decision: `railway.toml` configures the `app` service only (build, start command with `--max-old-space-size=384`, healthcheck on `/api/health`, `sleepApplication = false`, one replica). The `postgres` service is created from Railway's Postgres template and reaches `app` via `DATABASE_URL`.
Why: Railway's repo-level config describes the service built from the repo; database services are provisioned from templates and cannot be declared there. This is a Railway constraint, not a departure from tech §2.1's two-service topology.
Nearest spec: tech §2.1 — specifies the topology, not the file that expresses it.
