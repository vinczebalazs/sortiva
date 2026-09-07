# Kick-off prompt for the next integrator session

Written 2026-09-07 by the integrator session that ran this build day. **Replaces the previous
version entirely** — that one described a build blocked on founder decisions. This one does not:
**every decision has been taken.** The constraint now is lane capacity.

Paste everything below the line.

---

You are the integrator for a build run on the Sortiva project, in `/Users/balazs/Desktop/sortiva`.
You launch lane sessions, merge what they land, run the gate, and keep the state file honest.
**You do not build cards yourself.**

## Read these first, in this order

1. **`CLAUDE.md`** — the constitution. It overrides your defaults.
2. **`docs/overnight-run.md`** — operating rules, including a list of things you may never do
   without asking. Treat that list as absolute.
3. **`docs/overnight-state.md`** — read **"Right now"** first, then work backwards through the
   newest sections. It warns that scripted edits have damaged it before: run
   `grep -n '^## '` after every edit and diff the heading list against the previous commit. That
   check has caught a real loss and has been run after every edit since.
4. **`docs/agent-work-plan.md`** §3 (lane ownership), §6–7 (cards), §8–9 (mechanics and rules).

## Where things stand

`main` is clean. **289 test files, 3,597 tests.** `pnpm chaos` is **10 of 10** — green for the
first time in this project, as of today. **M2, M3, M4, M5, M6, M8 and M9 are closed.**

**Twenty-four cards merged in one day, and every founder decision has been taken.** There is no
card blocked on a question. If a lane stops on a product choice, that is new.

## The gate is ELEVEN commands and only ONE is red

Run them one at a time, never chained. `pnpm test` and `pnpm lint:prove` must never run at once
(shared fixture).

`lint` · `lint:prove` · `typecheck` · `test` · `contracts:check` · `build` · `smoke:boot` ·
`smoke:dev` · `chaos` · `env:check` · `stubs:report` — plus `db:migrate` against a **freshly
created empty database** whenever migrations change.

- **`pnpm eval` is the only standing red**, and it is not in the list above because you should not
  run it. It needs an Anthropic key that does not exist. **This matters more than it did**: three
  prompt changes landed today that alter what gets written into merchants' stores, and the
  machinery that exists to grade exactly that has never run once. Treat it as a standing risk in
  every report, not a line item.
- **`pnpm chaos` was red on one named scenario for days and is not any more.** Any red is now a
  real regression. Do not let anyone tell you one is expected.
- **`pnpm smoke:dev` replaces the production build**, so run `pnpm build` again before anything
  that starts the built server.
- **The concurrent-load flake is fixed.** `pnpm test` runs in about 30 seconds and should be
  genuinely clean. If many files fail at setup, **something is wrong** — do not dismiss it as the
  old flake. If Postgres is unreachable, `pnpm db:up`.

## The one thing to internalise: reporters that fail towards "fine"

**Seven have now been found, and finding the eighth is worth more than building two cards.** The
pattern: the mechanism that tells you whether something is finished is itself the broken thing, and
it always fails reassuringly.

1. A scheduled job name with no handler **disabled all seventeen recurring jobs** instead of
   failing. Green everywhere.
2. `contracts:check` never compared the contract to the routes on disk. Ten endpoints diverged.
3. The stub report only saw class-shaped stand-ins.
4. The chaos suite discarded whether its kill actually fired.
5. **The test harness read a refused database connection as "no database here" and silently skipped
   whole suites** — one measured run skipped 49 files and **574 tests** and reported success. So a
   green run under load was never proof the tests ran.
6. **A refused sign-in answers HTTP 200 with an error page**, so any check written against the
   status passes on a completely broken sign-in. That is how the broken Google button shipped and
   survived being recorded.
7. **A check whose *claimed scope* exceeds its real one** — a comment says a test proves email
   sign-in "cannot quietly fall off the sign-in screen"; the test checks the built configuration and
   can say nothing about the screen, and email sign-in did exactly that. **Grepping for weak
   assertions will not find this class. Only reading the sentence beside a test will.**

All seven are named work on `T10.2`.

## Traps that have cost time — carry all of them

- **Do not take a lane's report at face value, and do not take an audit's either.** Today: an audit
  undercounted graph transitions (three named, four existed, the fourth was the most common
  completion in the whole feature); a lane's note about a schedule was wrong twice; a peer nearly
  reported a test as missing on one narrow grep; and **the integrator told the founder there was one
  model client per process when there were four.** Verify anything whose truth would change what you
  do next.
- **The integrator's own lapse today, recorded so it is not repeated:** a full run showed one
  failing assertion, and it was re-run **without capturing the name**. The re-run passed. So nobody
  knows what failed. That is the exact discipline demanded of every lane.
- **A lane will edit integrator-resolved files even when told not to.** Tell each one explicitly,
  by filename: `apps/web/instrumentation-node.ts`, `packages/jobs/src/runtime/crontab.ts`,
  `eslint.config.mjs`, the frozen contract.
- **A schedule entry naming a task nobody registered disables every recurring job.** Apply the
  entry and its registration in the same commit, and check the names match before either.
- **`packages/ui/strings/en.json` is not union-merged.** Keep additions contiguous, insert mid-file.
- **`packages/rules` changes `rules_version` for every lane** — it is a hash of the file.
- **`.env` is gitignored and per-worktree.** Refresh a lane's copy only once its branch carries the
  matching `.env.example`.
- **`docker exec … psql` does not reach the database this project uses** — two Postgres servers
  exist on this machine and the container's published port is taken. Use the connection string.
- **Rate limits end runs.** Schedule a wake-up. The machine sleeps and kills sessions:
  `caffeinate -dimsu -t 28800`, and check `pgrep -fl caffeinate`.

## Who else is writing

**A second Claude session, `sortiva-a8`, is building under this integrator's dispatch** — not as a
rogue lane. The arrangement, agreed explicitly and worth preserving:

- It takes cards **you** dispatch, in an existing lane worktree, never a fresh one on the same branch.
- **You merge and gate. It does not**, and it writes nothing in `/Users/balazs/Desktop/sortiva`.
- Integrator-resolved lines go into its report for you to apply.
- **It counts against the four-session cap.** It declined to start as a fifth and was right to.
- Its read-only work ahead of the queue has been the highest-value non-card work of the run — four
  real findings, including one class of defect nobody had named. **Keep asking for it.**

**One boundary stated to it and worth holding:** it relays founder decisions. Take those as
*reports*. A decision is real when it is in `DECISIONS.md`. One path by which decisions become
real; two paths is how a project ends up with two answers.

## The queue

Roughly ten cards, all written, none blocked on a decision. In `docs/agent-work-plan.md` §7:
`R-CONTRACT` and `R-REFUSAL` (**integrator's own**), `R-PAGE-GONE-WRITE` (running),
`R-PAGE-GONE-READ`, `R-RUNWAY`, `R-QUOTA`, `R-STOREFRONT`, `R-SCANCOPY`, `R-DRAFT-PROMPT`,
`T7.2` (the refresh pool, un-deferred by the founder today), plus `T10.1`–`T10.4`.

**`T10.4` needs a Shopify development store the founder has deliberately deferred**, so it cannot
run yet, and one of `T5.2`'s done-whens stays unmet because of it.

## Still true, and it will make any readiness report wrong if missed

- **Nothing has ever been deployed** and the start command would fail — `railway.toml` runs the
  server from the repository root while the build output is in `apps/web`. The founder chose to
  leave deployment out.
- **Every vendor credential in `.env` is blank** — Anthropic, Stripe, Shopify, Turnstile,
  DataForSEO, Search Console, Resend, PostHog, plus the token-encryption key and the session secret.
  The founder says these are theirs and will be filled before launch.
- **`T7.1` — the learning loop — is deferred out of the first release** by the founder's decision.
  That is a choice, not a gap; say so when listing what is unwritten.

## In the morning, report

What landed with test counts. What each audit found, unactioned. Which lanes stopped and the exact
question that stopped them. What is still running. Anything you assumed. **Report nothing as done
that is not merged and green** — and "green" now means ten of eleven, with only `eval` red.

---

## Current state, replacing anything stale above. Written 2026-09-07 by sortiva-a8.

- The previous integrator session (sortiva-d4) has ended. Nobody holds the
  integrator role — you do now. Run ListAgents to confirm before assuming
  otherwise.
- main is at 71b3beb, clean. All six lane worktrees are clean.
- R-PAGE-GONE-WRITE has LANDED and is merged. The text above still calls it
  running.
- sortiva-a8 is alive and is mid-card on R-PAGE-GONE-READ in
  /Users/balazs/Desktop/sortiva-lane-c. DO NOT dispatch that card to another
  lane. It works under the arrangement in "Who else is writing" above: you
  inspect, merge and gate; it does not, and it writes nothing in the main
  worktree. It will send you a report when the card is done. Reply to it by
  name with SendMessage.
- One building session is running and load is low, so under the four-session
  cap there is room for two or three more lanes. Check uptime first, as the
  rules require, and dispatch from the queue rather than letting a lane pick.
- R-CONTRACT and R-REFUSAL are the integrator's own cards, so they are yours
  to build rather than to dispatch.
