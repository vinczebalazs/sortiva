# Kick-off prompt for the next integrator session

Paste everything below the line. It assumes none of the previous conversation.

---

You are the integrator for a build run on the Sortiva project, in `/Users/balazs/Desktop/sortiva`. You launch lane sessions, merge what they land, run the gate, and keep the state file honest. **You do not build cards yourself.**

## Read these before doing anything, in this order

1. **`CLAUDE.md`** — the constitution. It overrides your defaults.
2. **`docs/overnight-run.md`** — the operating rules, including a list of things you may never do without asking. Treat that list as absolute.
3. **`docs/overnight-state.md`** — where everything stands. It is long; read at least "Right now", the landing sections for `T3.5` / `T9.6` / `T2.6`, "Audit findings, unactioned", and "Questions waiting on the founder". **It carries a warning about being damaged by scripted edits — heed it.**
4. **`docs/nightly-plan.md`** — the previous run's plan. Useful for lane shapes and traps; its card ordering is now stale.
5. Build plan **`docs/agent-work-plan.md`** §3 (lane ownership and the files no lane owns), §7 (audit schedule), §8 (session mechanics, including the kick-off prompt to paste verbatim), §9 (standing rules).

## Where things stand

`main` is at `865bbbf`, clean. **51 of 63 cards are done** (2 are deferred by founder decision — the learning loop, `T7.1`/`T7.2`). Tests **2,513**. Four lane worktrees exist — `../sortiva-lane-{b,c,f,g}` — all clean, all merged, none running.

**Milestone M8 is complete.** M2 is one card from complete, M9 two. **M4 — the content engine — has not started, and clearing the way for it was the point of the last run.**

## The founder will decide everything at the end. Do not wait on them.

**Seven founder questions and three remediation cards (`R-PRIVACY`, `R-STREAM`, `R-DEV`) are open and will stay open.** They are all recorded in `docs/overnight-state.md` and in the build plan. Your job is to **keep building everything that does not depend on them**, and to stop a lane only where a card genuinely cannot be done honestly without an answer.

**Do not fix any audit finding**, and do not answer a founder question yourself. If a card hits one, park it and move on.

## Do these first, in this order

1. **Run the `T3.5` audit.** It is scheduled by build plan §7, it is **blocking `T3.6`**, and it needs no decision from anyone — the previous run's attempt was killed by a rate limit before it read the diff. Read-only. Use the audit prompt in §8. Hold its findings.
2. **Launch `T2.7`** in lane B. It closes M2 and is unblocked.
3. **Launch `T9.7`** in lane F. Its previous session was killed before it began, so it is a clean start, not a resume.
4. **Create a Lane D worktree and start `T4.0`** — see below. This is the biggest remaining unblock.

## `T4.0` needs integrator preparation before its lane starts

`T4.0` is schema wave 3 (articles, repairs). Like `T8.0` before it, **a schema wave's content is partly "the columns earlier cards were told to defer", and collecting that list is the integrator's job, not the lane's.** Do that collection first and write it into the card or the state file so the lane inherits a list rather than a search.

**Deferrals that accumulated during the last run** — verify each against the code before including it, because at least one item on the previous wave's list turned out to be wrong:

- **`email_sends.type` has no value for a deletion-confirmation email.** `T8.2` found it, `T8.3` found the second half: that row would also cascade-delete with the account it confirms. **A merchant who deletes their account currently gets no email at all.** Needs an enum value *and* a ruling on where that one record lives.
- **`products.options` / `products.metafields`.** `T2.4` calls this "the single highest-value schema-wave addition" — without it, a store keeping its attributes in metafields yields fewer family axes. Works only from each store's next full sync.
- **A monthly roll-up table for Search Console history.** `T8.3` deletes it at 16 months rather than rolling it up, because there is nowhere to roll it into. Google only serves 16 months, so **after the first store passes that age its earlier history is gone for good.**
- **An article column on `spend_events`**, so `article_cost_finalized` can attribute costs. Built by `T8.4` with no caller.
- **An incidents table** — `T8.4` can record what raised a kill switch, but nowhere to record what an operator *found*.
- **A `sessions` table** — this one is **founder question 3**, so collect it but do not build it unless answered.
- **A marker for a deleted inventory page** — **founder question 1**, same treatment. Note `T3.5` surfaced a second option: "not seen by the last completed walk", which needs something to record that a walk *completed*.

**Also worth knowing but not a migration:** `store_pages.intent_class` exists and **nothing writes it**. Three separate cards have now reported it — it makes cannibalization inert and silently weakens the existing-target check on every real store. **No card in the plan claims it.** It needs an owner, not a column.

## Launching a lane

Give every lane session a worktree path, the **verbatim kick-off prompt from build plan §8**, and these standing instructions:

- Stage by explicit path; **never `git add -A`, `git add .`, or `git commit -a`.**
- **Commit in halves, not at the end.** Two lanes were killed mid-card by rate limits last run. The one that had been committing in halves resumed from its own commits; the one that had not left an uncommitted draft its successor had to audit file by file. This is not hygiene — it is the difference between resuming and re-auditing.
- Never touch another lane's worktree or any branch but its own.
- No migration outside a schema-wave card.
- Stop and report rather than guess if a product choice appears that no document answers.
- **Finish the one card and stop.**

## The loop, per lane

Launch the card → it reports → inspect its branch → merge into `main` → **run the full gate one command at a time, never chained** (`lint`, `lint:prove`, `typecheck`, `test`, `contracts:check`, `build`, `smoke:boot`, `chaos`, `env:check`, `stubs:report`, and `db:migrate` on an empty database if migrations changed) → rewrite `docs/overnight-state.md` → start that lane's next card. **A lane never runs two cards at once. `pnpm test` and `pnpm lint:prove` must never run at the same time.**

**Do not take a lane's report at face value.** Last run, one lane reported a missing dependency as a pre-existing repo bug; it was a stale `node_modules` in its own worktree. Another reported its predecessor's code as non-compiling; it compiled. Verify claims that would change what you do.

## Traps that have already cost time — carry all of these

- **Rate limits end runs.** Two hit last night. **When one hits, schedule a wake-up for the reset time** — the previous session did not, and the run sat idle from 01:00 until morning for no reason.
- **The machine sleeps and it kills sessions.** Re-apply `caffeinate -dimsu -t 21600` before launching, and check `pgrep -fl caffeinate` if sessions start dying.
- **`pnpm eval` is RED and must stay red** until founder question 6 is answered. Two evaluation sets refuse to grade against a stand-in and there is no Anthropic key. **The gate is nine green and one red for a documented reason. Any report claiming "eval passes" is false.**
- **`pnpm dev` cannot start at all** (carded as `R-DEV`). Run browser flows against `next start` after a build.
- **The gate flakes under concurrent lane load.** Every test can pass while the run exits non-zero, or test *files* time out. **Re-run once before investigating** — but a lane that did that found a *genuine* regression underneath, so re-running is not ignoring.
- **`packages/ui/strings/en.json` is not union-merged** and produced three hand-resolved conflicts in one night. It now holds 956 keys. Tell lanes to keep additions contiguous and to insert mid-file rather than at the tail. **Both an auditor and the integrator independently concluded the real fix is the `.gitattributes` setting on that file.** Resolve conflicts by checking the two sides share no key, keeping both, and restoring the comma the conflict boundary swallows — then verify the file parses and every block survives.
- **`.env` is gitignored and per-worktree.** When a card adds a variable you must add it to `main`'s copy by hand, and to a lane's copy **only once that lane's branch also carries the matching `.env.example`.** Refreshing ahead of the branch makes `env:check` fail and costs a lane report space.
- **Adding a method to a frozen provider interface breaks every later card's inline test double.** This bit twice in one night. Check the interface before adding a test file with its own double.
- **`packages/rules` changes `rules_version` for every lane**, because it is a hash of the file's bytes.
- **A NUL byte can get into a source file and make git treat it as binary** — no diff shown, and a merge resolved by wholesale replacement. It happened twice to the same lane. Scan new files if a merge looks odd.
- **Editing `docs/overnight-state.md` by line position has damaged it three times**, including once last night. **Always `grep -n '^## '` afterwards and diff the heading list against the previous commit.** That check caught both incidents.

## In the morning, report

What landed with test counts. What each audit found, unactioned. Which lanes stopped and the exact question that stopped them. What is still running. Anything you assumed. **Report nothing as done that is not merged and green** — and remember that "green" now means nine of ten commands.
