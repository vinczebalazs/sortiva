# Kick-off prompt — paste everything under the line into a fresh session in `~/Desktop/sortiva`

Written 2026-10-08.

---

You are building Sortiva from scratch in `/Users/balazs/Desktop/sortiva`. The directory holds the brief, a decision journal, an environment file with working credentials, and an empty git repository. The founders are away. Build as far as you can without them, and prepare what they need to look at when they return.

## Read first, in this order

1. `CLAUDE.md` — eight rules, the layout, the working rules. It is short. It is the whole constitution.
2. `docs/mvp-plan.md` — what the product is, the pipeline in eight stages (§3), every edge case and its safeguard (§4), the data model (§5), the testing framework (§6) including how the fake Shopify is kept honest (§6.6), and the founders' decisions (§7).
3. `docs/mvp-ui.md` — every screen, in the merchant's words.
4. `docs/mvp-build-plan.md` — the order of work, the phases, the scenarios each phase adds, and the five checkpoints.
5. `DECISIONS.md` — what the founders decided and what you are assuming on their behalf.

Do not start coding until you have read all five.

## What is settled

- Fresh build. `/Users/balazs/Desktop/sortiva-old` is the previous attempt. Read it for behaviour and for the cases its tests cover. Copy nothing: no code, no prompts, no test cases, no copy strings. If you find yourself opening a file there to paste from it, stop.
- Shopify's app template (React Router, App Bridge, Shopify CLI) for the Shopify host shell and its session-token authentication only. **Not Polaris.** The screens are our own React design system built from the mockups (`docs/mvp-ui.md` §1.1), hosted by a thin per-platform shell, so WordPress and a standalone site can host the same screens later. Graphile Worker for `jobs/`. Postgres. pnpm, TypeScript, Vitest, Playwright.
- English and Hungarian, both first-class. Every prompt, every eval set, every fixture store exists in both.
- Spend on the Anthropic and DataForSEO keys in `.env` is approved. Use them for recordings and evals. Keep a running total in `DECISIONS.md` under a "Spend" heading.
- There is no Shopify dev store yet and no Search Console property yet. Everything that touches a real Shopify or a real Google is built against the fake, labelled **unverified**, and listed for the founders.

## Visual reference for the screens

`docs/mvp-ui.md` §1.1 points at a set of reference mockups in a Claude Design project. They are the design system: palette, type, spacing, tone. Read them through the `claude_design` MCP before building the screens in phase 2. If that MCP is not connected in your session, note it in `DECISIONS.md`, build the screens with a neutral token set behind the same component API, and leave the real tokens as a listed item for when the founder has run `/design-login`. Do not block on it. The behaviour in `mvp-ui.md` always wins over a mockup.

## Order of work

Follow `docs/mvp-build-plan.md` §4, inside-out:

1. Repository, tooling, the one-file schema, the test-database helper, the worker with the per-store lock and the idempotency ledger. One empty scenario that boots a worker against a real Postgres and passes. Commit.
2. The fake Shopify, built from the public schema at `https://shopify.dev/admin-graphql-direct-proxy/<version>` for the pinned version in `.env`. Query validation against that schema at build time. Fixture stores as listed in phase 1. A `recordings/` folder that is empty until a dev store exists, with the test that fails for any response template without a recording **skipped and named**, so it fires the day the first recording lands.
3. Phase 1 stages and scenarios. Then phase 2, 3, 4, each with its fake first, each stage done when its scenarios are green.
4. The fake Anthropic records real calls. Run each prompt for real once per fixture store and commit the recording. The evals: write the cases, grade them yourself in both languages, label your grades as the agent's, and leave the review page for the founders.

## Checkpoints

The five checkpoints in the build plan are not skipped and not waited on. At each one:

- Write a note in `DECISIONS.md`: what was built, which scenarios exist, what is unverified, what you are unsure of.
- Produce the thing the founder would look at: for checkpoint 1 the fact sheets for five products of each fixture store beside the products; for 2 the queues; for 3 a review page of ten real articles with their checks; for 4 the rendered article HTML for three shapes, since the dev store does not exist.
- Continue.

## When you must stop

- Anything that would spend more than 20 USD in one run on either key.
- Anything that would push to a remote, deploy, or touch the old directory.
- A contradiction between the brief and what you find that changes a screen or a rule. Write it down in `DECISIONS.md` and work around it where you can.

## How to work

- Scenarios before code. Every row of `mvp-plan.md` §4 is a scenario file before its safeguard is implemented.
- One agent owns the skeleton through the end of phase 1. After that, at most three or four in parallel, one per fake or stage.
- Commit when a scenario goes green. Messages say what changed, in words.
- Comments say what the code cannot. No narration, no spec citations.
- Keep `.env.example` in step with `.env`, keys only.

## What the founders will do when they return

Create the Shopify dev stores, install the app once, create the Search Console property, grade the review pages, and run the contract suite. Leave a file `docs/for-the-founders.md` that lists, in plain language, exactly what they need to do and in what order, with the commands to run after each step.

Start with step 1. Report in plain language at the end of each phase.
