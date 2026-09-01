# Wave 2 — the starting point

Written for the founder, who assigns the work, and for the session that picks it
up. Read this instead of asking anyone what happened; nothing here needs chat
history.

Supersedes `handoff-wave1b.md`, which described an integration that has since
happened. Keep that file for the history; work from this one.

---

## Where things stand

**Everything is merged. `main` holds nineteen cards. Nothing is in flight.**

The full gate is green on the merged tree, each command run separately:

| | |
|---|---|
| `pnpm lint` | clean |
| `pnpm lint:prove` | 7 planted violations, all rejected |
| `pnpm typecheck` | 9 packages |
| `pnpm test` | **883 passing, 56 files** |
| `pnpm contracts:check` | 56 routes; schemas and the API document agree |
| `pnpm build` | 9 routes |
| `pnpm eval` · `pnpm chaos` | pass |
| `pnpm db:migrate` on an **empty** database | 41 tables, 3 guard triggers |

That last row matters more than it looks: a migration that passes on a database
which already has the tables has not been tested. Ask for the before-and-after.

---

## What the product does today, end to end

A merchant can sign up with Google, pay, and claim their domain. Whatever they
paste is reduced to the shortest name a business can own, so nobody becomes two
accounts by connecting `shop.` and `blog.` separately. Eight simultaneous claims
on one domain leave exactly one row — proved by a test that also removes the
database constraint and shows both would get through without it.

The claim writes an onboarding run with nine steps, the first one ready.

**And then nothing happens, forever.**

There is a complete, heavily tested machine for running those steps — locks,
checkpoints, retries, reclaim after a crash, a dead-letter queue, per-store
logging. **No code in the running product calls it.** Only tests and the chaos
harness do. There is no handler for any of the nine steps, and the Shopify client
is one line: `export {}`.

So the merchant sits on a progress screen watching nine steps that will never
move. No timeout, no error, no notification — and no crash reporting is wired, so
nobody learns.

**That is the single most important fact in this document**, and it decides what
to do first.

---

## The order

1. **The spec-citation sweep**, alone, on the quiet tree — see below for why.
2. **`T2.1` and `T9.1` in parallel.** Different lanes, different directories.
3. **The operations card**, third.

Two or three concurrent sessions, never more; see the mechanics at the end.

---

## Then: `T2.1`

Shopify detection, the parked state for unsupported platforms, and read-only
Shopify OAuth. It is the first card with a step to run, which makes it the card
that has to build the missing piece above.

**Two traps it must not fall into:**

1. **It must dispatch from the step rows the domain claim already wrote.** The
   claim deliberately writes the durable record and pushes nothing onto the queue,
   because queueing work for a handler nobody had written would have created a
   permanently failing job. If `T2.1` creates a run of its own instead, every
   merchant gets two onboardings.
2. **Cron is off entirely, and that is a decision it should surface.** The worker
   enables its schedule only once *every* one of twelve scheduled jobs has a
   handler. Eleven have none — so the nightly billing repair never runs either,
   although its own handler is written and tested. All-or-nothing versus "enable
   the entries that have handlers" is a one-line policy question that belongs to
   whoever writes the first handler.

## Alongside it: `T9.1`

The app shell, the navigation, and `packages/ui/strings`. It needs no backend and
does not touch any directory `T2.1` owns.

**The design is in the repo** at `docs/design/` — sixteen screens exported from
the canvas and unpacked, with an indexed README and the token set lifted verbatim
rather than eyeballed. `docs/sortiva-ui-spec.md` remains the source of truth for
behaviour, states and copy; the canvas is the source of truth for how it looks.
Where they disagree, say so rather than picking one.

**`packages/ui/strings` does not exist**, and the constitution says every
user-facing string lives there. Four cards have now parked copy elsewhere — the
billing strings sit in a core module with snapshot tests. Creating that package is
the natural first act of this card, and every card after it inherits the habit.

Note also: 48 of the 56 declared API routes are mocks. Screens will run entirely
on the mock server, and no card between now and milestone 9 turns any of them off.
That is what M0 was for and it is why this lane can start — but when a screen is
built, record which fixture fields it depends on, so the backend card inherits a
contract rather than a surprise.

---

## Two smaller jobs, carded and unstarted

**Run the sweep first, before anything else, on its own.**

It touches 203 files — nearly the whole repository — so it needs a tree with
nothing in flight, and that is true only right now. The moment `T2.1` and `T9.1`
start they own directories the sweep must touch, and it either waits behind them
or collides with them.

There is a second reason, and it is the better one. A session writing `T2.1`
reads the code around it and copies the style it finds. That code is currently
full of the citations the founder has ruled against, so the rule lives only in
`CLAUDE.md`, contradicted by every file the session opens. Sweeping first makes
the code itself demonstrate the rule.

The operations card then follows in the normal run of work. It writes its new
files under the new convention anyway, because `CLAUDE.md` already forbids
citations — so nothing is lost by putting the sweep ahead of it.

### The operations card

Nobody can answer "why is this store stuck", and nobody can un-stick it. Four
small things, none owned by any existing card:

- a script that takes an email or a domain and prints the store's state and every
  pipeline step, so diagnosis is not hand-written SQL;
- a one-command replay for permanently-failed work. `replayDlqEntry` is written
  and tested and **has no caller** — the specification promises this as "one
  action", so this part is a requirement rather than a nicety;
- a health check that actually checks. `/api/health` returns `{ok: true}`
  unconditionally, and Railway restarts the service when it fails — so today the
  platform's own recovery is disabled;
- wiring the crash reporter. `captureException` is implemented on the analytics
  wrapper and has **zero production callers**, so an unhandled error goes to
  stdout and nowhere else.

### The spec-citation sweep

The founder's ruling: the build is the source of truth, so code carries no spec
references. A section number tells a reader nothing, and it points at a document
that may already be out of date relative to the code beside it while looking like
an explanation. Deviations get flagged in `DECISIONS.md`, never in a comment.

**1,007 occurrences across 203 files.** `CLAUDE.md` and the build plan were
amended when the ruling was made; the code was not, deliberately, because eleven
branches were live at the time.

---

## What the audits found

Six investigations ran during wave 1. All reports are in `docs/audits/`; read
`remediation.md` first — it indexes the rest and records what was decided.

**Fixed:** two blockers and twelve major findings from the foundation audits. A
step killed by a deploy used to strand a store silently forever; it is now
reclaimed and resumes from its checkpoint. Money left with no record on five
paths; every path now writes to a ledger in our own database. A merchant could pay
while our Stripe keys pointed at the wrong world and never be granted access, with
nothing repairing it. Two Stripe messages in the same second were ordered by the
alphabetical accident of a random id, which could lock out someone who had just
paid.

**Also fixed, found by breaking things rather than reading them:**

- The fingerprint that stops us paying twice had no working test — a key that
  changed on every restart passed 423 tests. It is now computed in a separate
  process and pinned to published hashes.
- The promise that we hold no customer data had **no test at all**, though the
  invariant says one exists. Adding `customer_email` and `shipping_city` passed
  433 tests and lint. There is now a scan of the live database's columns.
- Test runs destroyed each other. Fixed database names plus a force-drop meant two
  runs a second apart killed each other's databases, and a fifth of the suite
  silently did not run. A skipped test is green.
- Lint banned the Anthropic package but not its web address, and the raw-handle
  ban list had four of the five names — the missing one was already being imported
  past the rule in committed code.

**Known and not fixed**, from `docs/audits/false-confidence.md` — each small, and
best done by the card that touches that area:

- The single-writer guard on billing status is defeated by aliasing the import.
- The threshold rule is defeated by naming the constant rather than writing the
  literal.
- Nothing structurally stops product content reaching an analytics event; secrets
  are redacted, article text is not.
- The caching argument on the vendor wrappers silently defaults to a no-op, unlike
  the cost ledger beside it, which is required.

---

## Open decisions

None blocks starting. Each is recorded in full in `docs/audits/remediation.md`.

- **Railway now calls `railway.toml` a deprecated format** and says new services
  cannot opt into it. This project has never deployed, so its service does not
  exist yet — the config may simply be ignored when it is created, taking the
  migration step, the memory cap and the no-scale-to-zero setting with it. Settle
  before the first deploy, not after.
- **The vendor prices are guesses**, marked as such. The daily spending cap is
  wrong in exactly the proportion the prices are.
- **Do the spend caps count failed vendor calls?** They are recorded, priced as
  estimates, and probably over-count — an over-counting meter pauses the product
  for money that never left. The ledger stores an outcome per row so this can be
  decided later. It has not been.
- **Are job rows wanted as an audit trail?** A guard forbidding their deletion was
  deliberately removed once the completed-work record moved to its own table.
- **Still no vendor credentials.** Stripe, Turnstile, Anthropic and PostHog work is
  built and tested against fakes, with real-vendor evidence recorded as outstanding
  rather than claimed. Three cards need re-running against real keys.
- **The spec's subscription status list is wrong.** A fifth value was added because
  storing "card still being authorised" as "gave up" corrupted the signup funnel.
  Two places in the spec enumerate four. For the spec keepers.
- **Email sign-in is still missing and its blocker is stale.** It shipped
  Google-only because no table existed for a magic link's single-use token. That
  table exists now. No card owns finishing it.

---

## Session mechanics, learned the hard way

- **Two or three concurrent sessions, never five.** Five running full test suites
  saturated a 12-core machine — load average 18 — and all five stalled at once.
  Check `uptime` before launching another.
- **Run gate commands one at a time, never chained with `&&`.** A stall then costs
  one command's progress instead of six.
- **Commit as soon as the work is green, before writing the report.** Two sessions
  died in exactly that gap. Nothing was ever lost — work survives in the worktree —
  but check `git status` there before restarting anything.
- **Never put two sessions in one worktree**, even when one is read-only.
- **No spec citations in code or commit messages.** The commit title says what
  changed, in words.
- **Prove a test by breaking what it protects.** Several cards did this and it is
  the difference between a green tick and evidence. A migration tested only on an
  empty database has not been tested.
