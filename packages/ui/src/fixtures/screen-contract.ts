/**
 * Which fields of which mock response each built screen actually reads.
 *
 * Every screen in this product is built against the mock server months before
 * its backend exists. Without a record, the card that later writes the real
 * endpoint has no way to know which of the fields it declared are load-bearing
 * and which were never used — and the first time anyone finds out is when a
 * screen renders blank against the real API.
 *
 * So each screen registers its fields here as it is built, and a test asserts
 * every path still resolves in the mock fixtures. A backend card reads this and
 * inherits a contract; a field removed from a fixture fails a test in the lane
 * that depended on it.
 */

export interface ScreenFixtureDependency {
  /** The screen, by the name the design canvas and the UI spec both use. */
  readonly screen: string
  /** `METHOD /api/path`, matching the route table. */
  readonly route: string
  /** Dotted paths into the response body. `[]` means "an array of these". */
  readonly fields: readonly string[]
  /** What the screen does with them, so a backend card knows what matters. */
  readonly note: string
}

export const SCREEN_FIXTURE_DEPENDENCIES: readonly ScreenFixtureDependency[] = [
  {
    screen: 'App shell — navigation rail',
    route: 'GET /api/account',
    fields: ['domain.state', 'connections.lastScanAt'],
    note: 'Only `ready_for_planning` unlocks the four product destinations. A null scan timestamp keeps Opportunities marked as still filling, so this field must be null until the first scan actually produces something — not set optimistically when the scan starts.',
  },
  {
    screen: 'App shell — banner stack',
    route: 'GET /api/account',
    fields: [
      'subscription.status',
      'connections.shopify',
      'connections.searchConsole',
      'limitedIntelligence',
      'servicePaused',
    ],
    note: '`past_due` raises the payment banner; `broken` on either connection raises its reconnect banner. `limitedIntelligence` must be false whenever Search Console is `broken`, or the merchant is told the same thing twice.',
  },
  {
    screen: 'App shell — browser analytics',
    route: 'GET /api/account',
    fields: ['accountId', 'domain.normalized'],
    note: 'The account id is who the analytics vendor is told is using the product; the normalised domain is the group every cost and usage question is asked by. They are the same two the server-side events already carry, so a click in a screen and a job on a queue land on one story rather than two. Neither is rendered — an account response missing them draws exactly the same screen and simply reports nothing. `domain.normalized` must be the *claimed* domain and never a host a visitor typed into the preview, or a stranger’s browsing would be attributed to a real store.',
  },
  {
    screen: 'App shell — banner stack',
    route: 'GET /api/settings',
    fields: ['vacationMode'],
    note: 'Vacation mode is a publishing setting rather than an account fact, so the shell needs both responses to decide what to show.',
  },
  {
    screen: 'Onboarding — which stage the dashboard shows',
    route: 'GET /api/account',
    fields: ['domain.state', 'connections.shopify', 'connections.lastScanAt'],
    note: 'The domain state alone does not decide the screen. `awaiting_shopify_auth` means two opposite things — a store that has never connected, and one whose token was revoked — and `connections.shopify` is what tells them apart, so it must read `broken` (not `none`) after a revocation. `lastScanAt` must stay null until the first scan has actually produced opportunities: it is what ends the "finding your opportunities" wait, and setting it when the scan *starts* would send the merchant to an empty list.',
  },
  {
    screen: 'Onboarding — setup progress list',
    route: 'GET /api/ingestion/status',
    fields: ['steps', 'startedAt', 'status'],
    note: 'Every row needs `step`, `state` and `startedAt`. Nine step names collapse into seven rows, so all nine must keep the names in the response schema. `startedAt` must be the time *that step* began, not the run: it is what the elapsed readout counts from, and a run-level timestamp would tell a merchant the last step has been going for twenty minutes. A step not yet reached may be absent from the array; the screen treats a missing step as not started.',
  },
  {
    screen: 'Onboarding — setup progress list',
    route: 'GET /api/ingestion/stream',
    fields: ['steps'],
    note: 'The stream must send whole status bodies of the same shape as the status route, one per transition, as `data:` frames. The screen falls back to polling the status route when the stream fails, and the two must be interchangeable — a stream sending diffs rather than snapshots would make the fallback show something different.',
  },
  {
    screen: 'Onboarding — confirmation review',
    route: 'GET /api/profile',
    fields: [
      'description',
      'language',
      'country',
      'audience',
      'tone',
      'topProducts',
      'keywords',
      'competitors',
      'competitorSuggestions',
      'families',
      'richness.band',
      'richness.productsMissingDetails',
      'searchConsole.connected',
      'searchConsole.property',
    ],
    note: 'Each `topProducts` row needs `id`, `title`, `source` and `pinned`; the order of the array is the ranking, and the confirm request sends it back as `topProductIds`. Each keyword needs `enrichmentState` — a term still being priced renders as "fetching", never as a volume of zero, so `monthlySearchVolume` must be null rather than 0 while pending. Each competitor needs `source` so auto and hand-added are distinguishable, and `competitorSuggestions` must carry only domains seen ranking, never entries already in `competitors`. Families need `axes` and `groupingSource`. `richness.productsMissingDetails` is a count; the screen does not name the products, because the response carries no list of them.',
  },
  {
    screen: 'Onboarding — landing on the first scan',
    route: 'GET /api/opportunities',
    fields: ['counts.open', 'limitedIntelligence', 'lastScanAt'],
    note: '`counts.open` is the number in the headline, so it must be the count of open opportunities rather than of everything ever found. `lastScanAt` non-null is what ends the wait and moves the merchant here, so it must not be written before the scan has produced something. `limitedIntelligence` decides whether the headline carries the badge and whether the explainer strip ends with the Search Console nudge.',
  },
  {
    screen: 'Opportunities — the list',
    route: 'GET /api/opportunities',
    fields: ['opportunities', 'counts.byAction', 'lastScanAt', 'nextScanAt', 'limitedIntelligence'],
    note: 'Every card needs `recommendedAction`, `impact`, `confidence`, `signalType`, `entityRef.label`, `evidence` and `why`. Three of those decide whether the screen is worth anything. **`why.templateKey` must be a key the string catalogue holds** — the sentence is rendered from `packages/ui/strings/en.json` and never sent as text, so an unknown key renders "the reasoning for this one isn\'t available yet" in place of the product\'s explanation; the existing-page case must use `existing_target.prefer_optimize`, which is aliased to the canonical Appendix A sentence. **Each `evidence` fact must carry `source`, and `window` wherever the measurement has one** — the card\'s number line ends with both, and a fact with neither reads as a number from nowhere. **`entityRef.label` must be the humanised name** ("Collection: Trail running shoes", or the head term in quotes) rather than a URL or an id: it is the card\'s title and the only thing on it a merchant recognises at a glance. `nextScanAt` is rendered as a date in the header, so it must be the next run for this account rather than a global cadence; `counts.byAction` are bare counts on the filter chips and must never arrive paired with a target.',
  },
  {
    screen: 'Opportunities — the detail drawer',
    route: 'GET /api/opportunities/{id}',
    fields: ['opportunity', 'tasks', 'serpSnapshot', 'recommendation', 'history', 'outcome'],
    note: 'The drawer renders `recommendation.fields` as current-versus-suggested for OPTIMIZE and as the numbered instruction list for FIX, so `field` should stay within the set the pipeline produces (`title_tag`, `meta_description`, `headings`, `sections`, `faq`); an unrecognised name is spelled out from the code and reads badly. `recommendation.state` is what separates "not asked for yet" from "working on it" from "we could not do this safely", and `failed_validation` must arrive with no fields at all, because the screen shows no partial output. `outcome` stays null until the 28 days are up. **Two gaps the backend will have to close:** the HOLD view has no per-product Shopify admin links, because nothing in this response carries product ids, so it renders the task labels and sends the merchant to Products; and the FIX view has no impression-share numbers, so it renders whatever `recommendation.fields` holds rather than the design\'s comparison of the competing URLs.',
  },
  {
    screen: 'Opportunities — acting on one',
    route: 'POST /api/opportunities/{id}/schedule',
    fields: ['scheduledFor'],
    note: "The date in the confirmation toast is the server's answer rather than the one asked for: at most one topic occupies a day, so a request for a taken day comes back with a different date and the merchant has to be told which. A 409 on this or on dismiss / restore / recommendations / tasks ends in a re-read of the list and a toast, and the screen reads `error.code` — `opportunity_not_open` is worded differently from the rest — so the code must be the machine-readable one rather than a sentence.",
  },
  {
    screen: 'Content — the calendar',
    route: 'GET /api/calendar',
    fields: ['topics', 'paused.active', 'nextReplenishmentAt'],
    note: '**`scheduledFor` is the whole screen.** Every topic must carry the date it is scheduled to generate on, and at most one topic may share a date — the day cell holds one, and a second for the same day is dropped rather than stacked, so a duplicate becomes invisible instead of loud. Each topic also needs `state`, `pinned`, `why`, and — where it came from one — `opportunityId` and `signalType`, which are what the chip links back to. **`why.templateKey` must be a key the string catalogue holds**, because the sentence is rendered from `packages/ui/strings/en.json` and never sent as text. A topic in `rejected_by_gate` must carry `rejection` with its `gate` and reason, or a day that produced nothing renders with no explanation, which is the one thing the screen exists to avoid; the reason for a thin catalogue must use the key `quality_rejection.insufficient_richness`, aliased to the canonical sentence the product may not reword. **The response must never carry a count of empty or missed days, and the range asked for must be answered honestly rather than compacted** — days with nothing on them are how the merchant sees that a quiet day is normal, and a response that omitted them would be indistinguishable from a plan with no gaps.',
  },
  {
    screen: 'Content — acting on a topic',
    route: 'POST /api/calendar/topics/{topicId}/veto',
    fields: ['ok'],
    note: "The veto is held for the five seconds its undo is on offer and only then sent, because **there is no route that un-vetoes a topic** — vetoed topics go on a list replenishment consults, so this is one-way. If that changes and a restore appears, the screen should send immediately and undo through it instead. A refused veto (`topic_already_published`) puts the chip back and re-reads; the code must be the machine-readable one rather than a sentence. The same click then dismisses the originating opportunity through `POST /api/opportunities/{id}/dismiss`, so **`topics[].opportunityId` has to be the opportunity that actually produced the topic** — dismissing the wrong one would silently remove work the merchant never asked to lose.",
  },
  {
    screen: 'Content — moving a topic',
    route: 'POST /api/calendar/topics/{topicId}/move',
    fields: ['id', 'scheduledFor', 'pinned'],
    note: 'Dropping onto an occupied day is **two move requests, not one**: the contract has no swap, so the screen moves the dragged topic and then the displaced one. They are not atomic — if the second is refused the first stands and the calendar is re-read — which is the strongest argument for a swap endpoint. The rules the screen applies before sending (a pinned topic does not move, a pinned topic is not displaced, only a planned topic moves, and only onto a future day) must match what the server enforces, or a drop the screen allows comes back 409 for a reason the merchant was not warned about.',
  },
  {
    screen: 'Content — adding a topic by hand',
    route: 'POST /api/calendar/topics',
    fields: ['outcome', 'topic', 'warning', 'convertedToOpportunityId', 'rejection'],
    note: 'The four outcomes are rendered differently and each needs its own field filled: `planned_with_warning` without a `warning` renders a heading over nothing, `converted` without `convertedToOpportunityId` leaves the merchant told we made an Optimize opportunity with no way to reach it, and `rejected` without `rejection` refuses without saying why. `warning` and `rejection` are template keys, never sentences.',
  },
  {
    screen: 'Content — the articles library',
    route: 'GET /api/articles',
    fields: ['articles', 'cursor'],
    note: '**`performance` must stay null until the measurement window is up**, because null is what makes a row read "too new" rather than as a zero — an article published on Tuesday with `clicks28d: 0` would look like a failure instead of an unmeasured one. `publishedUrl` null on an exported, published article is what raises the "waiting for your URL" tag and puts the row in the attention filter, so it must not be filled with a guess. `publishedViaOverride` is shown rather than hidden. `cursor` is read but **paging is not built**: the screen renders whatever one response returns, so a store with hundreds of articles shows only the first page until someone builds it.',
  },
  {
    screen: 'Content — one article',
    route: 'GET /api/articles/{articleId}',
    fields: ['article', 'html', 'metadata', 'evidencePack', 'qualityReport', 'history'],
    note: '`html` is rendered as it stands and is the only field the screen injects as markup, so **it must be the article as it will publish and must never contain anything the pipeline did not put there**. The override dialog has to restate the criteria the draft failed, and **the response does not say which they are**: it carries scores and justifications, and the floors that decide a pass live in `packages/rules`, where the screen must not re-derive them. So the dialog names the criteria the judge wrote a justification for, which is right only while justifications are written for what the judge marked down — **a `failedCriteria` list on `qualityReport` would close this properly**. Two further gaps: a held article carries no rejection reason of its own (the calendar\'s topic does, this does not), so the article page shows the judge\'s report in its place; and `history[].event` is a bare string with no enumerated set, so an event we have no wording for is spelled out from its own name.',
  },
  {
    screen: 'Products — the catalogue and its merchant tasks',
    route: 'GET /api/products',
    fields: ['richness.band', 'richness.productsMissingDetails', 'counts', 'merchantTasks', 'products', 'cursor'],
    note: 'Every merchant task needs `blockingTitle`, `impact` and a `products` array, and **each product needs `shopifyAdminUrl`** — the whole point of the card is that the merchant fixes the gap in Shopify rather than typing facts into us, so a task without those links is a chore with no way to start it. The screen refuses any address that is not an HTTPS `*.myshopify.com` or `admin.shopify.com` URL and renders the product as plain text instead, so a link built from an unvalidated store handle silently loses its link rather than pointing somewhere else. `missingFields` are stored field names (`lug_depth`, `weight_g`) and are rendered through a lookup, so a new one arrives as readable words rather than as a code. `completedAt` non-null is what folds a task away — it must be set when the fields actually arrive, not when the task was created. `cursor` is read but **paging is not built**: a store with hundreds of products shows only the first page.',
  },
  {
    screen: 'Products — the read-only family list',
    route: 'GET /api/products/families',
    fields: ['families'],
    note: 'The same shape and the same component as the confirmation screen, deliberately: each family needs `label`, `memberCount`, `axes`, `groupingSource` and `lowConfidence`, and `groupingSource` must stay within `taxonomy` / `fact_clustering` / `embedding` or the badge falls back to the raw name. `id` must match `products[].familyId` from the response above, because the products table names a product\'s family by looking it up here — a mismatch leaves every row reading "Not grouped".',
  },
  {
    screen: 'Performance — the chart and the results table',
    route: 'GET /api/performance/overview',
    fields: ['connected', 'series', 'markers', 'results'],
    note: '**A day with no Search Console data must arrive with `clicks` and `impressions` null, and must still be in the array.** Null is what breaks the line and what keeps the day out of the totals; omitting the day entirely would join the line across the hole and make a gap invisible. A zero on a day nobody measured is the same lie with a number on it. **`results[].label` decides whether the row shows figures at all**: `unrated` and `not_applied` render as dashes with a "too new to judge" chip, and any other label renders the numbers — so a young article must arrive as `unrated` rather than as a rated row of noughts. `markers[].kind` must be one of the three the chart draws (`gsc_connected`, `article_published`, `optimize_applied`) and its `date` must fall inside `series`, or the marker is dropped rather than pinned to an edge. `publishedViaOverride` moves a row into the separate folded section and out of everything the product learns from. **Two gaps the backend will have to close:** a result carries no `publishedUrl` or confirmation flag, so an exported article awaiting its URL cannot be greyed with a "confirm URL" action here and is indistinguishable from an ordinary row; and the response carries no connect date of its own, so the subtitle falls back to the `gsc_connected` marker and says nothing when there is none.',
  },
  {
    screen: 'Performance — the Search Console tab',
    route: 'GET /api/performance/search-console',
    fields: ['rows', 'cursor'],
    note: '**`signals` is what this table is for.** Each entry needs a `signalType` the string catalogue can name and an `opportunityId` that is actually open, because the badge is a link into it — a row with numbers and no way to act on them is the reporting island the spec says this must not be. `pageType` is rendered only on the pages table and must be null rather than guessed for a URL the content inventory does not hold. `deltaPosition` is read by meaning rather than by sign: negative is an improvement and renders as "up N places", so a backend that flipped the sign would tell every merchant their rankings moved the wrong way. `deltaClicks` and `deltaPosition` must compare like windows — a partial period against a full one produces a change that is entirely an artefact. **One gap:** the cannibalization view ui §8.2 asks for needs per-URL impression shares over time for a query cluster, and this response carries none, so it is not built; the cannibalization badge links to the FIX opportunity that holds the evidence instead.',
  },
  {
    screen: 'Dashboard — the steady state',
    route: 'GET /api/attention',
    fields: ['items'],
    note: 'Each item needs `kind` and the `refs` that say which thing it is about — `articleId` sends the merchant to that article and everything else falls back to the surface that owns the kind, so an item with empty `refs` still renders but lands on a list rather than on the thing. These are a live query and never stored rows: an item must disappear the moment its cause is resolved, because the dashboard has no way to dismiss one.',
  },
  {
    screen: 'Dashboard — the month strip',
    route: 'GET /api/articles',
    fields: ['articles'],
    note: 'The strip counts `state === "published"` rows whose `publishedAt` falls in the month in view, so `publishedAt` must be the moment it actually went out rather than when it was written. **Three of the six lines ui §4 asks for are not built, because nothing answers them:** how many page-improvement recommendations were generated this month, how many were marked applied, and how many repairs ran. The opportunities response carries open counts rather than monthly activity, and an article says only whether it was ever `repaired`, never when. A summary route, or dated activity on these three, would close it. **No line on this strip may ever arrive paired with a target**; a rendered-output test enforces it.',
  },
  {
    screen: 'Dashboard — next up and today',
    route: 'GET /api/calendar',
    fields: ['topics', 'nextReplenishmentAt'],
    note: 'The dashboard reads three weeks either side of today and picks the earliest `planned` topic dated strictly after today as "next up", and the topic dated today — whatever state it reached — as today\'s outcome. **`why.templateKey` must be a key the string catalogue holds**, because the dashboard renders the sentence rather than showing anything sent as text. `articleId` on a published topic is what links the day to what it produced; without it the card names the article and cannot open it. `nextReplenishmentAt` is rendered as a date on the month strip.',
  },
  {
    screen: 'Settings — Publishing',
    route: 'GET /api/settings',
    fields: [
      'delivery',
      'shopifyPublishAs',
      'publishHour',
      'timezone',
      'draftReview',
      'autoRepair',
    ],
    note: '`delivery` is the one field this screen writes back through a conflict-aware flow rather than a plain PATCH: setting it to `auto` can come back `write_scope_required` or `target_blog_unresolved` before it actually takes, and the screen must treat both as steps in turning the toggle on rather than as failures. **The response carries no field naming the current target blog** — `GET /api/publish/blogs` lists what a merchant could choose, never which one is chosen — so the screen can offer to change the target but cannot state it; a `targetBlogId` (or the blog embedded inline) on this response would close that.',
  },
  {
    screen: 'Settings — Publishing, granting write access',
    route: 'POST /api/shopify/oauth/start',
    fields: ['url'],
    note: '**This is the only Shopify OAuth-start route the contract has, and it is built to request read scopes only** (`packages/core/src/catalog/scopes.ts` hardcodes `SHOPIFY_READ_SCOPES` into the authorize URL, and the callback calls `assertReadOnlyGrant` and throws away the token if Shopify ever hands back a write scope). Main §9.5\'s second, `write_content`-adding pass has no route of its own anywhere in the contract or the provider. This screen calls the one route that exists as the "grant posting access" trigger, because it is the only thing available to build the click-through against on the mock server — but until a write-scope-aware start route and a callback that keeps rather than drops a write grant exist, clicking this button in the real product cannot actually enable auto-publish. Recorded in `DECISIONS.md` 2026-09-03 T9.7.',
  },
  {
    screen: 'Settings — Publishing, choosing a target blog',
    route: 'GET /api/publish/blogs',
    fields: ['blogs'],
    note: 'Offered once `PATCH /api/settings` has answered `target_blog_unresolved`. Each row needs `id`, `title` and `handle`; the picker sends `id` back as `blogId`. An empty list still renders — the "create a blog named ___" control does not depend on it.',
  },
  {
    screen: 'Settings — Store profile',
    route: 'GET /api/profile',
    fields: ['description', 'language', 'country', 'audience', 'tone', 'topProducts'],
    note: 'The same response the confirmation screen reads (see the onboarding entry above for what every field must carry). **This screen can only display these six fields, not save an edit to them**: the sole write route, `POST /api/profile/confirm`, answers `profile_already_confirmed` once the store has been confirmed, and no other route accepts a change to the business description, language, country, audience, tone or the top-product order. Keywords, competitors and the family report keep working here exactly as they do in onboarding, because those three have their own standing routes. Recorded in `DECISIONS.md` 2026-09-03 T9.7.',
  },
  {
    screen: 'Settings — Connections',
    route: 'GET /api/account',
    fields: [
      'domain.normalized',
      'connections.shopify',
      'connections.searchConsole',
      'connections.lastScanAt',
      'limitedIntelligence',
    ],
    note: '`connections.shopify` decides which of four rows this screen shows (`none` / `read` / `read_write` / `broken`) and whether Reconnect is offered. **The response carries no Shopify store handle** — `domain.normalized` (the claimed website, not the `*.myshopify.com` handle) is what the screen names as "connected store" for want of a field that actually is one. `limitedIntelligence` decides whether the Search Console row also renders the unavailable-signals explainer.',
  },
  {
    screen: 'Settings — Account',
    route: 'GET /api/settings',
    fields: ['vacationMode', 'uiLanguage', 'emailArticlePublished', 'emailDigestFrequency'],
    note: 'Every field here is a plain `PATCH /api/settings` with no conflict of its own — unlike `delivery`, none of these has a precondition that can refuse it.',
  },
  {
    screen: 'Settings — Account, the billing card',
    route: 'GET /api/billing/plan',
    fields: ['capLine', 'cancellationFacts', 'inclusions'],
    note: 'The three cancellation facts render on the card itself, word for word, per main §14.6 — never paraphrased. Status and the next billing date come from `GET /api/account`\'s `subscription`, not from this route, because this route is public and carries no account-specific date.',
  },
  {
    screen: 'Settings — Account, deleting the account',
    route: 'POST /api/account/delete',
    fields: ['ok'],
    note: 'The five facts the type-to-confirm modal states are `ACCOUNT_DELETION_FACTS` from `@sortiva/core`, already mirrored word for word into `settings.deleteAccount.fact.*` and held there by `packages/ui/src/strings/strings.test.ts` — this screen renders the copy keys and never the constant directly. A 400 (wrong or missing confirmation word) re-shows the modal; the route answers `ok` even on a second call, so a slow double-click is never a second error.',
  },
  {
    screen: 'Shell — notification bell',
    route: 'GET /api/notifications',
    fields: ['notifications', 'unseenCount'],
    note: 'Polled every 30s per tech §1.6. Each row needs `type`, `refs`, `createdAt`, `seenAt`, `readAt`. **The line shown for a row is `renderNotification(type, refs)` from `@sortiva/core` with no `resolved` argument**, because resolving a `refs` id (an article id, an opportunity id) into the display text it names — the title, the page — has no caller anywhere in the codebase and no route answers it; every type whose line needs a resolved value therefore always renders its `.generic` sibling rather than the specific sentence main §9.6.8-style copy implies. This is the renderer\'s own designed degrade path (a deleted thing already falls back the same way), not a shortcut taken here, but it means the bell is honest about not naming anything until a resolution lookup exists. Recorded in `DECISIONS.md` 2026-09-03 T9.7.',
  },
  {
    screen: 'Shell — notification bell, opening and reading',
    route: 'POST /api/notifications/seen',
    fields: ['ok'],
    note: 'Fired once, the moment the bell opens — never on every poll — because it is what clears the unseen badge; a caller that fired it on every 30s poll would never let the badge show anything.',
  },
]

/** Reads `a.b.c` out of a fixture body, treating a missing key as undefined. */
export function readPath(body: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((value, key) => {
    if (value === null || typeof value !== 'object') return undefined
    return (value as Record<string, unknown>)[key]
  }, body)
}
