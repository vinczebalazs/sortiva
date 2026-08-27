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
