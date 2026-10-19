# Changelog

## 0.16.0
- Mod dialogs, per profile: every question a mod asks you (budget-guard's allow once / turn / session / deny, the setup wizards' questions the model asks for a mod, the new-task clear / compact / keep) with the answer you picked or that you dismissed it, every mod slash command with its reply, prompts a mod held back with its reason, and the mods' toasts. Works for every mod without changes to it: the questions are seen as AskUserQuestion calls and attributed to the calling mod.
- A **Mod dialogs** tab (under Work, `/dashboard dialogs`): counts, per day by mod, by mod and profile, the questions with their most frequent answers, and the newest dialogs with a link to the session. `/analytics dialogs` is the terminal report.
- Answers typed under Other are kept only when prompt text is (`storePrompts`).

## 0.15.0
- Gateway spend stays current: every open session on the key refreshes it every 15 minutes, not only once at start, and a failed fetch is recorded instead of silently keeping old numbers.
- One file per gateway key (`gateway/key-<fingerprint>.json`, never the key itself) listing every profile that used it, so a key shared by two profiles is counted once, under the profile that uses it most; its list-price comparison covers all of them. Older per-profile files are used only until the key's file exists.
- The Billed tile says when it was synced and the last day it covers, and turns red when the sync is over an hour old or failing.

## 0.14.6
- Dashboard: the info icon next to panel titles is centred in its circle again.

## 0.14.5
- Applying an advisor recommendation asks with selectable options (apply, dismiss, or an A/B trial for model instructions) instead of a plain-text question.

## 0.14.4
- Docs: a README for the mod with screenshots; the docs add `dashboardIdleMin`, the `quality` and `frustration` reports, `autostart sync`, the port message, what the dashboard loads from outside, and how keep-alive savings are measured in Mod impact.

## 0.14.3
- Stopping the dashboard only signals a process whose own command line is the dashboard, never a pid that whatever answers on the port names.

## 0.14.2
- The dashboard server starts reliably in every state: a newer one is never replaced by an older session, an older, hung or broken one is replaced, a port held by another program is named with how to change it, and the login item (when on) is kept on the newest CLI.

## 0.14.1
- `/mods` and `bin/mods install` know the new observability mod (local Grafana: traces, logs, metrics and dashboards for every profile).

## 0.14.0
- `/dashboard` (and `/analytics dashboard`) restarts the server every time, so the page always talks to a fresh one. `claude-usage serve --restart` does the same from a shell.
- `/dashboard stop` closes the server, like `/analytics stop`.
- The server closes itself once no dashboard page has been open and nothing was asked of it for `dashboardIdleMin` minutes (config.json, default 60, 0 keeps it running; `serve --idle-min N` for one run). The next session start, `/analytics` command or the login agent starts it again.

## 0.13.1
- Impact: keep-alive savings are measured, no longer taken from budget-guard's estimate. Each idle stretch of pings counts as saved only when the next main-loop request came within 5 minutes and read the cache, worth one cache write of what it read. budget-guard's own figure credited any later prompt, so it showed a saving where the pings had lost money.
- A warning when keep-alive cost more than it saved, with how many stretches paid off and how many ran every ping without one.

## 0.13.0
- Mod spend: a new tab under Spend with only what the mods themselves spend on models, nothing you or your own scripts ran. It covers the timesheet classifier (`claude -p`), the advisor and recurring agents, and budget-guard's Haiku classifier and keep-alive pings, which have no transcript and are read from its events. The Haiku classifier is priced from its input size at list price. It shows tiles with sparklines (total, share of all spend, in-session calls, runs, cost per run, context per request), spend per day by caller, a table by caller with its models, context per request by kind of call, spend by model and the most expensive runs. A `claude -p` caller that sends 15k+ tokens of context per call is flagged: that is Claude Code's own prompt riding along, and running it lean cuts it.
- A new `v_background` view (`caller`, `kind`, `run_id`); `/dashboard background`. Views are made again when the schema version changes.
- A dashboard server older than the page now says so (run `/dashboard` to restart it) instead of "not found" / "query missing".
- Docs screenshots redone from the demo data, now with the Background and Frustration tabs. The demo has annoyed follow-ups, interrupts, rejected calls, timesheet classifier runs, a nightly SDK script and mod agents. `scripts/demo/shoot-dashboard.mjs` takes every screenshot.

## 0.12.0
- Frustration meter: every main-loop prompt gets a score from 0 (calm) to 100 (rage), from swearing, insults, giving up, repeating yourself, blame, corrections, shouting, `!!`/`???` and elongated words, plus an interrupt, a rejected call or nearly the same ask just before it. Code blocks, pasted blocks, inline code, links and paths are left out, so pasted SQL or diffs do not count as shouting. Levels: mild 1-24, annoyed 25-49, frustrated 50-74, rage 75+. The rules and weights are in `bin/frustration.py`.
- A new *Frustration* tab under Quality: tiles with sparklines and the previous-period comparison, score per day and per week, heated prompts per day by level, a weekday × hour heatmap, by hour, which signals fire, by model and effort (the model that answered the turn before the prompt), by project, and the most heated prompts and sessions.
- `claude-usage report frustration`: overall, by week and day, signals, by model and effort, by project, and the most heated prompts.
- Advisor: *Frustration per prompt* and *Frustrated prompts per 100* under Quality; the frustrated-prompt rate is a guard metric.
- A new `mood` table (one row per prompt, no prompt text). The import scores the sessions it touched; the first import after upgrading, or a change to the rules, scores every prompt again (a few seconds).

## 0.11.0
- Output quality, so a cheaper setup can be shown to give results that are as good or better. A new *Quality* goal in the advisor and on the dashboard: corrections per 100 follow-ups, interrupts, rejected tool calls, edits that redo Claude's own new lines, turns whose last test/typecheck/lint/build passed, editing turns with a check, lines kept at the next commit and edited files committed. Plus *Cache writes after an idle gap* under Cost.
- Correction rate, check pass rate and interrupt rate are guard metrics now: a recommendation that saves money but makes one of them worse is graded *helped, with a cost*, not *helped*.
- `claude-usage report quality`: the quality numbers, then cost and quality side by side per model, per model and effort, and per project.
- The import records which shell commands are checks (`tool_uses.verify`), failure marks in their output (`flag`: a piped `npm test | tail` exits 0 even when tests fail), rejected and denied calls, and hashes of the lines each edit writes and replaces (never the code). A new `git_outcomes` table holds, per session, files edited and committed within 3 days and the written lines found in that commit. `gitOutcomes: false` in config.json turns the git lookups off.
- `[Request interrupted by user]` is its own prompt kind (`interrupt`). It used to count as a prompt, which inflated prompts and lowered every per-prompt metric.
- Upgrading reads the transcripts once more for the new columns (about a minute for 4 GB, resumed across imports when it runs out of time).

## 0.10.1
- Dashboard redesign, same data and queries. Every view uses one set of components: one tile, one tag, one table look, one notes list, and the same change format (−12%).
- Long explanations are folded under "How it works" at the top of the Advisor, Recurring, Mod impact, Savings and Engine tabs. Panel notes are one line; the details are in an ⓘ tooltip. Chart | Table is a switch in each panel header.
- Advisor: goals show as one grid. Recommendation cards show the change, the result and the warnings; hypothesis, evidence, sources and checks are under "Why & evidence". The measuring bar shows again (it was hidden by the import bar's style).
- Recurring: Open / All / Automated / Dismissed with counts in the heading; the expanded row is highlighted.
- Session drawer: context and cumulative cost are two charts instead of one chart with two y-axes.

## 0.10.0
- Recurring asks: a new Recurring tab and `/analytics recurring` find the prompts you keep typing (three or more times on two or more days), grouped by shared wording (no model; headless `claude -p`/SDK runs left out), with cost, trend and an automatable score. `/analytics recurring classify` (or `classify bg`) has a model draft a skill, hook, command or CLAUDE.md rule for each; mark one automated and the tab shows prompts per week before and after.
- New `claude-usage recurring [show|brief|record|set]`, tools `recurring_brief` and `recurring_record`, a hidden `recurring` agent, and `GET /api/recurring` with `POST /api/recurring/status` on the dashboard.
- Labels and statuses live in `recurring.db` and stay attached when the wording drifts.
- Demo data has recurring prompt families, and the docs have a tour screenshot.

## 0.9.2
- `bin/mods install` asks which mods to install when run in a terminal (Enter = all); `--except a,b` skips some, `--only` and `--yes` skip the question.
- Docs: "On by default" table, every command, config key and env var.

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
