# PostHog definitions

Dashboards, insights, alerts and the `domain` group type, as files.

**A dashboard that isn't in this directory doesn't officially exist.** Ad-hoc
exploration in the PostHog UI is fine; anything the team relies on gets promoted
into a file here, so it can be code-reviewed and recreated when a project is
reset or a staging environment is spun up.

One JSON object per file (or an array of them):

```json
{
  "kind": "dashboard",
  "key": "cost-per-domain",
  "name": "Cost per domain",
  "description": "Top spenders, cost per published article by domain, spend vs. plan price, LLM/DataForSEO split."
}
```

`kind` is one of `dashboard`, `insight`, `alert`, `group_type`. `key` is stable
and unique within its kind — it is what makes re-running the provisioner
converge instead of duplicating.

`node scripts/posthog-provision.mjs --check` compares this directory against the
live project and fails on drift; CI runs it on every merge. The
directory is empty through M0: the launch dashboards ("cost per domain",
"preview economics", the funnel, the calibration report) land with T8.4, which is
the card that has events to put on them.
