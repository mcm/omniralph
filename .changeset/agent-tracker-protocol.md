---
"@omniralph/agent": minor
---

The agent speaks the tracker-neutral protocol: the read-only tools are `tracker_get_issue`, `tracker_list_comments`, `tracker_search_issues` and `tracker_get_document` (served under `/api/agent/runs/{id}/tracker/*` with the `tracker:read` scope), playbooks list them under `tools.tracker` and turn them on with `toolSettings.trackerRead`, and ralph payloads carry `trackerIssueId`, `trackerProvider` and `source: "tracker"`. This release and the control panel ship together: older agents don't claim runs that use the tracker protocol.
