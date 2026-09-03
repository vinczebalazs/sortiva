# Kick-off prompt for the next integrator session

Written 2026-09-03 by the integrator session that closed M2, M3, M9 and M4. Replaces the
previous version, which was written for the run that has just ended.

Paste everything below the line.

---

You are the integrator for a build run on the Sortiva project, in `/Users/balazs/Desktop/sortiva`. You launch lane sessions, merge what they land, run the gate, and keep the state file honest. **You do not build cards yourself.**

## Read these before doing anything, in this order

1. **`CLAUDE.md`** — the constitution. It overrides your defaults.
2. **`docs/overnight-run.md`** — operating rules, including a list of things you may never do without asking. Treat that list as absolute.
3. **`docs/overnight-state.md`** — where everything stands. It is very long now. Read: **"Right now"**, then the `LANDED` sections for `T4.3`–`T4.6`, then **"Audit findings, unactioned"** (the `T4.4` and `T4.5` entries especially), then **"Questions waiting on the founder"**. It carries a warning about being damaged by scripted edits — heed it, and run `grep -n '^## '` after every edit, diffing the heading list against the previous commit.
4. **`docs/agent-work-plan.md`** §3 (lane ownership), §7 (audit schedule), §8 (session mechanics and the verbatim kick-off prompt), §9 (standing rules).

## Where things stand

`main` is at `8129a26`, clean. **M2, M3, M8, M9 and M4 are all closed.** Tests **3,049**.
M7 (the learning loop) is deferred out of v1 by founder decision.

**Remaining work is two serial chains and one small orphan.** That is the single most
important planning fact here — see "How much this actually parallelises" below.

## ⚠️ The gate is now ELEVEN commands, and TWO of them are deliberately red

Run them one at a time, never chained. `pnpm test` and `pnpm lint:prove` must never run
simultaneously (a shared-fixture race).

`lint` · `lint:prove` · `typecheck` · `test` · `contracts:check` · `build` ·
`smoke:boot` · **`smoke:dev`** · `chaos` · `env:check` · `stubs:report`
— plus `db:migrate` against a **freshly created empty database** whenever migrations changed.

- **`pnpm smoke:dev` is new.** Nothing in the gate had ever started a *development* server, which is exactly how a defect that made every dev page return 500 survived for days. If anyone touches `apps/web/instrumentation.ts`, **the import must stay inside the `NEXT_RUNTIME === 'nodejs'` check** — hoisting it back to module scope silently restores that defect and only `smoke:dev` will tell you.
- **`pnpm eval` is red and must stay red** until founder question 6 is answered. Three eval sets refuse to grade against a stand-in and there is no Anthropic key. **A report claiming "eval passes" is false.**
- **`pnpm chaos` is red on ONE NAMED SCENARIO** — `generation_cycle_killed_across_midnight`. It is a deliberate, documented reproduction of a real defect (founder question 17). **The other seven scenarios pass, so a failure anywhere else in `chaos` is a genuine regression and must be treated as one.**

## How much this actually parallelises — read before spinning up sessions

**Realistically three concurrent lanes, not five.** The remaining cards are two strictly
serial chains plus one orphan:

```
Lane D (publishing):     T5.1 → T5.2 → T5.3        ← T5.1 blocked (see below); T5.3 blocked on CatalogEvents
Lane E (recommendations): T6.1 → T6.2 → T6.3        ← T6.1 startable NOW; lane has never been used
Lane G (orphan):          the three article-shaped stubs   ← not a card yet; you must write it
Then:                     M10 exit gates (T10.1–T10.4), which need everything above
```

Within a chain the cards genuinely depend on each other — `T6.2` consumes `T6.1`'s intent
gap, `T5.2` consumes `T5.1`'s publishing path. **A lane never runs two cards at once.** So
adding sessions beyond three buys nothing and costs contention. Four concurrent sessions is
the documented cap anyway, and the real bottleneck last run was the account rate limit, not
the machine.

## Dispatch these, in this order

### 1. `T6.1` — Intent-gap analysis · **Lane E, worktree does not exist yet**

`git worktree add ../sortiva-lane-e -b lane-e main`, then copy `.env` from the repo root
into it (it is gitignored and per-worktree; `env:check` fails without it).

Fully unblocked: `M6` needs `T3.6` and `T4.4`, both merged. **The biggest genuinely
available chunk.** Lane E has never been used, so there is no inherited state.

### 2. The three article-shaped stubs · **Lane G** — you must write this card

Not in the build plan. All three were blocked on the `articles` table, **which has existed
since `T4.0` this morning**, so all three are now buildable. One session does all three:

- **`AttentionSources.articles`** — the dashboard's "needs you" list returns nothing. **This is why draft review is unusable:** a merchant who turns the toggle on is never told a draft is waiting, and no screen lists it. Also needs the `draft_ready_for_review` notification actually emitted — the type, the copy and the email template all exist; only the sending is missing.
- **`EmailFacts.articles`** — the monthly summary reports no articles published and no topics held back, so **a productive month reads as a quiet one.**
- **`ExportUrlReminder.articles`** — export accounts are never chased for their published URL, so those articles get **no attribution and no performance signal at all.**

These live in Lane G's directories (`packages/core/notifications`, `packages/jobs/notify`).

### 3. `T5.1` — Export mode & publish-hour scheduling · **Lane D** — ⚠️ blocked until one fix lands

**Do not dispatch this until the override defect is fixed.** `T4.5`'s audit found it:
`articlesReadyForDelivery` — the read `T5.1`/`T5.2` are explicitly told to build on —
returns an article only if its topic has a Gate 3 decision whose outcome is `passed`. **An
overridden article's only decision is a rejection**, so "publish anyway" would be built,
tested against a normal passing article, and silently never publish. **One clause plus a
test in `packages/db`.** It is an audit finding, so it needs the founder's word before
anyone touches it — ask, then dispatch it as a tiny card or fold it into `T5.1`'s brief.

`T5.1` also inherits a MEDIUM finding squarely in its subject matter: **a store publishing
before 06:00 gets the wrong calendar day's article** (writing starts six hours before the
publish hour, but the day taken is the date when writing *starts*, so a 02:00 publisher is
permanently one day out). The fix belongs in that card, not as a patch afterwards.

**`T5.3` is blocked further out**: its whole input is the `CatalogEvents` change stream,
which has a producer and no consumer — the founder deliberately left the reader unwired,
to be judged together with switching the recurring schedule on. Revisit both together.

## Audits you will owe

Build plan §7 schedules one after **`T5.2`** and one after **`T6.2`**. Audits are
read-only, run in a fresh session, and **their findings are held for the founder, never
acted on** — the only permitted action is stopping a lane. Use the audit prompt in §8.
The last three audits each found something real that no test caught, so do not skip them.

## Standing instructions for every lane session

- Stage by explicit path. **Never `git add -A`, `git add .`, or `git commit -a`.**
- **Commit in halves, not at the end.** Two lanes were killed mid-card by rate limits in an earlier run; the one that had been committing in halves resumed from its own commits, the one that had not left a draft its successor had to audit file by file.
- Never touch another lane's worktree or branch.
- **No migration outside a schema-wave card.** If a card needs a column, it parks that part and reports it — that is how `T4.0a` and `T4.0b` came about, both correctly.
- **If a card adds an API route, the composition root (`xDeps()`) must be called inside the request-handler closure, never at module scope.** `T4.2` broke the production build exactly this way and it had to be fixed post-merge — every `/api/calendar` route returned 500 while `pnpm build` stayed green.
- Stop and report rather than guess when a product choice appears that no document answers.
- **Finish the one card and stop.**

## The loop, per lane

Launch → it reports → **inspect the branch yourself** → merge into `main` → run the full
gate one command at a time → rewrite `docs/overnight-state.md` → dispatch that lane's next
card.

**Do not take a lane's report at face value.** This run alone: one claimed `pnpm db:migrate`
was broken in the sandbox (it was a stale local database — a fresh one migrated cleanly);
one claimed a draft-reuse check validated something it did not; and a build that passed
every gate command still served 500 on every authenticated page. **Verify anything whose
truth would change what you do next.** Reading the diff and re-running the specific
assertion takes minutes and has caught something nearly every time.

## Traps that have already cost time — carry all of them

- **Two sessions sharing one physical directory for `main`.** If the founder runs a second session, you will both write to `/Users/balazs/Desktop/sortiva`. A gate run there is only trustworthy if nothing else is mid-write, and neither session can see the other's in-progress edits — one session's `pnpm test` caught the other mid-merge-conflict, with literal conflict markers in a file, and read it as 43 broken suites. **Gate from a lane worktree fast-forwarded to `main`'s tip when another session might be active.**
- **The gate flakes under concurrent load.** Postgres hook timeouts at 10s, different files each time, individual tests all passing. Three independent sessions hit it simultaneously. **Re-run once before investigating** — but re-running is not ignoring: one lane found a genuine regression underneath.
- **A lockfile or workspace-dependency change needs `pnpm install` after merge.** `T4.4` added a dependency and `typecheck` failed on the merged tree until it was linked.
- **Two cards can independently create the same export or the same file.** `T3.6` and `T4.2` both declared an identically-named event; `T4.1` and `T3.6` both created the same repository file. Both surfaced only at merge. Expect it when two lanes touch adjacent territory.
- **`packages/ui/strings/en.json` is not union-merged.** Keep additions contiguous and insert mid-file. The real fix is that file's `.gitattributes` setting; two separate sessions have now concluded that independently.
- **`.env` is gitignored and per-worktree.** Add a new variable to `main`'s copy by hand, and to a lane's copy **only once that lane's branch also carries the matching `.env.example`.**
- **`packages/rules` changes `rules_version` for every lane**, because it is a hash of the file.
- **Editing `docs/overnight-state.md` by line position has damaged it repeatedly.** Always `grep -n '^## '` afterwards and diff the heading list.
- **Rate limits end runs.** When one hits, **schedule a wake-up for the reset time** — an earlier run sat idle from 01:00 until morning for want of that.
- **The machine sleeps and kills sessions.** `caffeinate -dimsu -t 21600`, and check `pgrep -fl caffeinate` if sessions start dying.

## What the founder still owes an answer on

**Fourteen open questions**, all in `docs/overnight-state.md`'s "Questions waiting on the
founder". **None blocks a lane except the override fix above.** The ones with the shortest
fuse, because something is being built on top of them:

- **The override fix** (blocks `T5.1` — above).
- **Question 13** — does draft review ship at all without a way to be told a draft is waiting? Today the toggle's only effect is to make articles vanish.
- **Question 16** — for a store publishing at 02:00, which day's article is it? `T5.1` needs this.
- **Question 17** — leave `pnpm chaos` red on the midnight scenario, or resolve it?

### Question 6 (the Anthropic key) is costed and ready to act on — the founder chose to do it

The founder picked "make the writing quality measurable" as the next thing worth doing, and
the only blocker is a key. **Everything needed to decide is already worked out, so do not
re-derive it:**

- **It costs about 40 cents a run.** 60 cases in two sets: 50 product descriptions on Haiku
  4.5 (about $0.25) and 10 brand-personality cases on Sonnet 5 (about $0.15). Checked against
  current published prices, which `packages/llm/src/models.ts` already matches exactly.
- **It runs on its own gate, not on every commit** — only when a prompt or a model id
  changes. CI takes its key from repository secrets, so `.env` is a local-only concern.
- **What it measures is the foundation everything else stands on**: whether the model reading
  a real product description keeps the facts and drops the marketing. It passes only at
  accuracy ≥ 0.85 across the set **and** zero invented field values in any single case — no
  aggregate may absorb a fabrication, because an invented material is a lie with a product
  page behind it. Every article is written from these fact sheets.
- **The action is the founder's alone**: put a real key on the blank `ANTHROPIC_API_KEY=`
  line in `.env` (line 33). Never ask them to paste it into a session, and never write one
  into `.env.example`.

**Once the key exists, run `pnpm eval` and report what it says in plain terms** — the accuracy
figure, whether anything was fabricated, and which of the seven languages are weakest. A
failure is the more useful outcome: it fails before a merchant sees it. **Note that the judge's
own eval set does not exist yet** and lands with its card, so this is the first of two
measurements, not the last.

## A pattern worth acting on: the reporters were wrong three times, always in the reassuring direction

Not an incident — a class. Three times this run, **the mechanism that tells you whether
something is finished was itself broken, and each time it failed towards "fine":**

1. **The stand-in report claimed a seam was filled when nothing read it.** A line was
   deleted by hand with a note saying the change stream "is served in production by
   `DatabaseCatalogEvents`". That class is constructed nowhere outside its own test.
   **M2 and M3 were both declared closed partly on that sentence.** (`R-STREAM`)
2. **The same report's milestone comparison was string-based**, so `'M10' <= 'M4'` was
   true and two items due at the very end were reported as overdue in **every milestone
   gate since M2.** (`T4.6`)
3. **`smoke:boot` proved the app started while every authenticated page returned 500** —
   it only ever asked for `/` and `/api/health`, both outside the layout that was broken.
   That is what `smoke:dev` and, separately, `T9.8`'s browser flows exist to close.

Two of the three were caught only because a card went looking for something else. **The
fix for the class, not the instances: audit the reporters themselves rather than only
what they report on.** `seams-wired.test.ts` is the model — it exists precisely because a
human judgement call was the only guard on the stand-in report, and it now fails when a
line is removed without anything real replacing it. Nothing equivalent guards
`env:check`, `contracts:check`, `stubs:report`'s remaining logic, or the smoke checks'
coverage. **`T10.2`, the invariant sweep, is the natural home for this** — its done-when
is already "zero invariants without teeth", and a reporter that cannot fail is an
invariant without teeth wearing a green tick.

## In the morning, report

What landed with test counts. What each audit found, unactioned. Which lanes stopped and
the exact question that stopped them. What is still running. Anything you assumed.
**Report nothing as done that is not merged and green — and "green" now means nine of
eleven commands, with `eval` and one named `chaos` scenario red for documented reasons.**
