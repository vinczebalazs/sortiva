# Remediation plan — what needs fixing, in what order, and why

Written 2026-09-24. **Audience: an engineering agent picking this up with no memory of the sessions that produced it, plus the founder reading alongside.** Everything here is traceable to a file, a line, or a named source document. Where something is an inference rather than a reading, it says so.

This is a **plan**, not a spec and not a licence. `CLAUDE.md` still governs: one task card per session, read the cited spec sections verbatim before writing code, every choice the specs do not dictate goes in `DECISIONS.md` immediately, and anything that changes user-visible behaviour or another lane's interface stops and asks.

---

## 0. How to use this document

1. Read §1 to learn the true state of the product. Several things you would assume from the repo are false.
2. Read §2 to learn what the three source documents say and how they overlap. They were written independently and two of them are in Hungarian.
3. Read §3. **Nothing in Phase G may start until the founder answers those questions.** Phases A–F are unblocked.
4. Work the phases in §4 in order. Each numbered item is a task card: it says what is wrong in plain words, where, what "done" means, which lane owns it (build plan §3), and which invariants it touches.
5. §5 is the complete finding ledger, so you can check nothing was dropped.

**The single most important instruction:** do not start fixing individual bugs on `main` today. Phase A merges a branch that already fixes thirteen of them and rewrites the files another eleven live in. Fixing those on `main` first means doing the work twice and then resolving a conflict between two fixes.

---

## 1. Where the product actually is

### 1.1 What exists and works

The build is substantially complete against its own specification. Thirteen milestones closed, roughly 197,000 lines of TypeScript, 349 test files and 4,589 tests, all green. `pnpm chaos` (the crash-recovery suite) passes. The domain logic — catalogue ingestion, product distillation, opportunity detection, the three quality gates, the calendar, two-phase publishing, the learning loop — is built and unit-tested.

### 1.2 What is not true, despite appearances

**It has never been used.** Not once by a real merchant against a real store. The tests pass because each part is tested with every neighbour replaced by a stand-in. The failures live at the joins.

**The safety net does not cover the thing that matters most.** `pnpm eval`, the suite that grades what gets written into a merchant's store, **has never run.** It needs an Anthropic key that was not configured. Three prompt changes landed on 2026-09-07 without it ever running (`docs/handoff-next.md`). Nobody has seen an article this product would publish.

**A bug hunt in September 2026 found 106 confirmed defects.** Eleven were reproduced by booting the app and using it; ninety-five came from a thirteen-seam code review where a second, independent reviewer had to confirm each finding before it counted (ten claims were refuted and discarded). Severity, counting both passes:

| Severity | Count | What it means |
|---|---|---|
| Critical | 3 | Nobody gets past this point at all |
| High | 30 | Money, data, or a whole feature silently lost |
| Medium | 41 | A merchant sees something wrong or a screen lies |
| Low | 31 | Real, narrow, or needs an unlucky sequence |
| Config | 1 | Wrong value in `.env`, not a code defect |

Thirteen of the ninety-five are **already fixed** on an unmerged branch (§1.3). Eighty-two are open.

**The Shopify integration on `main` cannot work against the real Shopify.** This is the crucial issue. Details in §1.3.

**The published HTML is not built from the writer's Markdown.** Found independently by the code review and by the competitor research. The writer produces Markdown, the third gate checks Markdown links, and then the function that builds the HTML escapes the text and wraps each section in a single paragraph tag. Internal links, tables and list structure would reach the merchant's store as literal characters. `packages/core/src/publish/bundle.ts:168`. **Nobody has ever looked at a published article, which is why this survived.**

### 1.3 The Shopify integration, and the branch nobody merged

**The problem.** `main` talks to Shopify over the REST API pinned to version `2025-01`, which is retired, and stores the access token with no expiry and no refresh token. The app registration Sortiva uses issues tokens that expire after about an hour. So on `main`, a merchant connects their store, the first catalogue read may work, and within the hour every Shopify call fails with a permission error, which the code reads as a dead token and uses to disconnect the store. The merchant is asked to reconnect, and the cycle repeats forever.

**Work already done, and not merged.** The branch `shopify-hardening` is six commits, 109 files, about 13,000 added lines. It is not merged into `main` and not pushed. It:

- **Replaces REST with GraphQL entirely**, pinned to `2026-07`. No REST call remains anywhere (`packages/providers/src/shopify/graphql.ts` is new; verified by search).
- **Adds token expiry and refresh**, serialised per store so two workers cannot both renew and leave one holding a token Shopify has forgotten (schema wave `0015`).
- **Stops the install hanging.** The OAuth callback used to run the entire onboarding pipeline — catalogue walk, model calls, paid search data — inside the merchant's browser request. It now queues the work.
- **Lets a merchant who granted publishing reconnect.** The install used to reject their own token for carrying the write permission.
- **Separates a permission refusal from a dead token**, so Shopify refusing order data no longer disconnects the store.
- **Corrects revenue and the order window.** Revenue now means net product sales after refunds and discounts, excluding tax and postage; the window is sixty days because sixty is what Shopify gives an app like this one. `main` added tax and postage, ignored refunds, and labelled sixty days as ninety.
- **Retries failed webhook deliveries** instead of marking them done.
- **Adds `shopify.app.toml`**, which is the only place Shopify accepts the three privacy webhook topics a listing requires. **No webhook of any kind arrives until this file is pushed**, and pushing it needs a Shopify login, which is the founder's.

**Verified effect on the bug ledger:** thirteen confirmed findings are fixed by this branch. A further eleven live in files the branch rewrote but are **not** fixed and must be redone against the merged result — they are marked in §5.

**What the branch does not do.** It sets `embedded = false`. It is the *custom-app, standalone-web-app* path made to work — which is exactly what the pilot needs. It is **not** the Shopify App Store path. Do not mistake merging it for being ready to list.

### 1.4 The working tree is dirty and collides with that branch

Twenty-three modified files and four untracked ones are uncommitted on `main`, including migration `0014` and a rewrite of the landing-revenue sweep. The branch's migration is numbered `0015` and, per its own commit message, "applies cleanly once `0014` is committed on main". The branch and the working tree both edit `packages/jobs/src/ingestion/sweep.ts`, `packages/providers/src/shopify/{oauth,publish,mock}.ts` and two test files. **Commit the working tree before merging the branch**, or the merge will be resolved against a moving target.

---

## 2. The three source documents

| Document | Language | What it is | Status |
|---|---|---|---|
| The bug ledger (§5 of this document) | English | 106 confirmed defects from a live run and a thirteen-seam verified code review | Findings, not decisions |
| `docs/roadmap.html` | Hungarian | How to go from one store to many: the Shopify App Store path, ten steps, 7–15 weeks | Estimate, explicitly "not a commitment" |
| `docs/competitior_analysis.md` | Hungarian | Competitor research, September 2026, plus four defects it found in our own code | Explicitly "research material, not a spec — nothing binds until it becomes a card or a `DECISIONS.md` entry" |

### 2.1 What the roadmap says

Automatic writing and publishing are finished, but the product is built as a single-store Shopify app with Stripe billing, living on its own website. Selling to many stores needs a public Shopify App Store app, and the App Store requires four things Sortiva does not have: **Shopify's own billing, a screen embedded inside the Shopify admin, the GraphQL API, and an install that starts from Shopify.**

The GraphQL requirement is **already met** by the unmerged branch. The other three are not.

The sequencing constraint the roadmap identifies: a public app cannot be installed on a real store until Shopify approves it. So the real-store pilot must run first, on the current code, using per-store custom apps.

Estimates: pilot 1–3 weeks, App Store rebuild 4–8 weeks, listing 7–15 weeks from start. The widest band is Shopify's review, which is not ours to schedule.

### 2.2 What the competitor research says

**The field is weak where it matters.** Nobody does the full loop: a Search Console signal turned into a specific action and then judged against results 28 days later. Article-per-article outcomes are shown by nobody.

**The product claim everyone makes and nobody delivers is catalogue-grounded articles.** Read from live customer articles: an Outrank customer's article listing ten of their own products contained zero product links; another linked its Boston section to a Calgary poster and its London section to a **direct competitor's** product page. Across 25 BabyLoveGrowth articles there was one product link in total, and two articles linked to competitors. This is the largest open field.

**All three main competitors run link exchanges**, which means foreign follow links inside the customer's own articles. GetAutoSEO's API rejects an edit that removes a "protected" link with a 422. A Hungarian home-care article links to a Hong Kong company; a sleep-products store links to a dentist and an eyebrow salon.

**The recurring complaints** across Trustpilot and the Shopify App Store are: charged after cancelling and cancellation buried; generic or factually wrong text; off-topic or harmful backlinks; visibility dropping and content not being indexed after bulk publishing; nonsensical AI images; "invalid token" install failures.

**Price anchor is 99 USD for 30 articles a month.** Everyone offers something before payment. Sortiva is 89 USD with no trial, which reads as *less*, not cheaper, unless the message inverts it.

**Most of our prohibitions are sellable.** No foreign links in your articles. No invented personal experience signed with the owner's name. At most one a day, only if it passes the gate. Read and write are separate permissions. Each of these maps to a competitor's one-star reviews.

**It also found four defects in our own code**, which it rates as more important than any idea it copied: the Markdown-to-HTML failure (§1.2), the persona's tone, audience and language never reaching the writer, the "live price" not being live, and articles going out with no images while the sync fetches product images and throws them away.

### 2.3 Where the three overlap

Two independent reviews finding the same defect is the strongest signal in this document.

| Defect | Bug ledger | Competitor research | Roadmap |
|---|---|---|---|
| Published HTML is not rendered from Markdown | High, `bundle.ts:168` | §4.1, called "the finding" | — |
| Shopify API version retired | Medium, `oauth.ts:22` | §8.2 table | Step 3 |
| Order window says 90 days, gets 60 | Medium, `orders.ts:21` | — | Step 1 decision |
| Articles have no images | — | §4.4, §6.1 | Step 3 |
| Install does not start from Shopify | — | §8.2 table | Step 5, step 7 |
| Stripe billing, not Shopify billing | Several billing findings | §8.2 table | Step 1, step 6 |

The first three are fixed or fixable now; the last three are the App Store rebuild.

---

## 3. Decisions that block work

**Phases A to F below need none of these.** Phase G cannot start without the first group, because the current specification and invariants forbid what it builds.

### 3.1 Blocking the App Store path (from the roadmap, step 1)

1. **Distribution.** Public App Store app, or stay on per-store custom apps? A custom app installs on exactly one store.
2. **Billing.** Shopify App Pricing instead of Stripe for Shopify stores. This **contradicts invariant 16**, which names the Stripe webhook worker as the only writer of entitlement. The invariant text must change before any card starts.
3. **Account identity.** Account becomes the store rather than the email address. Email is then only for notifications. This touches every screen and most tests.
4. **Order window.** Sixty days, which needs no extra permission, or ninety, which needs `read_all_orders` and a justification Shopify may refuse. *(The branch already implements sixty and says so; ratifying that is the cheap answer.)*
5. **The free website analysis on sortiva.app** becomes a marketing page whose button points at the App Store listing.

Specification sections to amend: main §4.1, §4.2, §5, §6.1–6.2, §9.5; tech §3; ui §2; Appendix A; and the wording of invariants 16 and 21.

### 3.2 Product decisions from the competitor research

The research lists thirteen. These are the ones that gate work in Phase H:

6. **Images in articles** — reverses the 2026-09-04 decision to ship without them. Also: where does alt text come from, and does an update overwrite an image the merchant replaced?
7. **Visible product card** — with price (which then forces a re-render when the price changes) or without.
8. **Structured data (JSON-LD)** — export only, or on auto-publish too.
9. **Per-article switches** — which, if any, join the deliberately exhaustive settings list in ui §9.
10. **Draft by default** when a merchant switches on auto-publish.
11. **A standing "writing notes" field** the merchant controls.
12. **Trial, guarantee and launch price** — against a 99 USD / 30-article anchor.
13. **Free Search Console diagnosis before checkout**, which would reverse the funnel order in main §4.2.

### 3.3 Needing no decision

These are specification compliance or plain defects, and the constitution already permits fixing them: the Markdown-to-HTML failure, tone not reaching the writer, hardcoded English strings inside articles, persona not editable after confirmation, and a one-click cancellation deep link.

---

## 4. The work

Lane letters are from the build plan §3. Sizes: **S** one card, **M** two or three cards possibly with a schema wave, **L** several lanes or a new milestone.

---

### Phase A — Make the tree coherent

**Nothing else starts until this is done.** Everything downstream is conflict management otherwise.

**A1 — Commit the working tree.** S · integrator
Twenty-three modified and four untracked files sit on `main`, including migration `0014` (adds a `delivered` value to the email-send state) and a rewrite of the landing-revenue sweep into a sweep plus a per-store job. `DECISIONS.md` already carries entries for both. Commit them as they stand; do not improve them in the same commit.
*Done when:* `git status` is clean and the eleven-command gate is green.

**A2 — Merge `shopify-hardening` into `main`.** M · integrator
Six commits, 109 files. Expect conflicts in `packages/jobs/src/ingestion/sweep.ts`, `packages/providers/src/shopify/{oauth,publish,mock}.ts`, `packages/providers/src/shopify/{publish,shopify}.test.ts`, `apps/web/app/api/shopify/_lib/config.ts` and the Shopify webhook receiver. Migration `0015` must apply after `0014`.
*Done when:* the gate is green, including `db:migrate` against a freshly created empty database, and `pnpm chaos` is still ten of ten.
*Read first:* the six commit messages — they are unusually detailed and explain each behaviour change.

**A3 — Re-verify the eleven findings the branch touched but did not fix.** S · integrator
Listed in §5 with the marker `branch-touched`. They were confirmed against `main`; the code around them has moved. Confirm each still reproduces before carding it.

---

### Phase B — Nobody can get through the front door

Three critical findings plus four that stop a specific journey dead. All reproduced by running the app, except B5 and B6.

**B1 — Onboarding stops at the first step and the screen says it will retry.** Lane B · S
When platform detection fails with a retryable error the runtime stamps a retry time on the step, and **nothing ever fires that retry**. The only caller of the ingestion dispatcher is the domain-claim route (`apps/web/app/api/domain/_lib/store.ts:158`). No scheduled task looks for runs whose retry time has passed. The dashboard says "we'll retry automatically, nothing for you to do" indefinitely. The dead-letter replay path has the same hole: it resets the step to pending and nothing dispatches it.
*Done when:* a scheduled task re-dispatches runs whose retry time has elapsed, a replayed dead-letter entry runs, and a test covers a step that fails once and then succeeds.

**B2 — Platform detection fails on any store with a large home page.** Lane B · S
The guarded fetcher caps bodies at 600 KB and detection reads the whole page. Reproduced: `allbirds.com` fails, `gymshark.com` succeeds. Detection only needs the headers and the head of the document. The underlying cause is also dropped from the log, so an operator sees only "could not read". `packages/jobs/src/ingestion/steps.ts:170`, `packages/providers/src/fetch/fetcher.ts`.
*Done when:* detection succeeds against a home page over the cap, and the log carries the original cause.

**B3 — The public preview returns a 500 before reaching any vendor.** Lane A · S
The preview prompt is loaded by building a URL from the module's own address; under the bundler that URL is a different class from Node's and the path converter rejects it. The LLM package solved this already with a path-based loader (`packages/llm/src/prompts.ts:39`); the preview route never switched. `apps/web/app/api/preview/_lib/config.ts:93`. The boot smoke check only asks for the landing page and the health check, which is why it never saw this.
*Done when:* a preview request returns a card, and the smoke check exercises the preview route.

**B4 — Every app screen renders without a signed-in session.** Lane F · S
Signed out, the dashboard, opportunities, content, products, performance and settings screens all render, and the dashboard shows a working "Connect your domain" form. The shell turns the 401 from the account route into an "unknown account" and no page redirects (`apps/web/app/(app)/_lib/shell-state.ts`). The API routes themselves refuse correctly, so submitting the form fails with an unexplained 401.
*Done when:* an unauthenticated request to any `(app)` route redirects to sign-in.

**B5 — The production start command runs from a directory with no build.** Lane G · S
`railway.toml:38`. The deployed server would start with nothing to serve.
*Done when:* a deployment starts and answers the health check.

**B6 — Search Console can never be connected.** Lane C · S
The connect flow never reaches the property picker, so the step cannot complete (`apps/web/app/api/gsc/_lib/config.ts:33`). Search Console is what the engine reads before it decides anything, so this disables the product's intelligence, not just a screen.
*Done when:* a dev account completes the connection end to end and a property is stored.

**B7 — Every sign-in lands on the plan page with a live Subscribe button.** Lane A · S
`packages/ui/src/public/signin-exchange.ts:33`. Checkout also does not refuse an account that already has a subscription, so a paying merchant can buy twice.
*Done when:* a signed-in subscriber lands on the dashboard, and checkout refuses an active subscription.

---

### Phase C — Money, data loss, and work that stops silently

**C1 — Deleting an account can leave the Stripe subscription running forever.** Lane A · S · invariant 16
The deletion stamp commits in its own transaction; the job that closes the vendor subscription is queued separately, after two more statements. If anything fails in between, a retry returns "already deleted" and queues nothing, no sweep repairs it, and the retention sweep erases the subscription row a week later — removing the only record of what to cancel. `apps/web/app/api/account/delete/_lib/handler.ts:52`.
*Done when:* the closure job is queued inside the same transaction as the deletion stamp, or the retention sweep re-queues closure for deleted accounts that still have a subscription.

**C2 — Stripe events can sit unprocessed indefinitely.** Lane A · M · invariant 16
Three defects in one path. The drain job is registered but **nothing ever enqueues or schedules it**; processing happens only in a fire-and-forget promise inside the webhook request, which always answers 200 so Stripe never redelivers (`apps/web/app/api/webhooks/stripe/_lib/tasks.ts:35`, `receiver.ts:105`). The nightly reconciliation named in the comments as the backstop does not read the stored-events table. Separately, an event that can never be resolved sits at the front of the queue and stops billing processing anything behind it (`packages/core/src/billing/processing.ts:424`), and an event about an old subscription can overwrite the live one (`processing.ts:213`).
*Done when:* a paying merchant whose drain crashed becomes entitled without another webhook arriving; an unresolvable event is parked rather than blocking; and a stale event cannot overwrite a newer status.

**C3 — Spend caps do not cap most spending.** Lane C · M · invariant 17
The daily search-data cap stops keyword enrichment only; every other paid read keeps spending (`packages/jobs/src/sweeps/spend-caps.ts:135`), and the weekly scan's result-page purchases are not covered at all (`packages/jobs/src/scan/assemble.ts:521`). Separately, the "spending far more than normal" brake pauses healthy stores whose typical day is a fraction of a cent (`packages/core/src/ops/spend-caps.ts:167`).
*Done when:* every billable read is counted against the cap, and the anomaly brake does not fire on a store with near-zero baseline spend.

**C4 — Mail that fails is retried forever and never reported.** Lane G · S · invariant 18
The every-minute drain re-queues each queued row under the same job key, and the queue library overwrites the payload — which is the only place the attempt counter lives — so a failing message resets to attempt one and can never reach the four-attempt limit or the dead-letter queue (`packages/jobs/src/notify/send-worker.ts:76`). Separately, network failures and vendor 5xx responses are classified non-retryable, so a blip drops the message permanently (`packages/providers/src/email/index.ts:71`), and the global pause switch exempts the drain but not the job that actually sends (`packages/jobs/src/runtime/gate.ts:206`).
*Done when:* a persistently failing message dead-letters and alerts; a transient network error is retried; and pausing does not silently stop mail.

**C5 — A job that arrives while work is paused is thrown away.** Lane G · S · invariant 22
`packages/jobs/src/runtime/gate.ts:281`. The rule is degrade to pause, not to loss.
*Done when:* a job arriving during a pause is held and runs after the pause lifts.

**C6 — Search Console rows are written in one statement that Postgres rejects.** Lane C · S
No chunking; past roughly 7,000 rows the insert fails, so any real store's sync fails (`packages/db/src/repositories/search.ts:145`).
*Done when:* a sync of 100,000 rows succeeds.

**C7 — Publishing can block itself permanently.** Lane D · M · invariants 15, 19
Four defects that survive the branch merge. An abandoned publish claim keeps its unique per-article name, so that article can never be claimed again and delivery retries it first every day (`packages/jobs/src/publish/auto-publish.ts:403`, `packages/db/src/repositories/publishing.ts:342`). A veto landing between choosing the article and claiming the publish still publishes it (`auto-publish.ts:317`). A crash between the Shopify post and the day's ledger write can deliver two articles in one day (`deliver.ts:190`). The recovery sweep re-publishes for a store that has since switched back to export (`recovery.ts:218`).
*Done when:* each sequence is covered by a chaos scenario.

**C8 — Manually adding a topic crashes when the keyword already has an opportunity.** Lane D · S
`packages/db/src/repositories/opportunities.ts:728`. Related: database constraint violations are never translated, so day collisions surface as 500s instead of the 409 with a machine-readable code the contract promises (`packages/db/src/repositories/topics.ts:296`).
*Done when:* both answer 409 with a code the screen handles.

---

### Phase D — What the articles actually look like

**This phase decides whether the pilot measures anything.** If the HTML is broken, a pilot tells you nothing about article quality.

**D1 — Publish the writer's Markdown as real HTML.** Lane D · S · *found twice, independently*
The writer produces Markdown and the third gate checks Markdown links and tables, but the HTML builder escapes the text and wraps each section body in a single paragraph tag (`packages/core/src/publish/bundle.ts:168`). Internal links, comparison tables, step lists and paragraph breaks would reach the store as literal characters. Only the `{{pN}}` product tokens become links. No Markdown library is in any `package.json`.
**Verify before fixing:** render one fixture article to HTML and look at it. Both reviews inferred this from reading; neither ran it.
*Done when:* a fixture article's HTML contains real anchors, tables and paragraphs, and a per-connector HTML contract test locks it.

**D2 — Give the writer the persona's tone, audience and language.** Lane D · S · spec compliance
`buildDraftRequest` sends the keyword, shape, section order, length, links, claims and product names, and not the tone, audience or language — those words do not appear in the file (`packages/core/src/generation/draft.ts:143-172`). The only consumer of tone today is the OPTIMIZE recommendation. main §9.2 requires "in the persona's language and tone".
*Blocked on:* `pnpm eval` running at all, which needs an Anthropic key. **Do this first — it is the prerequisite for judging any prompt change.**
*Done when:* `pnpm eval` runs, and a draft in a non-English persona comes back in that language.

**D3 — Article writing is capped below the length it is asked for.** Lane D · S
Output is capped at 4,000 tokens while the requested length has no upper bound, so long or non-English articles are cut off and fail (`packages/core/src/generation/draft.ts:172`). A truncated or malformed model answer is then cached for 24 hours, so every retry replays the same failure (`packages/llm/src/client.ts:261`).
*Done when:* the cap is derived from the requested length, and a failed completion is not cached.

**D4 — English strings are hardcoded inside articles.** Lane D · S
The FAQ heading and the stock and sale phrases are English regardless of the store's language (`packages/core/src/publish/resolve.ts:95-103`).
*Done when:* article-language strings come from the catalogue, and a Hungarian-persona fixture contains no English.

**D5 — A refresh writes a second competing article instead of updating the original.** Lane D · M · invariant 19
A refresh topic runs the ordinary new-article pipeline: a new row, a new slug, a Shopify create under a new marker. The original is neither updated nor retired, and the 60-day cooldown writer has no production caller (`packages/jobs/src/generation/topic-scheduler.ts:132`). This is the product doing to itself what its own cannibalisation check exists to prevent.
*Done when:* a refresh updates the existing article through the two-phase update path.

**D6 — The topic admission gate only runs for topics a merchant adds by hand.** Lane D · S · invariant 6
Automatically scheduled topics skip Gate 1 (`packages/jobs/src/generation/topic-scheduler.ts:69`). The existing-target check is the product's strongest differentiator and most topics bypass it.
*Done when:* every topic passes the same gate, and a test proves an automatically scheduled topic that matches an existing page converts rather than creating.

**D7 — Stores in some countries can never finish onboarding.** Lane B · S
The locale detector accepts countries the search-data provider's location table does not contain (`packages/providers/src/seo/locations.ts:31`).
*Done when:* an unsupported country either maps to a supported one or refuses at claim time with an explanation.

**D8 — Persona is not editable after confirmation.** Lane B · S · spec compliance
The profile refuses edits after confirmation, contradicting main §6.8: "Every section remains editable later from settings."
*Done when:* every profile section is editable from settings.

---

### Phase E — Screens that lie, hang, or lose the merchant's action

All confirmed. Grouped because they are one lane and mostly small. Lane F unless noted.

- **The calendar's previous and next month buttons never load that month's topics.** `packages/ui/src/content/CalendarScreen.tsx:247`.
- **The article review screen never updates after Approve, Discard, Publish anyway or Refresh.** `apps/web/app/(app)/content/articles/[articleId]/page.tsx:41`.
- **"Generate recommendations" leaves the drawer on "generating" forever.** `packages/ui/src/opportunities/OpportunitiesScreen.tsx:197`.
- **A veto is only sent five seconds after the press and is lost if the tab closes.** `packages/ui/src/content/actions.ts:154`. The merchant believes a cancelled article is cancelled.
- **The first-scan waiting screen has no failure or timeout state** and ignores the scan-status route built for it. `packages/ui/src/onboarding/FindingOpportunities.tsx:95`. Combined with B1, a stuck merchant sees a spinner forever.
- **The confirmation screen reports every competitor error as a marketplace blocklist**, fails silently when a keyword cannot be added, and never rolls back a removal. `packages/ui/src/onboarding/ConfirmationSections.tsx:287`.
- **Support, legal and notification links point at pages that do not exist.** `packages/ui/src/onboarding/ConnectDomain.tsx:41`. Shopify's listing requirements need a working privacy and support link.
- **Every article on the Performance screen is permanently "too new to judge"** with its figures hidden. Lane C, `packages/core/src/search/performance.ts:302`.
- **The opportunities list always reports nothing as scheduled**, so a scheduled card shows a Schedule button that answers 409. Lane C, `apps/web/app/api/opportunities/_lib/handlers.ts:152`.
- **Two quick presses of Schedule book two calendar days for one opportunity**, because the route checks and then acts with no lock. Lane C, `handlers.ts:357`, invariant 15.
- **A lapsed subscription is reported to the merchant as "updated by the latest scan".** `packages/ui/src/opportunities/actions.ts:179`.

---

### Phase F — The pilot

This is roadmap step 3, and it is **the largest uncertainty in the whole plan**: nobody has seen what this product writes.

**F1 — First real quality run.** Requires D1–D4 done and an Anthropic key. Run `pnpm eval`, read the articles, fix prompts. Budget for several rounds.
**F2 — Dev store end to end.** Install, token, sync, write permission, two-phase publish, webhook signature, privacy webhooks, billing. This is existing card T10.4, which needs rewriting after the branch merge.
**F3 — One to three friendly real stores**, each on its own custom app. Note that a custom app needs its own credentials per store, and `main` has a single pair — the branch's `shopify.app.toml` does not solve this for custom apps.
**F4 — `shopify.app.toml` push.** Founder task, needs a Shopify login. **No webhook of any kind arrives until this is done**, so catalogue changes reach the product only on the nightly pass.

*Done when:* real articles publish automatically to a real store and their quality has been read by a human.

---

### Phase G — The Shopify App Store rebuild

**Blocked on §3.1. Do not start any card here until the specification and invariants 16 and 21 are amended and the decisions are in `DECISIONS.md`.** Roadmap steps 1, 2, 5, 6, 7, 8, 9, 10. Step 4, the GraphQL client, is done on the branch.

- **G1 — Founder accounts and applications.** 2–4 weeks of waiting, so start on day one: Partner account, app creation, two or three dev stores, the protected-customer-data application, privacy policy and terms, support address, final domain, sending subdomain with SPF, DKIM and DMARC.
- **G2 — Embedded app and sign-in.** L. The largest single item, because what identifies an account changes from the email address to the store. App Bridge, Shopify session tokens, token exchange, frame ancestors, and Search Console's consent opened in a top-level window because Google will not run in a frame.
- **G3 — Shopify billing.** M–L. Plans defined in the Partner Dashboard; Shopify renders the plan picker. A background job writes subscription state to the local table and the entitlement check at dequeue still reads only that — **invariant 16's wording must change first.** Stripe is withdrawn for Shopify stores. Verify at the start whether the active subscription now comes from the Partner API, as the current Shopify documentation says, since the older webhook is being retired.
- **G4 — Install and first-run.** M. Install starts from Shopify; the domain comes from the store's own domain; domain entry, platform detection and the separate Shopify connection step all disappear. Needs a schema wave.
- **G5 — Internal testing on dev stores, listing, submission, review.** Review length is not ours to control.

---

### Phase H — Competitive differentiators

From the competitor research, in its own recommended order. **Every item needs a founder decision from §3.2 first.** Nothing here is a defect; this is product work, and it should not start until Phases A–F are done.

1. **Real product images in articles** (M, schema wave). The sync already fetches them and throws them away. The branch adds a `products` image column, so half the groundwork exists.
2. **Section-by-section product link plan, and a check after generation** (M). The strongest idea in the research, because the competitors demonstrably fail here and we have the pieces: fact sheets, the claim plan, `article_product_refs`, and the third gate. Plan the link per section before writing, verify after writing that each planned link is present, resolvable and in the right section, and fail an article that names catalogue items with zero catalogue links. Plus a hard ban on linking a competitor's product page.
3. **Structured data** (S for export, M with auto-publish). Detect what the theme already emits and add only what is missing — never a second competing article entity.
4. **One-click cancellation** (S, no decision needed). A deep link to the Stripe portal's cancel flow plus a page explaining what happens. Our entitlement is checked server-side at dequeue, so the category's worst complaint cannot happen here; say so.
5. **Name the existing-target check** (S). A competitor turned a weaker version of this into a paid product called Site Guard. Ours is stronger and anonymous.
6. Then: a saved "improvements" filter, a table of contents, draft-by-default when switching to auto-publish, the product card, writing notes, trial and pricing, and the preview with a real opportunity.

**Explicitly not doing**, per the research and the specification: link exchange ever, AI-generated images, a full site audit report, an in-app editor, denominators in counts, LLM-written explanations, theme modification or redirects, multi-site agency mode, and model downgrading under load.

---

## 5. The finding ledger

106 confirmed defects. Eleven were reproduced by running the app; ninety-five came from the code review, each confirmed by a second independent reviewer. Ten further claims were refuted and are not listed. Thirteen are fixed by the unmerged branch.

Markers: **`branch-fixed`** — fixed by `shopify-hardening`, verify after merge and close. **`branch-touched`** — the branch rewrote this file but did not fix this; re-confirm against merged `main` before carding.

### 5.1 Reproduced by running the app

| Sev | What a person sees | Where | Phase |
|---|---|---|---|
| critical | Onboarding stops at the first step and the screen says it will retry | `apps/web/app/api/domain/_lib/store.ts:158` | B1 |
| critical | Platform detection fails on any store with a home page over 600 KB | `packages/jobs/src/ingestion/steps.ts:170` | B2 |
| critical | The public preview returns a 500 before reaching any vendor | `apps/web/app/api/preview/_lib/config.ts:93` | B3 |
| high | Every app screen renders without a signed-in session | `apps/web/app/(app)/_lib/shell-state.ts` | B4 |
| config | The Stripe price ids in .env are literal amounts, not price ids | `(.env)` | B7 |
| medium | The Opportunities nav item spins forever for every merchant | `packages/core/src/account/view.ts:78` | E |
| medium | The timezone dropdown breaks hydration on the Publishing settings screen | `packages/ui/src/settings/settings.ts:93` | E |
| medium | Settings accepts any timezone or language string and silently falls back to UTC | `apps/web/app/api/settings/_lib/handlers.ts:98` | E |
| medium | Checkout returns a bare 500 when Stripe rejects the request | `apps/web/app/api/billing/_lib/handlers.ts:119` | B7 |
| low | The dev seed reports 40 products and inserts none | `packages/db/src/seed.ts:59` | F2 |
| low | Calendar accepts an inverted date range; Connections screen contradicts itself; Turnstile key not valid on localhost | `various` | E |

### 5.2 Fixed by the unmerged branch — verify after Phase A, then close

| Sev | Finding | Where |
|---|---|---|
| high | Shopify webhook deliveries that fail once are marked processed and never retried | `packages/jobs/src/ingestion/webhooks.ts:111` |
| high | Shopify OAuth callback runs the whole onboarding pipeline inline while the browser waits | `apps/web/app/api/shopify/_lib/config.ts:283` |
| high | Both Shopify OAuth callbacks store a bare access token with no expiry or refresh token, which the app's token type expires after one hour | `apps/web/app/api/shopify/_lib/handlers.ts:149` |
| high | Any Shopify 403 is treated as a dead token, so a permission refusal on orders disconnects the whole store | `packages/providers/src/shopify/admin.ts:144` |
| high | A store that has granted publishing can never reconnect: the install callback rejects its token for carrying write_content | `packages/core/src/catalog/scopes.ts:43` |
| high | Article updates re-send the marker metafield without its id; Shopify rejects a duplicate namespace+key with 422 | `packages/providers/src/shopify/publish.ts:420` |
| medium | Daily landing-revenue sweep overwrites each day's takings with a partial-day count | `packages/jobs/src/ingestion/sweep.ts:272` |
| medium | A product whose metafield read failed once is never asked for its metafields again | `packages/jobs/src/ingestion/catalog.ts:395` |
| medium | Revision (republish) claims can never be re-executed by the recovery sweep; every interrupted repair ends in a dead letter | `packages/jobs/src/publish/recovery.ts:172` |
| medium | Recovery of an interrupted article update can never succeed: it re-opens a claim that already exists | `packages/jobs/src/publish/recovery.ts:131` |
| medium | Order window is 90 days but the requested permission only lets Shopify return 60 | `packages/core/src/catalog/orders.ts:21` |
| medium | Pinned Shopify API version 2025-01 is long retired; every REST call now runs against whatever version Shopify substitutes | `packages/providers/src/shopify/oauth.ts:22` |
| low | Publishing-grant callback does not catch a failed code exchange, so a reused or expired Shopify code yields a raw 500 page | `apps/web/app/api/publish/_lib/handlers.ts:140` |

### 5.3 Open — the 82 still to fix

Grouped by the seam that found them. Severity is what a merchant or operator experiences.


**Boot, configuration and job wiring** (10)

| Sev | Finding | Where |
|---|---|---|
| high | The minute-by-minute email drain resets a failing email's retry counter, so it never dead-letters (inv 18) | `packages/jobs/src/notify/send-worker.ts:76` |
| high | The queued Stripe drain job is registered but nothing ever enqueues it; webhook processing is a fire-and-forget promise inside the web request (inv 16) | `apps/web/app/api/webhooks/stripe/_lib/tasks.ts:35` |
| high | The production start command runs 'next start' from the repo root, where there is no build | `railway.toml:38` |
| medium | The global pause switch exempts the email drain but not the job that actually sends, so no mail goes out while paused | `packages/jobs/src/runtime/gate.ts:206` |
| medium | When search-data spending is paused, every keyword-pricing job fails instead of stopping quietly (inv 18) | `packages/jobs/src/ingestion/enrich.ts:177` |
| medium | The weekly intent-gap comparison is registered but nothing schedules or enqueues it | `packages/jobs/src/optimize/intent-gap-tasks.ts:139` |
| low | Blank Shopify credentials fake only the consent step; every later Shopify read goes to the real Shopify with a fake token **`branch-touched`** | `apps/web/app/api/shopify/_lib/config.ts:108` |
| low | A store that is busy at 05:30 UTC silently loses that day's landing-page revenue **`branch-touched`** | `packages/jobs/src/ingestion/sweep.ts:416` |
| low | Ten separate PostHog clients exist per process; shutdown flushes only one **`branch-touched`** | `apps/web/instrumentation-node.ts:30` |
| low | A blank SHOPIFY_CLIENT_SECRET makes the OAuth state signing key the empty string **`branch-touched`** | `apps/web/app/api/shopify/_lib/config.ts:120` |

**Screens and the API contract** (10)

| Sev | Finding | Where |
|---|---|---|
| high | Search Console connect never reaches the property picker, so the connection can never be completed | `apps/web/app/api/gsc/_lib/config.ts:33` |
| high | Every sign-in lands on the plan page with a live Subscribe button, and checkout does not refuse an already-subscribed account (inv 16) | `packages/ui/src/public/signin-exchange.ts:33` |
| high | Calendar previous/next month buttons never load that month's topics | `packages/ui/src/content/CalendarScreen.tsx:247` |
| medium | Article review screen never updates after Approve / Discard / Publish anyway / Refresh | `apps/web/app/(app)/content/articles/[articleId]/page.tsx:41` |
| medium | 'Generate recommendations' leaves the drawer on 'generating' forever | `packages/ui/src/opportunities/OpportunitiesScreen.tsx:197` |
| medium | A veto is only sent 5 seconds after the press, and is lost if the tab closes or reloads first (inv 15) | `packages/ui/src/content/actions.ts:154` |
| medium | Confirmation screen: competitor errors are all shown as 'marketplace blocklist', keyword add fails silently, removals are never rolled back | `packages/ui/src/onboarding/ConfirmationSections.tsx:287` |
| medium | First-scan waiting screen has no failure or timeout state and ignores the scan-status route built for it | `packages/ui/src/onboarding/FindingOpportunities.tsx:95` |
| medium | Support, legal and notification links point at pages that do not exist | `packages/ui/src/onboarding/ConnectDomain.tsx:41` |
| low | A lapsed subscription (402) is reported as 'updated by the latest scan' or 'changed while you had the page open' | `packages/ui/src/opportunities/actions.ts:179` |

**Catalogue ingestion jobs** (7)

| Sev | Finding | Where |
|---|---|---|
| high | Catalogue walk and distillation budget hand-offs consume the step's retry budget, so large stores can never finish onboarding **`branch-touched`** | `packages/jobs/src/ingestion/catalog.ts:281` |
| medium | Every catalogue-change drain chain ends in a job that fails the per-account lock check | `packages/jobs/src/inventory/drain.ts:111` |
| medium | Change-stream cursor is lost on every webhook, so each merchant edit re-reads up to 30 days of changes and re-syncs every page they touched | `packages/jobs/src/inventory/drain.ts:72` |
| medium | oauth_wait and awaiting_confirmation have no lease but never actually wait in 'running', so a crash mid-step strands the run forever | `packages/jobs/src/runtime/lease.ts:34` |
| low | GSC history import recomputes its chunk boundaries from 'today' on every chunk, so crossing midnight restarts the import | `packages/jobs/src/gsc/backfill.ts:71` |
| low | Nightly sweep records a brand-new deletion for every already-deleted product every night, permanently inflating the 'webhooks are failing' metric **`branch-touched`** | `packages/jobs/src/ingestion/sweep.ts:244` |
| low | A shutdown during SERP reads makes the keywords step succeed with partial data and records it as complete | `packages/jobs/src/ingestion/keywords.ts:427` |

**Database, migrations and repositories** (7)

| Sev | Finding | Where |
|---|---|---|
| high | Search Console rows are written in one giant INSERT with no chunking, which Postgres rejects past about 7,000 rows | `packages/db/src/repositories/search.ts:145` |
| high | Manually adding a topic for a keyword that already has an open opportunity crashes on the dedupe index (inv 10) | `packages/db/src/repositories/opportunities.ts:728` |
| medium | Manual topic add writes the opportunity and the topic in separate statements, so a failed topic insert strands an open opportunity (inv 15) | `packages/jobs/src/generation/admit-manual-topic.ts:180` |
| medium | Database constraint violations are never translated, so day collisions and duplicate inserts surface as 500s instead of the promised 409 (inv 15) | `packages/db/src/repositories/topics.ts:296` |
| low | Migration 0013 adds the one-topic-per-day constraint without cleaning existing data, so it fails on any database that already holds two non-vetoed topics on a day (inv 14) | `packages/db/migrations/0013_t_wave7_publish_attempts_one_topic_a_day_and_gate_rules_version.sql:41` |
| low | Auto-publish can be switched on against a Shopify connection that is already marked lost, and survives a reconnect that drops the write permission (inv 21) **`branch-touched`** | `packages/db/src/repositories/publishing.ts:140` |
| low | Several repository methods accept an account scope but never use it in the WHERE clause | `packages/db/src/repositories/article-claims.ts:40` |

**State machines** (7)

| Sev | Finding | Where |
|---|---|---|
| medium | An abandoned interrupted writing run leaves its calendar day stuck in 'generating' for ever (inv 15) | `packages/jobs/src/generation/stranded-sweep.ts:93` |
| medium | A suggestion whose article is refused by the quality gate (or discarded in review) stays 'scheduled' for ever (inv 10) | `packages/jobs/src/generation/generate-article.ts:414` |
| medium | A veto landing between 'pick the article' and 'claim the publish' still publishes the article to the merchant's store (inv 15) **`branch-touched`** | `packages/jobs/src/publish/auto-publish.ts:317` |
| medium | Veto during the first minute of writing still produces a 'draft ready for review' on the cancelled day (inv 15) | `packages/jobs/src/generation/daily-cycle.ts:268` |
| low | Calendar fill claims the suggestion before placing it; any failure in between strands it as 'scheduled' with no calendar day (inv 15) | `packages/jobs/src/generation/replenish.ts:229` |
| low | A calendar day can hold several articles, but every reader takes an arbitrary one | `packages/db/src/repositories/articles.ts:309` |
| low | Moving a topic onto a day that was filled a moment earlier answers 500, not the 409 conflict code (inv 15) | `packages/jobs/src/generation/move-topic.ts:45` |

**Core domain and the model client** (7)

| Sev | Finding | Where |
|---|---|---|
| high | Stripe events that can never be resolved pile up at the front of the queue until billing stops processing anything (inv 16) | `packages/core/src/billing/processing.ts:424` |
| high | A cut-off or malformed model answer is cached for 24 hours, so every retry of the step replays the same failure (inv 20) | `packages/llm/src/client.ts:261` |
| high | Article writing is capped at 4,000 output tokens while the requested length has no upper bound, so long or non-English articles are cut off and fail | `packages/core/src/generation/draft.ts:172` |
| high | Stores in countries the locale detector accepts but the search-data table lacks can never finish onboarding | `packages/providers/src/seo/locations.ts:31` |
| medium | An event about a merchant's old or abandoned Stripe subscription overwrites their live one, and the nightly repair then keeps it wrong (inv 16) | `packages/core/src/billing/processing.ts:213` |
| medium | The 'spending far more than normal' brake pauses healthy stores whose typical day is a few tenths of a cent (inv 17) | `packages/core/src/ops/spend-caps.ts:167` |
| low | Keyword cleaning does not apply the search-volume vendor's own keyword rules, so one bad term can fail the whole paid batch | `packages/core/src/keywords/validate.ts:96` |

**Scan, optimize and learning jobs** (6)

| Sev | Finding | Where |
|---|---|---|
| high | Global DataForSEO spend cap does not stop the scan's SERP purchases (inv 17) | `packages/jobs/src/scan/assemble.ts:521` |
| high | Competitor-gap OPTIMIZE rows carry a keyword as their entity and can never be generated | `packages/core/src/opportunities/action-selection.ts:156` |
| low | Intent-gap paid pass has no billing, vacation or deletion gate (inv 16) | `packages/jobs/src/optimize/intent-gap-pass.ts:84` |
| low | Task checklist is lost if the scan dies between the opportunity upsert and the task insert (inv 18) | `packages/jobs/src/scan/run.ts:410` |
| low | Standard-curve fallback is stored and then re-read as a fitted curve | `packages/jobs/src/scan/ctr-curve.ts:97` |
| low | A paused or skipped OPTIMIZE generation promotes a 'new' row to 'accepted' (inv 15) | `packages/jobs/src/optimize/generate.ts:212` |

**Writing and publishing jobs** (6)

| Sev | Finding | Where |
|---|---|---|
| high | An abandoned publish claim permanently blocks every later auto-publish for the account (inv 19) **`branch-touched`** | `packages/jobs/src/publish/auto-publish.ts:403` |
| high | Auto-published article body is Markdown wrapped in <p> tags, not HTML | `packages/core/src/publish/bundle.ts:168` |
| high | A REFRESH of our own article writes and auto-publishes a brand-new competing article instead of updating the original (inv 6) | `packages/jobs/src/generation/topic-scheduler.ts:132` |
| medium | Recovery sweep posts to Shopify for a store that has since switched delivery back to export (inv 21) **`branch-touched`** | `packages/jobs/src/publish/recovery.ts:218` |
| medium | After a Gate 3 repair, product references are not re-synced to the repaired body | `packages/jobs/src/generation/generate-article.ts:366` |
| medium | A crash between the Shopify post and the day's ledger write can deliver two articles in one day on retry (inv 14) **`branch-touched`** | `packages/jobs/src/publish/deliver.ts:190` |

**Invariants not actually enforced** (6)

| Sev | Finding | Where |
|---|---|---|
| high | A job that arrives while work is paused is thrown away, not held (inv 22) | `packages/jobs/src/runtime/gate.ts:281` |
| high | The DataForSEO daily spend cap only stops keyword enrichment; every other paid search-data read keeps spending (inv 17) | `packages/jobs/src/sweeps/spend-caps.ts:135` |
| medium | Every article on the Performance screen is permanently 'too new to judge' with its figures hidden (inv 13) | `packages/core/src/search/performance.ts:302` |
| medium | Gate 1 (topic admission) only runs for topics a merchant adds by hand; automatically scheduled topics skip it (inv 6) | `packages/jobs/src/generation/topic-scheduler.ts:69` |
| low | The rule that override-published articles are kept out of calibration data is enforced only by a function nothing calls (inv 12) | `packages/db/src/repositories/gate-decisions.ts:222` |
| low | The test that proves nothing imports the preview cannot see imports through the core package's front door (inv 2) | `packages/core/src/preview/disposable.test.ts:43` |

**Vendor adapters** (5)

| Sev | Finding | Where |
|---|---|---|
| high | Network failures and Resend 5xx are classified non-retryable, so a blip permanently drops the email | `packages/providers/src/email/index.ts:71` |
| medium | DataForSEO error answers are cached for 24 hours, so a 'retryable' failure can never succeed on retry (inv 20) | `packages/providers/src/seo/index.ts:213` |
| medium | A Google quota 403 is treated as a revoked Search Console grant and kills the connection | `packages/providers/src/gsc/client.ts:301` |
| medium | Checkout idempotency key ignores the inputs that change, so a second checkout within 24h can be refused by Stripe (inv 18) | `packages/core/src/billing/checkout.ts:61` |
| low | Keyword difficulty is always empty in production: 'competition' is a string on the endpoint actually called | `packages/providers/src/seo/index.ts:382` |

**Public, auth and billing routes** (4)

| Sev | Finding | Where |
|---|---|---|
| high | Deleting an account can leave its Stripe subscription running forever (inv 16) | `apps/web/app/api/account/delete/_lib/handler.ts:52` |
| low | A deleted account can sign back in and reach every scoped route except /api/account and billing | `apps/web/app/api/auth/_lib/adapter.ts:95` |
| low | Settings PATCH writes the first half of the body, then rejects the request with 422 | `apps/web/app/api/settings/_lib/handlers.ts:142` |
| low | Billing routes answer 500 instead of 503 when STRIPE_SECRET_KEY is unset | `apps/web/app/api/billing/_lib/handlers.ts:119` |

**Product routes** (4)

| Sev | Finding | Where |
|---|---|---|
| medium | Opportunities list always sends scheduledFor: null, so the card shows a Schedule button that 409s once the topic is on the calendar | `apps/web/app/api/opportunities/_lib/handlers.ts:152` |
| medium | Schedule route is check-then-act: two concurrent presses book two calendar days for one opportunity, or one of them crashes on the day-exclusion constraint (inv 15) | `apps/web/app/api/opportunities/_lib/handlers.ts:357` |
| low | "Date in the past" check for manual topic add uses the UTC calendar day, not the store's timezone | `apps/web/app/api/calendar/topics/_lib/add.ts:59` |
| low | SSE progress streams can throw inside a timer with no handler when the client disconnects mid-tick or the DB read fails | `apps/web/app/api/ingestion/_lib/handlers.ts:94` |

**Webhooks and OAuth receivers** (3)

| Sev | Finding | Where |
|---|---|---|
| high | Stripe events arriving during an in-flight drain stay unprocessed until some unrelated webhook arrives (inv 16) | `apps/web/app/api/webhooks/stripe/_lib/receiver.ts:105` |
| medium | GSC OAuth callback returns a raw 500 when Google refuses the code exchange | `apps/web/app/api/gsc/_lib/handlers.ts:72` |
| low | email_send_state 'delivered' exists in the schema and type but nothing ever writes it | `apps/web/app/api/webhooks/resend/_lib/receiver.ts:85` |

---

## 6. How to know a phase is finished

The gate is eleven commands, run one at a time, never chained (`pnpm test` and `pnpm lint:prove` share a fixture):

```
lint · lint:prove · typecheck · test · contracts:check · build · smoke:boot · smoke:dev · chaos · env:check · stubs:report
```

Plus `db:migrate` against a freshly created empty database whenever migrations change, and `pnpm build` again after `smoke:dev`, which replaces the production build.

Two things the gate does not cover, and both matter more than anything it does:

- **`pnpm eval` has never run.** It grades what gets written into merchants' stores. Phase D2 exists to make it run. Until it does, no prompt change has been checked by anything.
- **The gate has never started the app and used it.** Every critical finding in §5.1 was found by doing that and none by the gate. `smoke:boot` asks for the landing page and the health check only. After each phase, run the app and walk the journey the phase touched.

A closing warning from the last integrator's notes, which this bug hunt confirmed seven times over: **the mechanism that tells you whether something is finished is often the broken thing, and it always fails reassuringly.** A registered job nothing enqueues, a retry nothing fires, a cap that counts one of six spenders, a test asserting a function no caller reaches. When something reports success, check that it did the work.

