# Changelog

## 0.1.8
- The profile lists show every profile from the last 90 days, whatever time range the dashboard is on (a profile used only last week was missing from a 24h view). Live profiles come from their metrics. Profiles seen only in transcripts come from a marker the backfill now writes per profile.

## 0.1.7
- Profiles that share one `settings.json` through a symlink are told apart. The profile is no longer a fixed `OTEL_RESOURCE_ATTRIBUTES` value (whichever profile wrote it last tagged them all). Instead an `otelHeadersHelper` sends the session's config dir name, and the collector, now configured by the mod, writes it into `claude.profile`. Live data recorded before this may sit under the wrong profile; backfilled data was always right.
- The profile lists only show `claude` and `claude-*` profiles, so test runs and probes tagged otherwise stay out.

## 0.1.6
- `/obs setup` asks whether to replay past sessions (30 days, 7 days or no) in the same selectable question as the other settings, instead of offering it in plain text.

## 0.1.5
- Docs: a README for the mod with screenshots, and how to remove the stack and telemetry env before uninstalling.

## 0.1.4
- Screenshots in the docs and README, from generated demo data (`scripts/demo/observability-demo.py`, `scripts/demo/shoot-grafana.mjs`).
- `CLAUDE_OBS_NAME` runs `claude-obs` against a second container next to the real one (used for the docs demo).

## 0.1.3
- New **Compare** dashboard (`/obs open compare`): two sides, A and B, each a set of profiles and models (by default every direct subscription profile against the LiteLLM one). Every figure shows A, B and "B vs A" in percent, colored green or red: latency and time to first token percentiles, tokens per second, error, retry and tool failure rates, cost per request and per prompt, cache hits, A/B over time, and per model, tool, operation, event and error status.
- New **Breakdown** dashboard (`/obs open breakdown`): every event and every timed operation (each model, tool, hook event and MCP server) on one scale, with calls, total time, share of time, mean, p50, p95, max, failures and failure rate; what takes longest, what fails most, and where the time goes.

## 0.1.2
- `/obs up`, `open` and `backfill` work whatever is already running. They reuse a current or newer stack, replace an older one, restart one that doesn't answer, start an installed Docker runtime (colima, OrbStack, Docker Desktop), run one at a time across sessions, and name whatever else holds a port.

## 0.1.1
- Grafana without a login is a Viewer that can explore and try edits but save nothing, so a web page cannot change it (CSRF). The admin password is passed to Grafana as a mounted file, never on a command line; saving needs the admin login.

## 0.1.0
- New mod: a local observability platform. Grafana, Tempo, Loki and Prometheus run in one Docker container on 127.0.0.1, and every profile sends Claude Code's own OpenTelemetry to it. Seven dashboards (overview, traces and waterfall, where time goes, errors, logs, session, tools/hooks/MCP), `/obs`, and `claude-obs backfill` to replay past transcripts.
- Grafana needs no login to browse and edit dashboards (Editor). Data sources, plugins and users need the `admin` login, whose password is generated once and kept owner-only. Grafana only answers on the 127.0.0.1 hostname, which blocks DNS rebinding.
