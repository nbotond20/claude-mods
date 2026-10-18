# Changelog

## 0.1.1
- Grafana without a login is a Viewer that can explore and try edits but save nothing, so a web page cannot change it (CSRF). The admin password is passed to Grafana as a mounted file, never on a command line; saving needs the admin login.

## 0.1.0
- New mod: a local observability platform. Grafana, Tempo, Loki and Prometheus run in one Docker container on 127.0.0.1, and every profile sends Claude Code's own OpenTelemetry to it. Seven dashboards (overview, traces and waterfall, where time goes, errors, logs, session, tools/hooks/MCP), `/obs`, and `claude-obs backfill` to replay past transcripts.
- Grafana needs no login to browse and edit dashboards (Editor). Data sources, plugins and users need the `admin` login, whose password is generated once and kept owner-only. Grafana only answers on the 127.0.0.1 hostname, which blocks DNS rebinding.
