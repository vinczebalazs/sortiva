# Overnight run — operating rules

Founder asleep. These are the rules I am running under, written down so the
morning report can be checked against them rather than taken on trust.

## What I will do

- Run **four building sessions at most**, never five. Wave 1 stalled all five at
  once on a 12-core machine.
- **Merge each card into `main` as it lands**, run the full gate, and only then
  start the next card in that lane. A lane never runs two cards at once.
- **Run the audits the plan schedules** (`docs/agent-work-plan.md` §7) as their
  cards land. Audits are read-only. I will **hold their findings for the morning**
  rather than acting on them, unless a finding blocks the next card in that lane,
  in which case I stop the lane and say so.
- **Recover stalled sessions.** A killed session's work survives in its worktree;
  I check `git status` before restarting anything.

## What I will not do

- **Decide anything with no documented default.** If a card hits a genuine
  product choice that `docs/founder-decisions.md` does not already answer, I stop
  that lane, leave it clean, and move to another. I do not guess.
- **Act on an audit finding**, beyond stopping a lane.
- **Add a database migration outside a schema-wave card**, change a frozen
  contract, or touch another lane's directories.
- **Deploy anything**, or touch the Railway project.

## Where a default is assumed

`docs/founder-decisions.md` §C records nine defaults the spec assumed and flagged
for sign-off. Where a card needs one, I take the documented default, journal it in
`DECISIONS.md`, and list it at the top of the morning report under **"I assumed
these — say if any is wrong."** Every such assumption is one line, with the card
that depended on it, so it can be reversed before more is built on top.

## Order

**The citation sweep is done** — it landed as `b0c1413`, removing 1,007 spec
references and leaving 15, all in shipped migrations, for the reason journalled
in `DECISIONS.md`. So the tree is quiet in the way lanes need, and there is no
longer a whole-repo job waiting for a gap.

Order is now simply the dependency order in `docs/handoff-wave2.md`. The one
sequencing judgement left: the operations card slots **after `T2.1` and before
`T2.2`**, because `T2.1` is what makes background steps actually run — so it is
the first moment a diagnosis script can be tested against a store that is really
stuck rather than a fixture — and `T2.2` is the card most likely to strand one.

## The morning report will say

What landed, with test counts. What I assumed and where. What each audit found,
unactioned. Which lanes stopped and why. What is still running. Nothing will be
reported as done that is not merged and green.

---

# Hard rules, added after two failures in one session

Both failures had the same shape: I stated the correct rule, then acted against
it minutes later. Neither was caused by missing context — I had all of it. So
these are written as permissions rather than reminders, because a reminder is
what already failed.

## What I may do without asking

- Build a card, in a worktree **I created in this turn**.
- Merge a lane branch into `main` and run the full gate.
- Run an audit the plan schedules. Audits are read-only.
- **Stop** a lane, at any time, for any reason.
- Write to the state file below, and to `DECISIONS.md`.

## What I may never do without asking

- **`git add -A`, `git add .`, or `git commit -a`. Ever. Stage by explicit path.**
  This single command caused the damage on 2026-09-01: it swept another
  session's half-finished work into a commit of mine titled "docs: operating
  rules for the overnight run". Adding by path would have made the collision
  harmless — which is exactly what the spend-caps session did in the same folder
  at the same time, and why one commit is polluted rather than two.
- **Write or commit in a folder another session holds.** Mine are the worktrees I
  created this turn. The founder's sessions are invisible to me unless I look, so
  **run `ListAgents` before launching anything**, and treat the main folder as
  occupied unless I have just confirmed otherwise.
- **Exceed four concurrent building sessions**, and check `uptime` first. Five
  saturated a 12-core machine earlier the same day and all five stalled at once.
- **Restart a lane that stopped for a decision.** Stopped means stopped until the
  founder answers.
- **Act on an audit finding**, beyond stopping a lane and reporting.
- Rewrite history, force-push, deploy, or touch the Railway project.

## What "the founder answered a related question" does not mean

It does not mean "start". Answering *how* something should behave is not
authorising *that* it should happen now. When the next step is an action rather
than a plan, ask for it in one plain sentence and wait.

---

# The state file

`docs/overnight-state.md`, rewritten after **every** card lands or stops.

This exists because the thing that degrades over a long run is not capacity — the
session compacts and keeps going — but fidelity. Detail that lives only in my
context gets summarised away: which trap applies to which upcoming card, which
decision was taken and why, what an audit found. Detail that lives in a file does
not.

Subagents do not solve this. Each card already gets its own fresh context and a
self-contained prompt, and that part works. But no subagent spans two cards, so
the cross-card knowledge has nowhere to live except a document.

**It must contain:**

- Where each lane is: card, branch, state, and what it is waiting on.
- What has merged into `main`, with the gate result.
- **Every default assumed**, one line each, with the card that depended on it.
- **Every audit finding**, unactioned, with the card it concerns.
- Anything the *next* card in each lane must know — a trap, a seam another lane
  is building, a decision already taken elsewhere.
- Which lanes stopped, and the exact question that stopped them.

**The rules around it:**

- Re-read it before launching any card, and before any merge. Cheap, and it makes
  a compacted version of me self-correcting.
- Never report from memory what the file can be read for.
- **Its quality test: a completely fresh session, with none of this conversation,
  could take over from that file alone.** If it could not, the file is wrong. That
  is the same test the handoff documents already pass, and it is why losing this
  session entirely would cost little.
