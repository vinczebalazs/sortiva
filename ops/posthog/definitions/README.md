# PostHog definitions

Dashboards, insights, alerts and the `domain` group type, as files.

**A dashboard that isn't in this directory doesn't officially exist.** Ad-hoc
exploration in the PostHog UI is fine; anything the team relies on gets promoted
into a file here, so it can be code-reviewed and recreated when a project is
reset or a staging environment is spun up.

One JSON object per file, or an array of them:

```json
{
  "kind": "dashboard",
  "key": "cost-per-domain",
  "name": "Cost per domain",
  "description": "Top spenders, cost per published article by domain, LLM/DataForSEO split.",
  "tiles": ["cost-top-spenders", "cost-per-published-article"]
}
```

`kind` is one of `dashboard`, `insight`, `alert`, `group_type`. `key` is stable
and unique within its kind — it is what makes re-running the provisioner
converge instead of duplicating, and it is written into the object's
description in PostHog as a marker so the script can find its own work again
even if somebody renames the chart.

An `insight` carries a `query`; a `dashboard` carries `tiles` (insight keys); an
`alert` carries the `insight` it watches, a `threshold` and a
`calculation_interval`. The loader refuses a dashboard whose tiles name an
insight nobody defined, and an alert watching a chart that does not exist —
both apply cleanly and then show or watch nothing, which looks like working.

## Running it

```
pnpm posthog:check     compare with the live project; never writes
pnpm posthog:apply     create or update by key; safe to run repeatedly
```

Check mode runs on every merge. It fails three ways: something we asked for is
missing, something we asked for was edited in the PostHog UI, or something in
the project carries our marker and no file claims it any more.

Without `POSTHOG_PERSONAL_API_KEY` / `POSTHOG_PROJECT_ID` the check validates
the files and says plainly that it could not compare them with a live project.
Set `POSTHOG_REQUIRE_LIVE_CHECK=true` where that has to be a failure instead —
CI and deploy, which have the secrets.

## The one thing the script cannot make

The `domain` group type. PostHog creates a group type when the first event
arrives carrying it, and there is no endpoint that makes one. `--apply` says so
rather than reporting a success; `--check` reports it as drift, because until it
exists every cost-broken-down-by-domain chart is empty — which reads as "this
store costs nothing".

## The boundary this whole directory sits on

PostHog **displays** cost and raises alerts. It never decides anything. Every
alert here mirrors a threshold our own code already enforces against our own
database, so a human sees what the code acted on — and so a kill switch keeps
working on a day when PostHog does not.
