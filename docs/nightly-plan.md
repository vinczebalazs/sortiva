# The next nightly run — what to build, in what order, and what must not wait

Written 2026-09-02 by the integrator, for whoever runs the next unattended session.
It assumes nothing from any conversation. Operating rules are in
`docs/overnight-run.md`; live state is in `docs/overnight-state.md`, which is
rewritten after every card lands or stops and is the file to trust over this one
where they disagree.

---

## The one thing to understand before planning anything

**Lane B is the critical path and nothing else can substitute for it.** Two whole
milestones — the content engine and the rest of search intelligence — cannot start
until Lane B reaches `T2.5`. Every other lane running tonight is running *beside*
the critical path, not on it. So:

- Lane B gets the machine's attention when something has to give.
- A lane B card that stops for a decision stops three lanes' worth of future work,
  so the questions listed at the bottom matter more for that lane than any other.

---

## Four lanes, and what each does

Four concurrent building sessions is the cap (`docs/overnight-run.md`). Check
`uptime` before launching. Each lane merges into `main` and passes the full gate
before it starts its next card; a lane never runs two cards at once.

### Lane B — the critical path · worktree `../sortiva-lane-b`

`T-START` → `T2.2` → **audit** → `T2.3` → `T2.4` → `T2.5`

Strictly serial: each card needs the one before it. What the sequence adds, in
order: **a claimed domain finally starts moving on its own**; the store's catalogue
actually syncs and stays synced; each product is reduced to a short fact sheet;
products are grouped into families; the store gets a persona, locale and timezone.

**`T-START` goes first and is tiny** — the claim queues its first step in the same
transaction that writes the run. It is first because until it lands nothing in the
running product starts a merchant's onboarding at all, which means `T2.2` cannot be
watched working end to end on a real claim. Founder decision of 2026-09-02; the
alternative (switching the whole recurring schedule on) was rejected because it
would have started the billing repair and the spend caps at the same moment, right
before the first card to spend real money at scale.

**`T2.2` is the single most consequential card in the run.** It is the first code
that talks to a vendor continuously — paginated, rate-limited, checkpointed, over a
network — and the plan names it as the card most likely to strand a merchant halfway
through onboarding. Three things about it:

- **An audit is scheduled after it** (§7) and must run before `T2.3` starts. Audits
  are read-only and their findings are held for the morning unless one blocks the
  next card.
- **It is the first card that spends real money at scale.** The spend caps are
  built and merged (`T8.4a`), but they run on a schedule, and the scheduler is
  switched off — see the open questions.
- **`T-OPS` landed for exactly this card's sake**: diagnosis, one-command replay,
  a health check that can fail, crash reporting. If `T2.2` strands a store at 3am,
  those exist now.

**Lane B stops here.** `T2.6` and `T2.7` are the tail of the milestone and matter
less tonight than unblocking the two lanes waiting on `T2.5`.

### Lane C — search intelligence · worktree `../sortiva-lane-c`

`T3.4` → `T-EMAIL` → **then held**

`T3.4` is the first card that detects anything: pages sitting just off the first
page, pages ranking well but not being clicked, pages losing ground, and two of the
store's own pages fighting over one intent. Everything Lane C has landed so far
(`T3.1`–`T3.3`) is the arithmetic underneath it; this is where it becomes signals.

**Then it takes `T-EMAIL`**, which belongs to no lane and is a good use of a lane
that would otherwise idle. Email sign-in ships in v1 (founder, 2026-09-02) — and the
card is larger than "add a provider" looks: the auth library will not run an email
provider without a database session adapter, and this app deliberately has none.
Sessions today are self-contained tokens, which is why one cannot be revoked before
it expires. The card moves sessions into the database and revisits their lifetime.
Read its `DECISIONS.md` entry before planning it.

**Then the lane stops**, because `T3.5` needs `T2.4`–`T2.5` from Lane B. Do not
start `T3.5` early. If Lane B reaches `T2.5` while the night is still young, `T3.5`
becomes available and this lane can restart — that is the one mid-run decision the
runner should be watching for.

### Lane F — screens · worktree `../sortiva-lane-f`

`T-ANALYTICS` → `T9.3` → `T9.4` → `T9.5`

**`T-ANALYTICS` first**, because every screen built without it is a screen someone
revisits. The founder chose (2026-09-02) that browsers report to the analytics
vendor directly rather than through a route of ours. Two obligations come with that
and are written into the card as requirements, not advice: **session replay must be
provably off on every view that renders a merchant's store data** — replay captures
the page and the page is their catalogue — and because our code no longer sits
between the browser and the vendor, the guard against product content reaching
analytics has to be structural, in the event definitions themselves.

Then onboarding, the opportunities screen, and the calendar and article screens.
These run entirely on the mock API server and need no backend, so this lane is the one
that cannot be blocked by anything happening in the others. It is also the lane
most likely to get furthest in a night.

Each card must record which mock fixture fields its screens depend on, so the
backend card inherits a contract rather than a surprise; `T9.1` and `T9.2` both did
this and `T9.3` should continue it.

### Lane G — the schema wave, then notifications · worktree `../sortiva-lane-g` (create it)

`T8.0` → `T8.1` → `T8.2`

**`T8.0` first, and it needs integrator preparation before it can start.** It is a
schema wave whose entire content is "the columns earlier cards were told to defer",
and collecting that list is the integrator's job, not the lane's. At least four are
already known and are recorded in `DECISIONS.md`:

- a partial unique index making a released domain's uniqueness real in the database,
  plus the matching one on the Shopify connection's invalidation timestamp;
- `spend_events.price_unknown`, so a call priced at zero is distinguishable from one
  whose price nobody configured;
- **a way to mark an inventory page as deleted** — flagged by `T3.2` and needed
  before `T3.5`, which would otherwise recommend improving a page that no longer
  exists;
- the durable completed-work ledger, if the founder wants it (an open item in
  `docs/audits/remediation.md`).

**Collect the full list from `DECISIONS.md` before launching this lane.** A schema
wave that misses a deferral makes the card that needed it wait for the next wave.

Then `T8.1` (the notifications record and the attention list) and `T8.2` (email).
An audit is scheduled after `T8.2`.

---

## What unblocks what

```
Lane B  T-START ─ T2.2 ─ audit ─ T2.3 ─ T2.4 ─ T2.5 ─┬─ unblocks Lane C's T3.5
                                                      └─ unblocks the content engine (M4)
Lane C  T3.4 ─ T-EMAIL ─ (held for T2.5)
Lane F  T-ANALYTICS ─ T9.3 ─ T9.4 ─ T9.5    (independent of everything)
Lane G  T8.0 ─ T8.1 ─ T8.2                  (independent of everything)
```

**The learning loop (`M7`) is deferred and must not be scheduled** — founder
decision, 2026-09-02. It is marked in the build plan. Nothing depends on it.

---

## What the integrator does between cards

1. **Re-read `docs/overnight-state.md`** before launching any card and before any
   merge. Never report from memory what the file can be read for.
2. **Merge, then run the full gate, one command at a time, never chained.** The gate
   now ends with `pnpm smoke:boot`, which starts the built application and asks it
   for a page — added because every other check passed for days while the product
   served an error on every request.
3. **Rewrite the state file after every card lands or stops**, including what the
   card left undecided and who should take it.
4. **Hold audit findings for the morning** unless one blocks the next card in that
   lane, in which case stop the lane and say so.

---

## Traps that have already cost time

- **The machine sleeps and it kills whatever session is running.** Re-apply
  `caffeinate -dimsu -t 21600` before launching, and check `pgrep -fl caffeinate`
  first if sessions start dying. A bare `caffeinate` does not hold it.
- **`pnpm test` and `pnpm lint:prove` must never run at the same time.** The proof
  script plants and deletes a file a billing test reads off a `git ls-files`
  listing.
- **A lane that reads a large spec file whole tends to stall.** Grep for heading
  offsets and read ranges.
- **Tell every lane to commit in halves, staging by explicit path.** Never
  `git add -A`, `git add .`, or `git commit -a`.
- **Tell every lane to finish its card and stop.** One lane ignored this and left a
  successor auditing unverified code instead of writing its own.

---

## Decisions — all three answered on 2026-09-02

They are journalled in `DECISIONS.md` with the alternatives rejected and why, and
each is now a card. **Do not re-open them from memory; read the entries.**

- **What starts a merchant's onboarding** → the claim queues the job itself
  (`T-START`). The scheduler stays off, and switching it on is now its own
  still-open question rather than a side effect of this one.
- **How a browser sends an analytics event** → straight to the vendor
  (`T-ANALYTICS`), with the two obligations above.
- **Does email sign-in ship in v1** → yes (`T-EMAIL`), and it is an auth change
  rather than a provider toggle.
- **Does the change contract describe blog posts** → done, not carded. `T2.2` now
  has four more kinds to emit, from Shopify's `articles/*` and `pages/*` webhooks.
  Emitting none of them leaves behaviour exactly as it is, so it cannot break that
  card.

**Still open, and neither blocks the run:**

- **Should the recurring schedule be switched on?** Ten of fourteen scheduled jobs
  still have no handler, so none runs — including the nightly billing repair and the
  spend caps, both finished and tested. `T2.2` is the first card to spend real money
  at scale, which makes this worth answering during the run rather than after it.
- **The deployed start command would not find the build.** `railway.toml` runs the
  server from the repository root while the build output is in `apps/web`. Not in
  any card's scope, and `pnpm smoke:boot` does not catch it because it starts from
  the application directory. It stops a deployment, not a build.
