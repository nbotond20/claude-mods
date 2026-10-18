# observability

A free, local observability platform for Claude Code. Every profile (`~/.claude`, each `~/.claude-*`) sends its own OpenTelemetry metrics, events and traces to one Grafana stack on this machine. Its dashboards show where time goes, where errors happen and what each session cost, and every prompt opens as a trace waterfall.

**Free and local only.** The stack is the open-source [grafana/otel-lgtm](https://github.com/grafana/docker-otel-lgtm) image (Grafana, Tempo, Loki and Prometheus in one container), pinned to a fixed version. Every port is bound to `127.0.0.1`. Grafana and the backends have usage reporting and update checks turned off, no Grafana plugin is downloaded, and nothing leaves the machine.

Needs Docker. Any free runtime works: on macOS `brew install colima docker && colima start`, or OrbStack.

## On by default

| On right after install | Off until you turn it on |
| --- | --- |
| Telemetry written into every profile's `settings.json` `env` at the next session start (metrics, events, traces, detailed tracing), tagged `claude.profile=<profile>` | full tool outputs in events (`toolContent`) |
| prompt text, commands and file paths kept in the local store (`content`) | replaying past sessions (`claude-obs backfill`) |
| the stack started in the background at session start when Docker is running (`autostart`); data kept 90 days | |

Telemetry takes effect **from the next session** in each profile: Claude Code reads its OpenTelemetry settings at startup. A toast says so the first time.

The mod only changes settings keys it wrote. It marks them with `CLAUDE_OBS_MANAGED`. A profile that already sends OpenTelemetry somewhere else is left alone, and `/obs status` names it.

## Commands

| Command | What it does |
| --- | --- |
| `/obs` · `/obs status` | stack state, Grafana URL, data size and retention; per profile whether telemetry is on |
| `/obs open [overview\|traces\|time\|errors\|logs\|sessions\|tools\|compare\|breakdown\|explore]` | opens Grafana on that dashboard |
| `/obs up` · `/obs down` | starts (or replaces an outdated) stack · stops it; data is kept |
| `/obs backfill [--days N] [--profile P] [--dry-run]` | replays past transcripts as traces and events |
| `/obs telemetry on\|off [all]` | writes or removes the telemetry env in this profile, or in every profile with `all` |
| `/obs content on\|off` | keep or drop prompt text, commands and paths |
| `/obs setup` | a short guided setup |

The same from a shell, through `<plugin>/bin/claude-obs`:

```sh
claude-obs up [--quiet]          # start (or replace an outdated) stack
claude-obs down                  # stop and remove the container (data is kept)
claude-obs status [--json]
claude-obs open [dashboard]
claude-obs logs                  # the container's log
claude-obs backfill [--days N] [--profile P] [--dry-run] [--force]
claude-obs reset confirm         # stop the stack and delete its data
claude-obs env [profile]         # the telemetry env a profile's settings get
```

Grafana is at http://127.0.0.1:3301 and needs no login to browse dashboards and use Explore. Without a login nothing can be saved, so a web page that posts to Grafana cannot change anything. Saving dashboards and managing data sources, plugins and users take the `admin` login, whose password is generated at the first `claude-obs up` and kept owner-only in `<mods home>/observability/admin-password`. Grafana only answers on the `127.0.0.1` hostname, so a web page cannot reach it through DNS rebinding. OTLP listens on 127.0.0.1:4318 (HTTP) and 4317 (gRPC).

Anyone who can log in to this computer can reach 127.0.0.1 too. On a shared machine, turn `content` off or stop the stack when you're not using it.

## History: backfill

Telemetry only covers sessions started after install. `claude-obs backfill --days 30` reads every profile's transcripts and sends each past session as traces (prompt → model calls and tools) and events (prompts, API errors, tool results). The default is the last 90 days. `--profile work` limits it to one profile, `--dry-run` counts without sending anything, and `--force` resends sessions backfilled before (identical events are deduplicated). A session that already reported live is never replayed. Backfilled data carries `claude.source=transcript`.

## Dashboards

All dashboards except Compare share a **profile** filter and the time picker. Every session id and trace id is a link.

| Dashboard | Shows |
| --- | --- |
| **Overview** | sessions, prompts, cost, tokens, errors and active time per profile and model, at a glance |
| **Traces** | recent and slowest prompts; a trace id opens its waterfall (prompt → model calls → tools → hooks) |
| **Where time goes** | time split between model, tools and Claude answering; slowest tools, hooks and MCP servers; over time |
| **Errors** | API errors by status and model, tool failures, failing tools ranked, newest first |
| **Logs** | every event, searchable: prompts, tool results, API requests and errors |
| **Session** | one session: its prompts, each prompt's waterfall in place, cost over time, tools used |
| **Tools** | tool calls and durations, Bash commands, hooks, MCP servers, skills and plugins loaded |
| **Breakdown** | every event and every timed operation (each model, tool, hook event, MCP server) in one table: calls, total time and share, mean, p50, p95, max, failures and failure rate; what takes longest, what fails most, where the time goes |
| **Compare** | side A against side B, each a set of profiles and models: every figure as A, B and "B vs A" in percent, green when B is better and red when worse |

### Compare

Compare puts two sides next to each other: by default every direct (subscription) profile as A and `claude-infi` (LiteLLM) as B. Pick any profiles and models for each side in the pickers. It answers which side is faster and by how much (latency and time to first token at p50 and p95, tokens per second, prompt turn length), which fails more (API error, retry and tool failure rates), and which costs more (per request and per prompt, cache hits). It shows the same metrics over time and per model, tool, operation, event and error status. "B vs A" is (B − A) / A; within ±5% counts as a draw. Rates and per-request figures stay fair when one side was used far more. Time to first token and prompt turn length need live sessions: transcripts don't record them.

## Caveats

- **Some panels are live-only.** Latency percentiles and rates built from span metrics only fill for sessions that reported live, so they stay empty until telemetry is on and a new session has run. Backfilled history fills everything else.
- **Backfilled tool time includes permission waits.** A transcript only records when a tool was asked for and when its result came back.
- **Errors from transcripts have no status code.** They show as "from transcript", e.g. a lost connection or an expired login.
- **A session can appear twice.** A session that was backfilled while it was still running and then reported live has a live trace and a backfilled one.
- **Test profiles.** Profiles used for tests (for example `claude-test` or `claude-e2e`) report like any other; filter them out with the profile picker.
- **Old Bash commands.** In older backfilled data a Bash command can be keyed by an env prefix (`FOO=1 …`) instead of the program name.

## Config

`<mods home>/observability/config.json`:

| Key | Default | |
| --- | --- | --- |
| `telemetry` | `true` | write the telemetry env into profiles |
| `content` | `true` | keep prompt text, commands and file paths |
| `toolContent` | `false` | also keep full tool inputs and outputs |
| `detailedTracing` | `true` | model calls, tools and hooks as spans |
| `autostart` | `true` | start the stack at session start |
| `grafanaPort` · `otlpHttpPort` · `otlpGrpcPort` | `3301` · `4318` · `4317` | ports on 127.0.0.1 |
| `retentionDays` | `90` | how long Loki, Tempo and Prometheus keep data |

Data lives in `<mods home>/observability/data`. `claude-obs reset confirm` deletes it. Removing the mod: `/obs telemetry off all`, then `claude-obs down`.
