# Sortiva — Tech Spec

Third document of the set. `sortiva-spec.md` ("main spec") owns product behavior and pipeline logic — including the Opportunity Engine (main §7), existing-page optimization (main §10) and the light technical layer (main §11); `sortiva-ui-spec.md` ("UI spec") owns surfaces and states. This document owns the engineering systems both imply but neither specs: the **notification system** (the immediate reason this doc exists — the UI spec's bell, attention list, and email matrix had no backing spec), realtime delivery, email infrastructure, the architecture and stack, API conventions, and secrets/encryption. Where the main spec already specifies mechanics (idempotency §14.3, observability §14.7), this doc maps them onto components rather than restating them.

---

## 1. Notification system

### 1.1 Two kinds, deliberately different mechanics

The UI spec surfaces two things that look similar and must not be built the same way:

1. **Event notifications (the bell):** "something happened" — article published, draft ready, topic held by quality bar, connection lost. These are **append-only records** written at the moment the domain event occurs. They have read/unread state and never change after creation.
2. **Attention items (the dashboard attention list):** "something needs you" — draft awaiting review, repair card pending, export URL unconfirmed. These are **not stored notifications at all** — they are a live query over underlying state (`articles.state = 'in_review'`, open repair flags, `published_url IS NULL` past 7 days). Consequence: they self-clear the instant the underlying condition resolves, with no "mark as done" bookkeeping, no stale reminders, and no sync bugs between the reminder and the thing it reminds about.

Rule of thumb enforced in review: **if it can become stale, it must be a query; if it's history, it's a record.** A notification that "the draft is ready" (event, record) can coexist with the attention item "1 draft awaiting review" (state, query); the former stays in the bell history after approval, the latter disappears.

### 1.2 Event notification model

```
notifications   id, account_id, type, payload_json, created_at,
                read_at?, seen_at?
                -- append-only; pruned after 90 days (§1.7)
```

- `type` is a closed enum matching the UI spec §10 matrix rows: `ingestion_review_ready`, `opportunities_ready` *(the activation moment, main §6.9)*, `new_opportunities_found` *(weekly scan; dedupe key = scan week)*, `optimize_recommendation_ready`, `merchant_task_created` *(HOLD)*, `article_published`, `draft_ready_for_review`, `topic_held_by_gate`, `repair_needed`, `connection_lost_shopify`, `connection_lost_gsc`, `payment_failed`, `monthly_summary_ready`, `export_url_reminder`, `oauth_reminder`. Adding a type is a code change (enum + template + matrix row), never dynamic.
- `payload_json` holds **references only** (topic_id, article_id, gate_decision_id, opportunity_id, signal_run_id) — render-time lookups produce the display text, so copy fixes and localization never require touching stored rows, and a referenced entity that was deleted renders a graceful generic line instead of stale text.
- `seen_at` (badge cleared by opening the bell) vs `read_at` (item clicked) — the standard two-tier unread model.
- **Producers:** notifications are written by our pipeline code at the same emission points as the PostHog events (main spec §14.7), inside the same transaction as the state change where one exists (e.g. `topic_held_by_gate` commits with the `gate_decisions` row). PostHog is never the source — telemetry is not the control plane (main spec §14.7 boundary), and a sampled/delayed analytics pipeline must not decide whether a user gets told their connection broke.
- **Idempotency:** unique key `(account_id, type, dedupe_key)` where `dedupe_key` is type-specific (`article_id` for publishes, `topic_id` for gate holds, `opportunity_id` for recommendations and merchant tasks, ISO week for weekly scans, date for summaries). At-least-once workers (main spec §14.3) may attempt duplicate inserts; the constraint makes the second a no-op. This is what prevents a retried publish job from ringing the bell twice.

### 1.3 Channel fan-out

One domain event → up to two channels, resolved per the UI spec §10 matrix + user preferences:

```
event occurs → write `notifications` row (in-app, always for matrix ✔ rows)
             → enqueue `email_sends` row if (matrix says email) AND
               (category not user-disabled) AND (not suppressed §1.5)
```

Preferences live in `account_settings` extension:

```
notification_prefs  account_id (pk), email_article_published (default off),
                    email_digest_frequency (off | daily | weekly, default off),
                    updated_at
```

Only the matrix's opt-in rows get preference toggles; transactional/pipeline-stopping categories (connection lost, review ready, repair needed) are not toggleable — the matrix's "not toggleable" column is enforced in code by simply not reading a preference for those types.

### 1.4 Email pipeline

```
email_sends     id, account_id, type, dedupe_key, template_version,
                state (queued | sent | failed | suppressed),
                provider_message_id?, queued_at, sent_at?, last_error?
                -- unique (account_id, type, dedupe_key)
```

- **Provider: Resend (decided).** All email goes through Resend, still wrapped in a thin `EmailProvider` interface (same posture as `SeoDataProvider`, main spec §12.1) so the send worker and tests never touch the SDK directly — but Resend is the committed vendor, not a placeholder. Setup requirements: sending domain verified with SPF + DKIM + DMARC before the first production send; a dedicated subdomain for sending (e.g. `mail.<ourdomain>`) so product email reputation is isolated from the root domain; Resend's **idempotency-key header set to our `(account_id, type, dedupe_key)`** on every send, giving provider-side dedupe on top of our DB unique constraint (§1.4); webhook endpoint (`/api/webhooks/resend`) with signature verification consuming `bounced`/`complained` events into `email_suppressions` (§1.5) and `delivered` into `email_sends` state. Templates are **React Email** components (Resend's native pairing), versioned in the repo per §1.4. Free tier (3k emails/mo) covers early volume — consistent with the §2.1 cost posture; the send worker rate-limits to Resend's plan limits and treats 429s as retryable per main-spec §14.3.5.
- **Templates versioned in the repo** (React Email source), `template_version` stamped on every send — same reproducibility posture as prompts (main spec §14.2). Template copy rules inherited from product decisions: the monthly summary template **must not contain denominators or targets** (main spec §8.6), and the OAuth reminder must restate the read-only trust copy (main spec §6.2).
- **Send worker:** drains `queued` rows, calls the provider, writes `provider_message_id`, retries per main-spec §14.3.5 (3 attempts, backoff, then `failed` + DLQ). The unique constraint above is the exactly-once-send guarantee under at-least-once workers.
- **Scheduled emails:** the monthly summary is generated by a job on the 1st at 08:00 persona-country time (main spec clock), assembling from `articles` + `gate_decisions` + `opportunities` (what Sortiva did across action types, what it held back, the top open opportunities for next month — main §8.6) for the prior month; `dedupe_key = YYYY-MM`. The 24h OAuth reminder and 7d export-URL reminder are swept hourly (query accounts in the qualifying state longer than the threshold, insert with the account+threshold as dedupe key — the sweep is idempotent, re-running never double-sends).

### 1.5 Suppression & compliance

- Resend bounce/complaint webhooks (§1.4) → `email_suppressions (email, reason, created_at)`; suppressed addresses skip the queue (`state = suppressed`) except for account-security email (deletion confirmation).
- Every non-transactional email carries a one-click unsubscribe (List-Unsubscribe header + link) that flips the corresponding preference — required by Gmail/Yahoo bulk-sender rules, and just correct.
- Account deletion (main spec §14.6) cascades: notifications and email_sends hard-deleted with the account.

### 1.6 Realtime delivery to the UI

- **Bell badge & list:** polling, 30s interval, `GET /api/notifications?since=` returning unseen count + recent items. Polling is deliberately chosen over websockets for v1 — the freshest thing in this product moves once a day; 30s staleness on a badge is invisible, and it removes an entire infrastructure class.
- **Ingestion progress** (UI spec §3.2) is the one genuinely live surface: **SSE** endpoint streaming `job_steps` transitions for the active ingestion run, falling back to 5s polling if the SSE connection drops. SSE not websockets: one-directional, plays through proxies, nothing to scale.
- Calendar/articles pages revalidate on focus + after any mutation (standard SWR-style), no push.

### 1.7 Retention

`notifications` pruned at 90 days (they're history, not records of legal significance); `email_sends` kept 12 months (deliverability debugging + audit); both jobs are idempotent sweeps.

---

## 2. Architecture & stack (proposed defaults — swappable, but pick once)

**Shape: a modular monolith, one Postgres, deployed on Railway (§2.1).** The main spec's mechanics (advisory locks §14.3.3, guarded transitions §14.3.1, transactional claims §5) all assume a single relational database at the center; honoring that is the architecture. No microservices — the coordination cost would exceed the product.

- **App:** TypeScript, Next.js (App Router) serving the UI and the API routes. One deployable.
- **Worker:** same codebase, Graphile Worker runtime. See §2.1 for how it's deployed — **in-process with the web server in v1** (cost), splittable to its own service later.
- **Database: Postgres 16** — Railway's Postgres service with a volume. Everything in the main-spec data model, plus the queue itself.
- **Job queue: Graphile Worker** (Postgres-backed). Chosen specifically because main-spec §14.3 needs jobs, steps, and business state in **one transaction** (e.g. publish intent + article state + job completion commit atomically) — an external broker (SQS/Redis) reintroduces the dual-write problem §14.3 exists to kill. Cron-style schedules (daily generation, weekly refresh scan, sweeps) via Graphile's crontab.
- **Rules/config layer**: `signals.config.yaml` (main §7.10) lives in the repo next to the prompt files, is schema-validated at worker start, and its content hash is the `rules_version` stamped on every opportunity and gate decision. Loaded once per process; no DB lookup in the hot path. A lint rule bans numeric comparisons against GSC/volume/position fields outside the `rules` module.
- **Single outbound page fetcher**: one SSRF-guarded HTTP client (same budget and private-IP blocking as the preview endpoint, main §3.2) serves every non-API page fetch — persona homepage/about, top-SERP competitor content for the Gate 3 judge and intent-gap analysis (main §10.3). There is **no crawler in V1** (main §12.3); the Shopify content inventory comes from the Admin API. The P1 internal-link crawler, when built, is a job using this same client with a per-domain politeness budget.
- **Scheduled jobs (Graphile crontab)**: daily generation cycle; daily reconciliation sweep (now also syncs the **content inventory**, main §12.3); daily **GSC page × query sync**; **weekly signal scan** (Mondays, persona clock — replaces the weekly refresh scan); monthly replenishment; publish-intent recovery sweeper; retention sweep; **weekly CTR-curve refit**; **daily landing-revenue aggregation** (capture only, main §17.3).
- **No Redis in v1.** The request cache (main spec §14.3.6) and preview cache are Postgres tables — at this product's QPS, Postgres is the cache, and one fewer metered service.
- **LLM access:** the single instrumented Anthropic client wrapper (main spec §14.7) lives in a shared package; lint rule bans importing the raw SDK anywhere else.
- **Frontend state:** server components + a fetch/SWR layer; no global client store. The calendar's drag interactions are the only rich-client island.

### 2.1 Deployment target: Railway (hard constraint — and it must be cheap)

Railway bills a plan minimum ($5 Hobby / $20 Pro, each including that much usage credit) plus metered usage: roughly **$10/GB RAM-month, $20/vCPU-month, ~$0.05/GB egress** — resident memory is billed while a service runs, whether or not it's busy. Every topology choice below follows from that meter.

**v1 topology — two Railway services, that's all:**

| Service | What runs | Size target | Est. cost |
|---|---|---|---|
| `app` | Next.js **+ Graphile Worker in-process** (same Node process, worker started alongside the server) | 512 MB RAM, shared vCPU | ~$5–7/mo |
| `postgres` | Railway Postgres + volume | 256–512 MB RAM, ≤1 GB volume initially | ~$4–6/mo |

Target: **~$10–15/month total** at early scale on the Hobby plan, moving to Pro (whose $20 includes $20 of usage) as accounts grow.

**Why in-process worker is safe for us specifically:** normally embedding the worker in the web process is frowned on because deploys and crashes kill running jobs. Our spec already made that a non-event — every step is resumable, checkpointed, and effectively-once (main spec §14.3), and the nightly chaos test (§14.3.9) *proves* interrupted jobs converge. Railway sends SIGTERM with a grace period on deploy; Graphile Worker drains gracefully, and anything that doesn't finish resumes idempotently. The split to a dedicated `worker` service is a config change (same image, different start command) — do it when job load visibly contends with request latency, not before. This is the §14.3 investment paying a cash dividend.

**Cost disciplines (each one is a rule, not a hope):**

- **Never proxy or store product images.** Articles hotlink Shopify CDN URLs (`cdn.shopify.com`) — zero egress, zero storage on our side. The export bundle contains URLs, not image bytes.
- **Stream, don't hold.** Catalog sync writes page-by-page to Postgres (already required by §14.3.4 checkpointing); nothing loads a 500-product catalog into memory. Node runs with `--max-old-space-size` pinned ~384 MB so a leak OOMs loudly instead of silently billing a swollen resident set.
- **Postgres stays small.** `raw_body_html` is compressed (it's quarantined anyway — main spec §6.3); `gsc_daily` keeps 16 months then rolls up to monthly aggregates; `gsc_query_daily` is capped per day by the API `rowLimit` (top rows by impressions), kept 16 months, then rolled up to monthly page × query aggregates; `store_pages.body_ref` is compressed like `raw_body_html`; `serp_snapshots` and `optimize_recommendations` expire on TTL / supersession; `webhook_events` payloads pruned at 30 days, `notifications` at 90 days (§1.7), `request_cache` rows expire on TTL. A retention sweep job owns all of this. Volume growth is a monitored number, not a surprise.
- **Egress is naturally tiny** (HTML pages, JSON API responses, outbound API calls) — the image rule above is what keeps it that way.
- **No always-on staging.** Staging is a Railway environment deployed on demand (PR environments or manual), torn down after; only prod runs 24/7. Postgres for staging is seeded, disposable, and small.
- **The free tiers around us do real work:** Turnstile (free), PostHog Cloud (generous free event tier — and our event taxonomy is lifecycle-moment-based, not per-request, precisely so volume stays low), Resend's free tier covers early email volume.
- Railway's usage dashboard is checked weekly until costs stabilize; a Railway spend alert is set at 2× the expected bill. (This is infra spend — separate from the product's LLM/DataForSEO cost tracking in PostHog, main spec §14.7.)

**What we deliberately don't do on Railway:** scale-to-zero on the `app` service (the preview endpoint is the public funnel — a cold start on the landing page kills the lure, and the in-process worker needs its cron ticks), and no CDN/edge tier in v1 (Next.js static assets served from the app service are fine at this traffic; add a CDN when egress says so, not before).

## 3. API conventions

- All routes under `/api/*`, JSON, session-cookie auth (the auth provider from main spec §4.1; propose Auth.js). Every authenticated route resolves `account_id` from session — never from the request body.
- **Authorization is trivial by construction:** one account, one domain, no teams (main spec §18) — every query is `WHERE account_id = session.account_id`, enforced by a repository layer that requires the account scope parameter (no raw table access from route handlers).
- Mutations that map to guarded transitions (veto, approve, pin, confirm profile, opportunity accept/dismiss/schedule, mark-applied) return `409` when the guard fails ("this topic already started generating") with a machine-readable `code` the UI maps to its state-conflict toasts.
- Public endpoints (`/api/preview`) are the only unauthenticated surface; Turnstile verification middleware sits in front (main spec §3.2).
- Webhook receivers (`/api/webhooks/shopify/*`) verify HMAC before touching the body, insert-or-ignore into `webhook_events`, return 200 — all processing async (main spec §14.1/§14.3.8).
- **Stripe** (`/api/webhooks/stripe`): signature verification (`stripe.webhooks.constructEvent`), insert-or-ignore into `stripe_events` by event ID, 200 immediately, async processing — same pattern. The subscription-status worker is the **single writer** of `subscriptions.status`; nothing else mutates it. Entitlement checks read the local row only — no Stripe API call ever sits in a request path or the scheduler. Nightly reconciliation job re-fetches any subscription whose `synced_at` is >24h stale. Stripe runs in test mode in dev/staging (test-clock fixtures for renewal and dunning scenarios); live keys exist only in prod's secret store. Checkout and Customer Portal are the only payment surfaces — no Stripe Elements, no card forms (main spec §4.2).

## 4. Secrets & encryption

- **Token encryption at rest** (Shopify, Google — main spec §6.2/§12.2): application-layer envelope encryption — per-row data key, wrapped by a master key in the platform KMS (or `age` key in the deploy secret store for v1). Decryption only in the worker/API process at point of use; tokens never appear in logs, PostHog events, or error reports (scrubber on the exception path).
- App secrets via the host's secret store; no secrets in the repo; `.env.example` documents every required variable.
- Postgres encrypted at rest by the host; TLS everywhere in transit.

## 5. Environments & delivery

- `dev` (local: docker-compose Postgres + a Shopify dev store) / `staging` / `prod`, all as Railway environments of one project. **Staging is on-demand, not always-on** (§2.1 cost discipline): spun up for PR review or pre-release runs against a dev store with mock DataForSEO (the `SeoDataProvider` test double), torn down after. Real DataForSEO spend only in prod.
- CI gates on every merge: typecheck, unit + integration tests, the **prompt eval suite** (main spec §14.2) when prompts/models changed, the **signal-detection fixture suite** *(main §7.8 examples 1–8 over synthetic GSC/catalog fixtures)* when `signals.config.yaml` or the rules module changed, the **chaos test** (main spec §14.3.9) nightly, and the **PostHog provisioning script** in check mode (drift between repo definitions and the live project fails the build — main spec §14.7 dashboards-as-code).
- Migrations forward-only, applied on deploy before the new code serves traffic; every schema change ships with its down-path documented even if not automated.

## 6. Testing strategy (mapping, not invention)

| What | How | Owner spec |
|---|---|---|
| Gate thresholds & scoring rules | pure-function unit tests (no LLM) | main §8, §9.6 |
| Prompt behavior | frozen eval sets in CI | main §14.2 |
| Crash safety / exactly-once publish | nightly chaos test | main §14.3.9 |
| Customer-field stripping | assertion test on order ingestion | main §6.2/§14.6 |
| Notification dedupe | unique-constraint conflict tests per type | this doc §1.2 |
| Email matrix ↔ preferences | table-driven test over the UI spec §10 matrix | UI spec §10 |
| UI flows (onboarding, calendar ops, review, override) | Playwright against staging | UI spec |
| Shopify integration | dev-store smoke suite (OAuth, sync, two-phase publish, webhook HMAC, content-inventory sync) | main §6.2, §14.3.7, §12.3 |
| Signal detection & action selection | fixture-driven unit tests over synthetic GSC + catalog data; the eight worked examples are the acceptance fixtures | main §7.3, §7.8 |
| Existing-target check | table test: (GSC positions × content-inventory matches × Limited-Intelligence proxy) → CREATE / OPTIMIZE / REFRESH / proceed-with-link | main §7.7 |
| Opportunity dedupe, expiry & status guards | partial-unique conflict tests; scan re-run converges (no duplicates, expired rows keep history) | main §7.9 |
| OPTIMIZE recommendation lints | pure-function tests: grounding (`facts_used` resolve), no-duplicate-paragraph, link targets exist, length limits | main §10.3 |
| Rules config | schema validation of `signals.config.yaml`; "no threshold literals" lint; `rules_version` stamped on every opportunity/gate row | main §7.10 |
| Notification matrix ↔ preferences (opportunity rows) | table-driven test extended with the opportunity events | UI spec §10 |

---

## 7. Explicitly out of scope here

Infrastructure-as-code tooling choice, multi-region, websockets, mobile native apps, the internal-link crawler and URL Inspection integration (P1 — main §11, §12.4), GA4 (main §12.5), and anything the main spec's §18 already excludes. When notification volume or realtime needs outgrow §1.6's polling, that's a later spec — not a reason to build push infrastructure now.
