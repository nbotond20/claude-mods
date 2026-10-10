# usage-analytics

One central store for everything about how every profile spends tokens, with a terminal report and a web dashboard.

## Two data sources, one database

1. **Transcripts** (all history, every profile): `~/.claude*/projects/**/*.jsonl`, subagent transcripts included (`<session>/subagents/agent-*.jsonl` + `.meta.json`). These carry exact per-request usage: input, output, cache read, 5m/1h cache writes, thinking, server tools, model, effort, speed, plus every tool call and result, prompts, attachments, system events (turn durations, compactions, API errors) and titles.
2. **The mod's live event log** (sessions run with the mod installed): `~/.claude-shared/usage-analytics/events/<profile>/<day>/<session>.<ts>.<n>.jsonl`. It records what transcripts cannot:
   - time to first token and step latency;
   - tool latency and denials;
   - the `/context` category breakdown;
   - tool schema sizes and whether each is deferred;
   - system prompt section sizes;
   - rate-limit percentages;
   - compaction before and after;
   - environment: git, gateway host, a settings subset and enabled plugins.

`bin/claude-usage ingest` folds both into **`~/.claude-shared/usage-analytics/usage.db`** (SQLite, WAL). Ingest is incremental by byte offset and lock-protected; `--full` rebuilds. The dashboard server ingests within about a second of any activity (see *Live updates*). The mod also runs an ingest 45s after a session starts and then every 30 minutes, as a fallback when the server is not running.

## Use it

| | |
| --- | --- |
| `/dashboard [tab]` or `/analytics dashboard [tab]` | starts the dashboard in the background and opens **http://127.0.0.1:8787/** (on a tab: live, overview, cost, context, tools, agents, projects, prompts, health, engine, impact, savings, sql) |
| `/analytics impact [--days N] [--profile P]` | are the mods saving money or costing more ([mod-impact.md](mod-impact.md)) |
| `/analytics status` · `/analytics ingest` · `/analytics stop` | data and dashboard status · ingest now · stop the dashboard |
| `/analytics [overview\|daily\|models\|projects\|tools\|bash\|files\|agents\|sessions\|context\|hours\|cache\|prompts\|all] [--days N] [--profile claude-infi] [--project x]` | terminal report (ingests first) |
| `claude-usage serve [--port 8787] [--daemon] [--open] [--tab T] [--quiet]` · `stop` · `status` · `impact [--json]` | the same from a shell |
| `claude-usage sql "SELECT …"` · `schema` · `export TABLE --format csv\|jsonl` · `reprice` · `path` | everything else |

`claude-usage` lives at `usage-analytics/bin/claude-usage` (Python 3, stdlib only). An alias is handy:
`alias claude-usage='python3 ~/Desktop/projects/claude-mods/usage-analytics/bin/claude-usage'`.

## One server per machine, started for you

The dashboard server starts by itself. Each session start runs `claude-usage serve --daemon --quiet` in the background, and so does every `/analytics` command. Each run takes a machine-wide lock (`dashboard.lock`) and checks `127.0.0.1:8787/api/ping`:
- **Nothing is answering:** it starts the server.
- **The same or a newer version is answering:** it leaves it running.
- **An older version is answering:** it replaces it. After a plugin update, the next session therefore serves the new code with no manual restart.

When all three profiles start at once, only one server comes up. Set `"dashboard": false` in config.json to turn the auto-start off.

## Live updates

Every prompt, model request, tool call, turn end, compaction and session start or end touches `live/<profile>.json`. The touch is throttled to once per 750ms, except turn ends.

The server checks those files every second. On a change it does two things:
- It runs the incremental ingest: about 80ms when there is little new, and only the bytes added since last time.
- It runs it again 3s later, to catch transcript lines written after the touch.

Sessions without the mod are covered by a 20s fallback ingest.

Whenever an ingest reads something new, the server pushes an `update` event over server-sent events (`/api/stream`). The page then reloads the current view in place:
- charts animate to the new values;
- tables keep their sort, filter and scroll position;
- new feed rows flash.

The heavy views (Mod impact, Savings) show a "new data" banner instead of recomputing. The sidebar shows the connection state and when the last update came in. Hidden tabs catch up when they become visible again.

## The dashboard

It is served only on 127.0.0.1. It answers only requests addressed to `127.0.0.1`/`localhost`, which blocks DNS rebinding. `/api/sql` is read-only, and cross-origin POSTs are refused. The page is a single file, `usage-analytics/dashboard/index.html`. It uses Chart.js 4.4.1 from jsDelivr, pinned with SRI. The queries are in `bin/dashboard_api.py` (dict `Q`): add one there and reference it from a panel in `TABS`.

The filters (period, profiles, model, project) apply to every panel. Click any session id, or a dot in the session scatter, to open its drill-down.

**Layout**
- A sidebar groups the tabs: Now, Spend, Work, Quality, Mods, Data.
- The filter bar is sticky.
- The theme toggle switches between auto, light and dark.

**KPI cards**
- Each card shows its change against the previous period of the same length; *vs previous* turns this off. On *Today* the comparison is with yesterday up to the same time.
- No comparison is shown when the data does not cover the whole previous period.
- Each card has a daily sparkline.

**Every panel**
- expand to full screen;
- download as CSV;
- switch between chart and table;
- tables are sortable and filterable, with in-cell bars on cost and size columns.

**Keys**
- <kbd>⌘K</kbd> opens a command palette: go to a tab, set the period, pick profiles, ingest, toggle the theme.
- <kbd>[</kbd> / <kbd>]</kbd> previous or next tab.
- <kbd>r</kbd> refresh.
- <kbd>t</kbd> theme.
- <kbd>/</kbd> project filter.
- <kbd>esc</kbd> close.

| Tab | Shows |
| --- | --- |
| Live | Today against yesterday at the same time; the last 60 minutes ($/h); month to date with a projection and a progress bar; active sessions (last 30 min) with a context gauge, cost and cost in the last hour; spend and requests per minute for the last 3 hours by profile; today by hour; feeds of the latest model requests and tool calls. Uses the profile filter. |
| Overview | KPIs and automatic insights: the month's pace and projection, spend spikes (days above mean + 2σ), spend above 200k context, Bash share of output, whole-file reads, Write vs Edit, single-tool requests, cache hit rate, LSP use. Also daily spend by profile, spend by token kind, spend by context size, profiles, models, a weekday×hour heatmap, model family mix per day and the top sessions. |
| Cost & tokens | Daily spend by model; tokens per day; cost per 1k requests; cache hit and subagent share per day; requests per day by model family; spend by effort, entrypoint, stop reason, version and hour. |
| Context | Requests and spend by context bucket; main-loop context per day; tool calls per request (parallelism); the `/context` composition and its trend (from the mod); injected attachments. |
| Tools | Output by tool; per-day output; result-size distribution; Bash programs and commands (`capped` marks commands cut by lean-tools or budget-guard); whole vs ranged Reads; Edit vs Write; files by traffic; re-reads; extensions; LSP vs grep; MCP; skills; web; errors. |
| Agents | Spend by agent type; which model each type ran on; spawns by type and `model` parameter; the most expensive subagents. |
| Projects & sessions | Spend per day for the top 8 projects; a scatter of session cost against peak context (click a dot); spend by project and branch; the session cost distribution; the session list. |
| Prompts | Prompts and commands per day; message kinds; prompt length; slash commands; the most expensive prompts (all requests until the next prompt); recent prompts. |
| Health | API errors, compactions and notices per day; turn durations; recent errors; compactions. |
| Engine | From the mod: TTFT and latency by model; tool latency; tool schema sizes; system prompt sections; rate limits; event counts. |
| Mod impact | Per mod: holdout verdict, active vs holdout metrics with 95% intervals, the cost/savings ledger, nudge compliance, action counts, warnings. See [mod-impact.md](mod-impact.md). |
| Savings | From budget-guard's ledgers: dollars saved by lever, per day against spend, and per profile. |
| SQL | A read-only console with examples. ⌘/Ctrl+Enter runs the query. |

**Session drill-down:**
- context per request alongside cumulative cost;
- cost by agent;
- tool output by tool;
- every prompt, tool call, subagent and request.

## Database

| Table | One row per |
| --- | --- |
| `requests` | API request (deduped by message id): profile, session, agent, ts/day/hour, project, branch, version, entrypoint, model, effort, stop reason, speed, token counts, `cost_usd` |
| `tool_uses` | Tool call: tool, input chars, file/ext, `cmd` (first two words of the real command, wrappers unwrapped), pattern, subagent, skill, MCP server, detail, result chars/images, error |
| `prompts` | User-side message, by `kind`: prompt, command, command_output, shell, notification, compact_summary, agent_prompt, meta. Text is kept. |
| `attachments` | Injected context (reminders, skill listings, file snapshots…), with size |
| `system_events` | turn_duration, compact_boundary, api_error, … |
| `sessions` | Title, Claude Code's own cost, API/tool ms, lines added/removed |
| `agents` | Subagent: type, description, parent, spawn depth |
| `events` | Raw mod events, as JSON |
| `files`, `meta` | Ingest bookkeeping |

**Views:** `v_requests` (adds `context_tokens` and `agent_type`), `v_mod_steps`, `v_mod_tools`, `v_context`, `v_measure`, `v_compactions`, `v_tool_schemas`, `v_system_prompt`.

**Cost.** `cost_usd` is the list price from `~/.claude-shared/usage-analytics/pricing.json`. Models are matched by substring, longest key first; fast mode is ×2. After editing the file, run `claude-usage reprice`. Gateway (LiteLLM) billing can differ; budget-guard shows that separately.

## Config: `~/.claude-shared/usage-analytics/config.json`

| Key | Default | Meaning |
| --- | --- | --- |
| `storePrompts` | true | keep prompt text in the event log |
| `maxInputChars` | 4000 | tool input chars kept per event |
| `maxResultChars` | 0 | tool result chars kept (0 = size only) |
| `maxAnswerChars` | 2000 | assistant answer chars kept |
| `breakdownEvery` | 3 | `/context` breakdown every N main turns |
| `autoIngest`, `ingestEveryMin` | true, 30 | background ingest |
| `captureOtel` | true | also log Claude Code's own telemetry events |
| `dashboard` | true | keep the one dashboard server running (started at session start and by `/analytics`) |

## Files

- `usage-analytics/hooks/register.ts`: the collector. Events are buffered and flushed every 15s, at 400 events, and at session end. It also registers `/analytics` and `/dashboard`.
- `usage-analytics/bin/claude-usage`: ingest, report, sql, export and serve.
- `usage-analytics/bin/dashboard_api.py`: the dashboard server and its queries.
- `usage-analytics/bin/impact.py`: the mod impact analysis.
- `usage-analytics/dashboard/index.html`: the page.
- `usage-analytics/tests/usage-analytics.test.ts`: event paths, ordering, facets, and a check that no secret leaks.
- Data lives in `~/.claude-shared/usage-analytics/`: `usage.db`, `events/`, `pricing.json`, `config.json`, `dashboard.log`, `dashboard.lock`, `ingest.lock`, `live/<profile>.json` (activity pulses).

## Secrets

Before anything is written, the mod (event files) and the ingester (`usage.db`) blank anything that looks like a credential: API keys (`sk-…`, `ghp_…`, AWS, Slack), JWTs, `Bearer`/`Basic` values, `*TOKEN*=`/`*SECRET*:`/`--password=` values, URL passwords, private keys, and string values under keys such as `apiKey` or `authorization`. `claude-usage scrub` applies the same redaction to data stored earlier (DB rows and event files) and vacuums the DB. Claude Code's own transcripts in `~/.claude*/projects` are untouched.

## Troubleshooting

- **Dashboard shows old data:** click *Ingest now*, or run `claude-usage ingest`.
- **Port in use:** `claude-usage serve --daemon --port 8790`.
- **Stop the dashboard:** `/analytics stop` or `claude-usage stop`. It comes back at the next session start unless `"dashboard": false`. After a mod update, the next session start replaces an older running server by itself.
- **Sidebar says "reconnecting…":** the server stopped. Any `/analytics` command or new session starts it again, and the page reconnects on its own.
- **Open on a tab:** `http://127.0.0.1:8787/#impact`.
- **Engine tab empty:** only sessions started after the mod was installed have mod events. Restart old sessions.
- **Numbers look doubled after a format change:** `claude-usage ingest --full`.
