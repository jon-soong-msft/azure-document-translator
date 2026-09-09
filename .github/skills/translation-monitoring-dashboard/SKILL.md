---
name: translation-monitoring-dashboard
description: Build an interactive HTML dashboard of the deployed Document Translator's translation telemetry (completed/failed counts, characters, cost and processing time) from Azure Container Apps logs in Log Analytics. Use when asked to show/visualize monitoring, a translation dashboard, usage/cost/latency, or how the live app is doing.
---

Use this skill when someone wants to **see** how the deployed app is performing —
"show the monitoring", "translation dashboard", "how many translations
completed/failed", "usage and cost", "latency" — rendered as an interactive HTML
page instead of a raw log dump.

## What it does
- Resolves the Log Analytics workspace attached to the Container Apps environment.
- Queries `ContainerAppConsoleLogs_CL` for the structured `event:"translation"`
  records emitted by `src/lib/telemetry.ts`.
- Writes a **self-contained, interactive** `monitoring-dashboard.html` (no CDN,
  opens offline, shareable) with:
  - KPI cards: completed, failed, success rate, async jobs submitted, characters,
    cost (USD), average and max processing time.
  - "By mode" and "By status" bar breakdowns.
  - A Failures panel (only shown when there are failures).
  - A filterable, sortable events table (filter by mode / status / file type or
    error; click any column to sort).

The HTML embeds a point-in-time snapshot of the events, so re-run the script to
refresh the data.

## Command
Run from the repository root (requires `az login` with access to the
`rg-<your-azd-env-name>` resource group). Use **pwsh** (PowerShell 7+) — the script
auto-relaunches under pwsh if started from Windows PowerShell 5.1, because 5.1's
console encoding corrupts az's UTF-8 JSON and drops log rows:

    pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/monitoring-dashboard.ps1 -Open

Change the time window (default 24 hours):

    pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/monitoring-dashboard.ps1 -Hours 2 -Open

`-Open` launches the generated HTML in the default browser. Omit it to just write
the file (e.g. `monitoring-dashboard.html` in the repo root).

## Optional overrides
- `-Hours` — look-back window in hours (default 24).
- `-OutFile` — output path (default `monitoring-dashboard.html` at repo root).
- `-WorkspaceId` — Log Analytics workspace GUID (customerId); auto-resolved from
  the resource group when omitted.
- `-SubscriptionId`, `-ResourceGroup`, `-Endpoint` — target overrides.

## Telemetry event shape (for reference)
Each translation attempt logs one JSON line: `status` (started | completed |
failed), `mode` (text | layout), `fileType`, `sizeBytes`, `chunks`, `characters`,
`charactersCharged`, `costUSD`, `processingMs`, `httpStatus`, `errorType`.

## Notes
- Large layout PDFs use the async split path: they log one `started` event at
  submit and later one `completed` (or a `failed`). A `started` with no matching
  `completed` usually means the job was abandoned or re-submitted — not an error.
- Keep the KQL on a single line inside the script — a multi-line query passed
  through `az --analytics-query` on Windows loses interior lines (e.g. the event
  filter) and returns unrelated rows.
- `az containerapp logs show` (live tail) can throw a Windows `cp1252` encoding
  error on the Next.js startup banner; the Log Analytics query this skill uses is
  the reliable path.
- The generated `monitoring-dashboard.html` is a disposable artifact and is
  git-ignored.
