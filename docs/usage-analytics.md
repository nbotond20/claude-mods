# usage-analytics

One central store for everything about how every profile spends tokens, with a terminal report and a web dashboard.

## Two data sources, one database

1. **Transcripts** (all history, every profile): `<config dir>/projects/**/*.jsonl` for `~/.claude*` and every registered or configured profile dir, subagent transcripts included (`<session>/subagents/agent-*.jsonl` + `.meta.json`). These carry exact per-request usage: input, output, cache read, 5m/1h cache writes, thinking, server tools, model, effort, speed, plus every tool call and result, prompts, attachments, system events (turn durations, compactions, API errors) and titles.
2. **The mod's live event log** (sessions run with the mod installed): `<mods home>/usage-analytics/events/<profile>/<day>/<session>.<ts>.<n>.jsonl`. It records what transcripts cannot:
   - time to first token and step latency;
   - tool latency and denials;
   - the `/context` category breakdown;
   - tool schema sizes and whether each is deferred;
   - system prompt section sizes;
   - rate-limit percentages;
   - compaction before and after;
   - environment: git, gateway host, a settings subset and enabled plugins.

`bin/claude-usage ingest` folds both into **`<mods home>/usage-analytics/usage.db`** (SQLite, WAL). Ingest is incremental by byte offset and lock-protected; `--full` rebuilds. The dashboard server ingests within about a second of any activity (see *Live updates*). The mod also runs an ingest 45s after a session starts and then every 30 minutes, as a fallback when the server is not running.

## Setup, backfill and the server

Nothing is required: on first start the mod writes its config with defaults, registers the profile's config dir, starts the dashboard server and toasts once that `/analytics setup` can tailor it. **`/analytics setup`** runs `claude-usage setup --json` (detected profiles with history, what is already imported, the port) and asks which profiles to track, whether to keep prompt text, and when the dashboard runs.

**Backfill.** When the server starts it imports every transcript already on disk in the background, so the dashboard has your full history from day one. The page shows a progress bar (files, requests, %) and redraws as data arrives; an empty database shows a first-run screen instead of empty charts. `/api/meta` carries the same `progress`.

**One server per machine, started when needed.** Every session start, every `/analytics` command and `/dashboard` start it if it is not running (a lock file keeps it to one), and replace one older than the installed mod. `claude-usage autostart on` also starts it at login (a launchd agent on macOS, a systemd user unit on Linux); `off` removes it. `"dashboard": false` keeps it off until you run `/dashboard`.

## Use it

| | |
| --- | --- |
| `/analytics setup` | the setup wizard |
| `/dashboard [tab]` or `/analytics dashboard [tab]` | starts the dashboard in the background and opens **http://127.0.0.1:8787/** (on a tab: live, overview, cost, context, tools, agents, projects, prompts, health, engine, advisor, impact, savings, sql) |
| `/analytics advise` | research how to use Claude cheaper, with fewer tokens, faster and more reliably, here in the conversation ([below](#the-advisor)) |
| `/analytics advise bg` · `show` | the same research in the background · the trends, findings and recommendations in the terminal |
| `/analytics advise apply <id>` | shows the exact change, asks before making it, and starts measuring it |
| `/analytics advise trial <id>` | runs a recommendation that is a model instruction as an A/B trial: a random half of new sessions get it |
| `/analytics advise applied\|accept\|dismiss\|revert <id> [note]` | record what you did with a recommendation (a dismissal's note teaches the next run) |
| `/analytics advise reproduce <id>` | re-runs a recommendation's evidence queries and its verification, and says whether they give the same numbers |
| `/analytics impact [--days N] [--profile P]` | are the mods saving money or costing more ([mod-impact.md](mod-impact.md)) |
| `/analytics status` · `/analytics ingest` · `/analytics stop` | data and dashboard status · ingest now · stop the dashboard |
| `/analytics [overview\|daily\|models\|projects\|tools\|bash\|files\|agents\|sessions\|context\|hours\|cache\|prompts\|all] [--days N] [--profile P] [--project x]` | terminal report (ingests first) |
| `claude-usage serve [--port 8787] [--daemon] [--open] [--tab T] [--quiet]` · `stop` · `status` · `impact [--json]` | the same from a shell |
| `claude-usage setup [--json]` · `autostart on\|off\|status` | what was detected · start the server at login |
| `claude-usage sql "SELECT …"` · `schema` · `export TABLE --format csv\|jsonl` · `reprice` · `path` | everything else |

`claude-usage` lives at `usage-analytics/bin/claude-usage` (Python 3, stdlib only). An alias is handy:
`alias claude-usage='python3 ~/Desktop/projects/claude-mods/usage-analytics/bin/claude-usage'`.

## The advisor

A loop that keeps looking for ways to spend less on Claude Code, and checks whether its advice worked:

1. **Measure.** Fifteen metrics per session, grouped by goal. *Cost*: cost per prompt, premium-model share, spend inside subagents. *Tokens*: tokens per prompt, main-loop context, cache hit rate, tool output per prompt, whole-file reads, output per request, share of prompts not in English, prompt length. *Speed*: requests per prompt, turn time. *Reliability*: tool error rate, API errors, compactions. For each one you get eight weekly values and the last 7 days against the 28 before, with a bootstrap 95% interval.
2. **Detect.** Deterministic findings, no model involved, each tied to the metric it moves: large contexts, a low cache hit rate, whole-file reads, heavy tool output, a failing tool, serial tool calls, premium models in subagents, non-English prompts, frequent compaction, API errors, and big always-loaded MCP schemas. It also diffs consecutive session starts to show your own setting changes (model, effort, plugins, version).
3. **Research.** An agent (`usage-analytics:advisor`) reads all of the above. That includes every earlier recommendation with its measured verdict and evidence grade, a track record per goal and per kind of change, its earlier notes, each metric per project, profile and entrypoint, and a sample of prompts. It looks up current guidance on the web and records 3–6 recommendations, held to the rules below.
4. **Apply or trial.** `/analytics advise apply <id>` shows the change and asks before making it. You can also make the change yourself and run `/analytics advise applied <id>`, or use the dashboard's buttons. A recommendation that is a model instruction (read ranges, batch calls, …) can instead run as an **A/B trial** (`/analytics advise trial <id>`, or *Start A/B trial*).
5. **Verify.** Each applied or trialled recommendation is measured on its own metric and on the guard metrics (cost per prompt, round trips, tool errors, API errors, turn time) for side effects. Verdicts:
   - **helped**
   - **helped, with a cost**: a guard metric got worse by at least 10% and past a small absolute floor
   - **made it worse**
   - **no measurable effect**: the interval rules out half the expected effect, or there are already as many sessions as the power calculation asked for
   - **measuring…**: until there are 8 sessions on each side

   You get a toast when a verdict changes. The next research run reads the verdict: it builds on what helped, proposes reverting what backfired or did nothing, and does not repeat what you dismissed.

### How it keeps the advice honest

**Claims come from your data and can be re-run.** Every number in a recommendation is an `{claim, sql}` pair. The query is re-run when the recommendation is recorded, and the result is stored next to it. A failed query, a recommendation with no query, a recommendation without a primary source (Anthropic's docs, pricing, changelog, or the anthropics GitHub repos), or an expected effect too small to detect becomes a warning on the card. Research notes keep their source, published date and the day they were checked. Notes older than 90 days are flagged stale, and the next run re-checks them against the changelog.

**Fitted to you.** Your data beats web advice. The brief shows each metric by project, profile and entrypoint (interactive vs automated). A recommendation can be scoped to the projects or profiles where its lever lives. Every scoped recommendation is measured only there, and its verdict is broken down per project, because what helps one project can hurt another. The track record (success rate per goal and kind of change, Laplace-smoothed) steers the next run away from advice that keeps failing for you.

**Measured with the strongest design the data allows.** Each recommendation gets an evidence grade:

| Design | When | Grade |
| --- | --- | --- |
| **randomized** | an instruction on trial: a random 50% of new sessions get it (FNV hash of rec and session id, logged as `advisor_arm` events); after adopting it, 10% stay a holdout so the effect stays measured | **A** |
| **control group** | a scoped change with enough untouched sessions: the change in scope net of the change outside it (difference in differences) | **B** |
| **before/after + placebo** | the 28 days before vs after, plus the same comparison one window earlier, which should show nothing. If that placebo finds a drift, the estimate is trend-adjusted. | **B** without confounders, else **C/D** |
| evidence only | re-run queries plus a primary source, not yet measured | **C** |
| anything weaker | | **D** |

Confounders, meaning setting changes and other recommendations started within 7 days, are listed on the verdict and keep it out of grade B.

**The statistics.** Metrics are ratios of per-session sums. Comparisons are directly standardized by project, so a change in which projects you worked on does not read as an effect. Intervals come from a stratified percentile bootstrap: 1000 resamples for a verdict, 400 for side effects. Before recording, a delta-method power calculation (80% power, 5% level) estimates how many sessions a verdict will need at your pace, and the advisor prefers metrics that can detect the effect. For example, a 20% drop in whole-file reads shows within days, while a 20% drop in cost per prompt can take months. Trends are a Theil–Sen slope with a Mann–Kendall p-value, and count only when they move at least 5% over the eight weeks.

**Reproducible.** Seeds come from the recommendation id and the metric, and every verdict stores its method version, seed, resamples, windows, data version and a hash of the session ids. `/analytics advise reproduce <id>` re-runs everything and reports `identical` when nothing changed. `tests/test_advisor_stats.py` checks the statistics on synthetic sessions with a known truth: a real effect is found and covered by the interval, a null is rarely flagged, a change in the mix of work is ignored, the same input gives the same numbers, and power() matches simulation.

**When it runs.** `/analytics advise` runs the research in the conversation, where you can watch and steer it. Every `advisorEveryDays` (default 7), an interactive session starts it in the background about three minutes in, on `advisorModel` (default Sonnet). A lock keeps it to one run per machine.

The background agent can use only WebSearch, WebFetch and the mod's own four tools. The mod answers those four tools itself and never runs a shell for the agent. The agent runs with `dontAsk`, so anything else is refused instead of prompting, and it never edits files.

**Where it lives.** Everything is stored in `<mods home>/usage-analytics/advisor.db`: runs, recommendations, verdict checks and research notes. Instructions on trial or adopted are in `advisor-trials.json`, which the mod reads at each new session. While one is active, it adds a short `usage-analytics:advisor` system-prompt section in that trial's 'on' sessions, and only there. `claude-usage advise show|brief|sql|set|…` reads and writes the same data from a shell.

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

**Cost.** `cost_usd` is the list price from `<mods home>/usage-analytics/pricing.json`. Models are matched by substring, longest key first; fast mode is ×2. After editing the file, run `claude-usage reprice`. Gateway (LiteLLM) billing can differ; budget-guard shows that separately.

## Config: `<mods home>/usage-analytics/config.json`

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
| `port` | 8787 | dashboard port (127.0.0.1 only) |
| `advisorEveryDays` | 7 | days between background advisor runs (0: only on `/analytics advise`) |
| `advisorModel` | `sonnet` | the background advisor's model |
| `advisorNotify` | true | toast when an applied recommendation gets a verdict |
| `profileDirs` | `[]` | config dirs to read transcripts from; empty = auto: `~/.claude*` plus every config dir a session registered under `profiles/` |

## Files

- `usage-analytics/hooks/register.ts`: the collector. Events are buffered and flushed every 15s, at 400 events, and at session end. It also registers `/analytics` and `/dashboard`.
- `usage-analytics/bin/claude-usage`: ingest, report, sql, export and serve.
- `usage-analytics/bin/dashboard_api.py`: the dashboard server and its queries.
- `usage-analytics/bin/impact.py`: the mod impact analysis.
- `usage-analytics/bin/advisor.py`: the advisor's metrics, findings, verdicts and store (`advisor.db`).
- `usage-analytics/dashboard/index.html`: the page.
- `usage-analytics/tests/usage-analytics.test.ts`: event paths, ordering, facets, and a check that no secret leaks.
- Data lives in `<mods home>/usage-analytics/` (or `$CLAUDE_USAGE_DIR`): `usage.db`, `events/`, `pricing.json`, `config.json`, `profiles/<profile>.json` (registered config dirs), `advisor.db`, `advisor-runs/` (each research run's raw result), `dashboard.log`, `dashboard.lock`, `ingest.lock`, `live/<profile>.json` (activity pulses).

## Secrets

Before anything is written, the mod (event files) and the ingester (`usage.db`) blank anything that looks like a credential: API keys (`sk-…`, `ghp_…`, AWS, Slack), JWTs, `Bearer`/`Basic` values, `*TOKEN*=`/`*SECRET*:`/`--password=` values, URL passwords, private keys, and string values under keys such as `apiKey` or `authorization`. `claude-usage scrub` applies the same redaction to data stored earlier (DB rows and event files) and vacuums the DB. Claude Code's own transcripts in `~/.claude*/projects` are untouched.

## Troubleshooting

- **Dashboard shows old data:** click *Ingest now*, or run `claude-usage ingest`.
- **Port in use:** set `port` in the config (or run `/analytics setup`).
- **Stop the dashboard:** `/analytics stop` or `claude-usage stop`. It comes back at the next session start unless `"dashboard": false`. After a mod update, the next session start replaces an older running server by itself.
- **Sidebar says "reconnecting…":** the server stopped. Any `/analytics` command or new session starts it again, and the page reconnects on its own.
- **Open on a tab:** `http://127.0.0.1:8787/#impact`.
- **Engine tab empty:** only sessions started after the mod was installed have mod events. Restart old sessions.
- **Numbers look doubled after a format change:** `claude-usage ingest --full`.
