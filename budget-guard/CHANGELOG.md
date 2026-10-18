# Changelog

## 0.13.4
- `/mods` and `bin/mods install` know the new observability mod (local Grafana: traces, logs, metrics and dashboards for every profile).

## 0.13.3
- Keep-alive pings once, not up to 6 times. In the usage data only idle stretches of one ping were followed by a cache read; the 6-ping stretches all ran out before you came back (net −$1.29 over 23 stretches).
- The keep-alive saving is counted only when you are back within 5 minutes of the ping. Before, any later prompt counted as a saved cache write, even one an hour later after the cache had expired.

## 0.13.2
- The band's LiteLLM `24h` and `7d` now match LiteLLM's UI: whole synced days only, today left out. `24h` is yesterday's spend and `7d` the six days before today, so the band and LiteLLM's "Last 24 hours" and "Last 7 days" show the same numbers. The 10-minute key readings (`key-history/`) are no longer taken; old files can be deleted.
- Docs: screenshots of the band, the new-task hold and the savings pane.

## 0.13.1
- On a LiteLLM gateway the band shows the key's spend over the last 24 hours and 7 days (`· 24h $x · 7d $y`), also in `/budget`. 24h is marked `~` while it is estimated from per-day figures (until a day of 10-minute readings exists).
- `bin/mods install` asks which mods to install when run in a terminal (Enter = all); `--except a,b` skips some, `--only` and `--yes` skip the question.
- Docs: "On by default" table, every /budget command and the holdout scope corrected.

## 0.13.0
- Finer session routing: five tiers instead of three. Trivial asks (start a server, open a file, a one-line answer) run on Haiku 5.5; quick questions on Sonnet 5.5 at low effort; small, well-defined edits on Sonnet 5.5 at medium; real coding work on Opus 5.5. A Haiku session that gets a real follow-up moves up (implementation verbs → Opus, longer prompts re-ranked by Haiku). `/budget route haiku` pins Haiku.

## 0.12.0
- On a LiteLLM gateway the day and month gauges come from LiteLLM's per-day spend (`/user/daily/activity`), so they are right from the first session instead of counting from when budget-guard was installed. Gateways without that endpoint keep the key-baseline method.

## 0.11.0
- A session routed to Sonnet moves to Opus when a later prompt asks for implementation ("ok, implement it"). A local check of ~150 verbs and go-ahead phrases ("do it", "lgtm", "option 2", a few Hungarian ones) decides for free; only long prompts with no match cost one Haiku call. Never downgrades; `/budget route sonnet|opus` pins the model.

## 0.10.0
- Compacts at `compactAt` (default 200k) whatever `autoCompactWindow` says; `/budget compact <n>|off`.
- The Opus effort cap covers subagents too and is set by `opusMaxEffort`.
- `/budget pause 2h` (or `session`) lets routing, the effort cap, compaction and trimming step aside; budgets stay. `/budget resume` ends it.
- Joins `/mods`: one combined toast for first runs and updates, `/mods status`, `setup`, `doctor` and `uninstall`.

## 0.9.0
- Setup wizard, a shared data folder any profile can use, and a holdout share for `/analytics impact`.
