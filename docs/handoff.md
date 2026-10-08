# Handoff — start of phase 3

Written 2026-10-08 at the end of the first build session and updated at the end of the second (phase 2), for the next agent session in this repository. Read `CLAUDE.md`, then the five documents the kick-off names (`docs/mvp-plan.md`, `docs/mvp-ui.md`, `docs/mvp-build-plan.md`, `DECISIONS.md`), then this file. Phase 2 is done; **phase 3 is next**, then a fresh handoff.

## Where things stand

Phases 1 and 2 are done and committed (`git log` tells the story). `pnpm test` runs 169 tests green and 28 skipped; the skipped ones switch on by themselves when the first real Shopify recording lands. Checkpoint 1 is written up in `DECISIONS.md` and its review page is `docs/checkpoints/checkpoint-1-fact-sheets.html` (published privately at https://claude.ai/artifact/LsPqnSMS1Nj8qaMtZKtqKJ). The founders' to-do list is `docs/for-the-founders.md`; keep it current at each phase end.

No Shopify dev store and no Search Console property exist yet. Everything touching them is built against fakes and labelled unverified.

## How the code is laid out (what exists)

- `db/schema.sql` — every table, one file. `pnpm db:reset` rebuilds the local database. Tests get their own copy of a template database (`db/test-db.ts`); editing the schema rebuilds the template automatically.
- `jobs/runtime/` — `withStoreLock` (Postgres advisory lock per store, fails loudly after 2 min), `once` (idempotency ledger in `job_ledger`), `defineJob`/`taskList`/`enqueue`. A job that throws `StorePausedError` (core/status.ts) ends without retry and without a ledger row, so it runs again after the pause lifts.
- `jobs/catalog.ts` — `catalog_sync` (install, Sync now, nightly, webhook burst), `catalog_changes` (batched webhooks), `requestSync`. `jobs/sweepers.ts` — hourly cron that queues each store's nightly re-read at 3 a.m. local. `jobs/main.ts` — production worker. `jobs/all.ts` — register new jobs here.
- `core/` — plain functions, no framework or vendor SDK (enforced by `core/boundary.test.ts`; `zod` and `marked` are the allowed packages). `core/learn/` is phase 1's stage. `core/llm.ts` is the port every model call goes through; `core/spend.ts` checks the daily caps; `core/config.ts` holds every tuned number; `core/status.ts` pauses and banners; `core/setup.ts` the setup state and profile confirmation.
- `connectors/` — `StoreConnector` interface (`types.ts`) and the Shopify implementation: `queries.ts` (every GraphQL document, validated against the pinned schema and the 1,000-point cost ceiling by `queries.test.ts`), `client.ts`, `tokens.ts` (renewal serialised per store), `connector.ts`, `install.ts`, `session-token.ts`, `webhooks.ts`. `behaviour.ts` is one suite run against the fake (`connector.test.ts`) and the dev store (`connector.contract.test.ts`, `pnpm test:contract`).
- `vendors/anthropic/client.ts` — implements `Llm`: writes each call priced to `llm_calls` before sending, checks caps, answers repeats from stored responses, one shape retry, refusal = `ModelRefusedError`, no fallback model (rule 8). Model `claude-opus-5-5`.
- `fakes/fake-shopify/` — HTTP server executing our documents against the pinned 2026-07 schema; token exchange/refresh, expiry, scopes, cost/throttle, signed webhooks from Shopify's published sample payloads (`published-samples/`). `captures/public-demo-shop/` holds real answers from Shopify's demo shop; `recordings/` is empty until the dev store exists. `templates.ts` lists every response template and its source.
- `fakes/fake-anthropic/` — replays `recordings/<hash>.json`; with `RECORD=1` records missing answers from the real API. 69 recordings committed.
- `scenarios/` — `pipeline.ts` is the harness (test DB, both fakes, webhook receiver, real worker; `install`, `settle`, `syncNow`, hooks to crash or hold a job). `fixtures/stores/` has ten fixture shops: rich, three-product, existing-blog, fluff, empty, each in `-en` and `-hu`; `largeCatalog(n)` generates big ones.
- `app/` — the embedded app (React Router). `routes/api.*.ts` are thin; `shell/` holds the host shells (Shopify via App Bridge session token → our 15-minute token; a dev shell at `/dev?shop=<domain>` when `DEV_BYPASS=1`); `screens/Setup.tsx`; `ui/` our components; `ui/tokens.css` the look, taken from the founders' mockup screens (`~/Desktop/Website UI mockups project/Sortiva UI Mockups.dc.html`; ignore the "Modernist" file there, the founder said so). `i18n/messages.ts` has every string in English and Hungarian.
- `scripts/seed-preview.ts` (`pnpm seed:preview <fixtures…>`, wipes the local DB) and `pnpm preview` show screens without Shopify; `scripts/checkpoint-1.ts` builds the checkpoint page.

## Phase 2 — done (2026-10-08, second session)

Checkpoint 2 is in `DECISIONS.md`; its page is `docs/checkpoints/checkpoint-2-queues.html` (https://claude.ai/artifact/LvjY53S6G8mvCXi9BQ4Kty). Where it lives:

- `core/demand.ts` — the `Demand` port (monthly searches; Google's top ten for a batch of phrases). `vendors/dataforseo/` implements it: `client.ts`, `prices.ts`, `locations.json` (country → DataForSEO location code). **Top ten goes through DataForSEO's queue** (task_post, then task_get): their live request fails for this account (founder's decision, see DECISIONS). Pending submitted tasks are collected by the next run, never re-submitted.
- `fakes/fake-dataforseo/` — answers from a scenario script, then `recordings/`, then the real API when `RECORD_DATAFORSEO=1` (kept apart from `RECORD=1` because the balance is small), then stable placeholder numbers. `published-samples/` are DataForSEO's documented examples; the fake's shapes are tested against them and against every recording.
- `core/topics/` — `canonical.ts` (topic key), `check.ts` (existing-page check ignoring shop-wide words, same intent by shared top-three pages, shop-listings check, rank score), `candidates.ts` (the one model call), `discover.ts` (the whole run; its output, including every dropped candidate and why, is the `find_topics` row in `job_ledger`), `manual.ts` ("Add a topic"), `queue.ts` (Home's Today and Up next, expected dates, Not interested, Move to top, Skip), `evidence.ts` (the why line's template input).
- `jobs/topics.ts` — `find_topics`, `daily_pick` (one decision per shop-local day, also stored in `schedule_days`, whose primary key is rule 4), the hourly `daily_sweep`, `requestDiscovery`. In phase 3 the write job starts from a topic in state `scheduled` with `scheduled_for` = the local day.
- `core/settings.ts`, `core/screens.ts` — what Settings, Home and Products read and write. Screens in `app/screens/`; `App.tsx` shows setup until it is done, then the host navigation, banners, and the screen.
- `scenarios/topics/`, `scenarios/schedule/` — the phase 2 scenarios. `pipeline.completeSetup(id)` takes a fixture through setup; `pipeline.lastDiscovery(id)` returns what topic-finding kept and dropped.
- `pnpm seed:preview rich-hu:done …` takes fixtures through setup for the preview; `scripts/checkpoint-2.ts` builds the review page.

Open with the founders: topic wording (most proposed phrases have no measurable demand; recommendation: several phrasings per topic), the DataForSEO top-up (0.64 USD left; the other six fixture shops still use placeholder numbers), and the trivial-facts question from checkpoint 1.

## Phase 3 — what to build

Write (evidence pack from fact sheets only, plan call, draft call, deterministic checks, a blind judge, one repair, hold with reason), product cards with the aspect-ratio image choice (`CONFIG.productCardAspectRatio`), Markdown to HTML with `marked` and snapshot tests for three shapes, export zip, the Articles and Article screens, review-first approve/discard, and the evals (distillation, judge, writer; English and Hungarian halves; written fresh, graded by the agent and labelled as such; a review page for the founders). Checkpoint 3: ten real articles, five per language, with their checks, on a review page. The build plan's bar (seven of ten publishable before phase 4) is for the founders to apply; the agent's grades stand in until then.

## Things the next session must know

- **DataForSEO balance is 0.64 USD** (was 0.82). Checked 2026-10-08 with the free `GET /v3/appendix/user_data`. Search volume (`keywords_data/google_ads/search_volume/live`) costs 0.09 USD per request, for up to 1,000 keywords, so batch every store's candidates into one request. The price of the top-ten results call was not yet looked up (it is in the same `user_data` response under `price.serp`). Budget the recordings before making any: roughly one volume request and a few SERP requests per fixture store, both languages. If 0.82 USD cannot cover them, stop and tell the founders the account needs topping up. Spend on this key is approved, but the brief's per-run stop is 20 USD. Record real numbers with `RECORD_DATAFORSEO=1`.
- **Record every spend** in the "Spend" table in `DECISIONS.md` (now 0.92 USD, all Anthropic). The Anthropic total can be recomputed from the token counts in `fakes/fake-anthropic/recordings/`.
- **The founder is reachable in the session now** and answers questions; decisions that shape the system go to them (their global instructions require it), or into DECISIONS.md as "Assumed" when they are away.
- **Demand floors** are the old build's (en 100, hu 20); see DECISIONS.
- **Shopify's cost model**: the fake charges by the documented rules up front and refunds by objects returned. Keep new queries under 1,000 points by the documented rules; `connectors/shopify/queries.test.ts` checks it.
- **Seeding a fixture that no scenario uses** needs `RECORD=1 pnpm seed:preview …` the first time (a few cents).
- **Crash tests** currently throw at a checkpoint; a real process kill belongs with phase 4's crash tests.
- **Work habits that held up**: scenarios before code; commit when a scenario goes green, message saying what changed; comments only for what the code can't say; keep `.env.example` in step with `.env` (keys only); never touch `~/Desktop/sortiva-old` except to read it.
