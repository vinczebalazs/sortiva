# Decisions

Dated, one plain paragraph each. "Founder" entries were taken by the founders. "Assumed" entries were taken by the agent under the founders' standing instruction to proceed on the recommendation in the brief; the founders may overrule any of them, and the entry says what changes if they do.

## 2026-10-08 — Founder: the MVP rebuild, D1 to D9

Full text in `docs/mvp-plan.md` §7. In short:

- **D1.** Rebuild in this fresh directory. Not a single line is reused from the previous build: no code, no prompts, no graded eval cases. The old tree at `~/Desktop/sortiva-old` is read-only reference.
- **D2.** The article queue is the product. The schema and interfaces are shaped so the growth engine (signal detectors) can be added later without a migration (`mvp-plan.md` §3.10).
- **D3.** No orders, no revenue. The install asks for products and content only.
- **D4.** Search Console is optional at install, with a plainly labelled limited mode.
- **D5.** No AI images. Product images only, choosing the one whose aspect ratio best fits the card.
- **D6.** No price in article text, ever.
- **D7.** Graphile Worker is the job runtime.
- **D8.** English and Hungarian are both MVP languages. The first pilot store is Hungarian. No third language.
- **D9.** The eight rules in `CLAUDE.md` are the whole constitution.

## 2026-10-08 — Founder: keys and spend

The Anthropic, DataForSEO, Shopify app and Google OAuth credentials from the previous build are in `.env`. The founder approved spending on the Anthropic and DataForSEO keys for recordings and evals without further asking. A dev store and a Search Console test property do not exist yet.

## 2026-10-08 — Founder: the new directory

`~/Desktop/sortiva`, its own git repository (B0).

## 2026-10-08 — Assumed: framework, screens, checkpoints

Taken on the recommendations in `docs/mvp-ui.md` §11 and `docs/mvp-build-plan.md` §6, under the founder's instruction to proceed as far as possible without intervention.

- **B1 — Shopify's own app template** (React Router with App Bridge, session-token authentication, Shopify CLI) for the Shopify host shell only; **not Polaris**. The screens are our own design system (see the 2026-10-08 mockups entry). If overruled to Next.js, only the host shell is rewritten; the screens, `core/`, `connectors/`, `vendors/`, `jobs/`, `fakes/` and `scenarios/` do not move.
- **U1 — The queue is a list with expected dates**, not a calendar grid. Overruling adds a calendar screen over the same `topics` table.
- **U2 — Limited mode is a badge on Home**, not a banner everywhere.
- **U3 — No editor**, not even for titles. Overruling means an edited article re-runs the deterministic checks before it can go out.
- **U4 — Results live in the Articles table and the Article page**, plus one store-level card at the top of Articles. No separate Performance screen.
- **U5 — Review-first is on by default for auto-publish, off for export.**
- **B2 — Checkpoint 3 bar: seven of ten articles publishable** before phase 4 starts. Until the founders grade, the agent's own grading stands in and is labelled as such.
- **B3 — The pilot starts on the Hungarian store alone.**

## 2026-10-08 — Assumed: inside-out order

Phases 1 to 4 of `docs/mvp-build-plan.md` are built against fakes without waiting for the founders. The five checkpoints are not skipped: at each one the agent prepares what the founder would look at (a review page, a note, a path), records it here, and continues. Anything that touches a real vendor is labelled **unverified** until its contract run has passed against the dev store or the real property.

## 2026-10-08 — Founder: the mockups are the design system; our own components, not Shopify's

A Claude Design project (`docs/mvp-ui.md` §1.1) defines the look: colour, type, spacing, tone. It is not a screen specification; `mvp-ui.md` wins on screens, words and behaviour. The founder asked whether embedding forces Shopify's component library; it does not (only the optional "Built for Shopify" badge does). So the screens are one React design system of our own, hosted by a thin shell per platform: Shopify via App Bridge now, WordPress and a standalone site later, with the same screens. Reading the mockups needs the `claude_design` MCP and a `/design-login`, which the building agent may not have; if not, the screens are built behind the same component API with neutral tokens and the real tokens are deferred, not blocked on.

## 2026-10-08 — Noted: contradictions found while reading the brief

- **Polaris.** The kick-off message pasted into the build session lists Polaris among the template's parts; this journal's founder entry of 2026-10-08 and `docs/kickoff.md` say the screens are our own components, not Polaris. The dated founder entry is followed: not Polaris. If Polaris was meant, only the screen layer changes.
- **Design mockups not reachable.** The kick-off message mentions an attached Claude Design reference. Nothing was attached in the build session and the `claude_design` connection is not available there. Per the founders' fallback, screens are built with a neutral token set behind our own component API; swapping in the real colours, type and spacing is listed in `docs/for-the-founders.md`.
- **Wrong-language scenario.** `mvp-plan.md` §4 proves the wrong-language safeguard with "a Swedish store", but D8 limits the product to English and Hungarian. The scenario is instead: a Hungarian store whose draft comes back in English is held. A store whose Shopify language is neither picks English or Hungarian in setup.
- **Table count.** `mvp-plan.md` §5 lists seventeen tables, the build plan says sixteen. The schema follows §5, plus one table §5 does not name: `job_ledger`, the idempotency ledger that §3.9 requires ("completed keys return the stored output"). It is kept apart from the queue's own tables so that clearing finished jobs can never re-open finished work.

## 2026-10-08 — Assumed: how the repository is put together (step 1)

- **One package, not a workspace.** The directories in `CLAUDE.md` (`core/`, `connectors/`, `vendors/`, `jobs/`, `fakes/`, …) sit side by side under one `package.json`. The Shopify template's `app/` directory will be the root app's route folder, which matches the layout. Splitting into packages later is mechanical.
- **Plain SQL with the `pg` driver, no ORM or query builder.** The schema is `db/schema.sql`; `pnpm db:reset` rebuilds the local database from it. Fewer moving parts; the trade-off is no generated row types, so each module types the rows it reads.
- **Test databases.** One template database is built from `schema.sql` plus Graphile Worker's own tables; its name carries a hash of both, so editing the schema builds a fresh one automatically. Every test file gets its own copy in milliseconds and drops it afterwards.
- **Per-store lock.** A Postgres advisory lock held on a dedicated connection for the whole job. A second job for the same store waits up to two minutes, then fails loudly and is retried by the queue, rather than hanging. Taking the same store twice inside one job is refused with an error instead of deadlocking.
- **Pause reasons.** `store_flags` carries, besides the operator and merchant pause switches §3.9 names, the reasons we pause on our own (daily budget reached on a given day, permissions lost, target blog missing, Search Console disconnected), because each one is a distinct banner in `mvp-ui.md` §5.5.

## Spend

Running total of what this build has spent on the founders' keys.

| Date | Key | What | USD |
|---|---|---|---|
| — | — | Nothing spent yet | 0.00 |

**Total: 0.00 USD**
