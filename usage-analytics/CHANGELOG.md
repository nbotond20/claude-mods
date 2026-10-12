# Changelog

## 0.9.1
- Tests follow 0.9.0: the advisor test checks that nothing starts on its own and drives the background run through `/analytics advise bg`.

## 0.9.0
- The advisor no longer starts by itself. It used to start in the background about three minutes into an interactive session every 7 days, and its report showed up in that session as a message from `@usage-analytics-advisor`. Now it runs only on `/analytics advise` or `/analytics advise bg`. `advisorEveryDays` is gone.
- Gateway spend: on a LiteLLM gateway the mod copies what LiteLLM billed per day and model (spend, requests, tokens; from `/user/daily/activity`, back 12 months on the first run, `gatewayMonths` in config.json) into `<data>/gateway/<profile>.json`, and the import loads it into a new `gateway_spend` table. No credentials are stored.
- `claude-usage report gateway`: billed vs list-price estimate per day, and billed by model; the overview includes it when there is gateway data.
- The background advisor's tool calls are answered when they carry the short tool name (`advisor_brief`) or when the mod's logging of the call fails; before, its run failed with "no tool.call hook answered this call".
- The dashboard shows a "billed by the gateway" tile next to the list-price spend, with the ratio between them.

## 0.8.1
- The advisor's tools are answered after the mod reloads mid-session; before, its run failed with "no tool.call hook answered this call".

## 0.8.0
- A weekly digest toast: last week's spend against the week before, the top project and new advisor suggestions (`weeklyDigest` in config.json turns it off; `/analytics digest` any time).
- Shareable summaries: `/analytics summary [--days N] [--format html] [--no-projects]`, and a Share summary button in the dashboard.
- The import bar shows its stage (sessions, subagents, mod events) and profile, and says the numbers are partial until it finishes.
- Setup checks for python3 first and says how to install it.
- Joins `/mods`: one combined toast for first runs and updates, `/mods status`, `setup`, `doctor` (python3, the dashboard and its autostart) and `uninstall`.

## 0.7.2
- Advisor text cannot escape its quoted block.

## 0.7.1
- Only the person starts advisor trials; user SQL is read-only.

## 0.7.0
- A statistical advisor and a cleaner dashboard.
