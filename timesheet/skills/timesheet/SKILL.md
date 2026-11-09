---
name: timesheet
description: Build or adjust the user's NetSuite timesheet (day, week or month) from their Claude Code and OpenCode sessions, git history, GitHub activity and Google Calendar using the `timesheet` CLI. Use when the user asks for their timesheet, hours, what they worked on, or to fix/rebook hours or task categories.
---

# Timesheet

All logic lives in the `timesheet` CLI. Never compute hours yourself; call the CLI and relay or adjust through it.

## Read

- `timesheet day [today|yesterday|-N|YYYY-MM-DD] --json`
- `timesheet week [this|last|-N|date] --json`
- `timesheet month [this|last|YYYY-MM] --json`

Useful flags: `--target <h>` (normalize to other than the configured daily target), `--real` (book real rounded hours), `--refresh` (recompute cached days), `--format grid|lines|daily|internal`, `--no-header`, `--copy`.

The JSON has `paste` (the NetSuite text for the chosen format), `internal` (human-readable detail) and `days[]`, each with `entries` (project, category, capex, real, hours), `blocks` (time blocks with allocations and activity texts), `summary`, `warnings`, `flags` (problems that need the user, some blocking submission), `status` (final | partial | today), and `locked`, `holiday`, `lowActivity`, `confirmed` when set.

- Before a week is submitted, or when asked whether it is ready: `timesheet review [week] --json`. Relay each flag and each system's blocking reasons.
- "Why is X so high/low?": `timesheet why <date> "<Category>"` lists the blocks behind it.

When presenting:
- Show the `paste` text in a code block so the user can copy it; mention they can also add `--copy`.
- Report booked vs real totals and CAPEX/OPEX split.
- Surface every flag and warning, especially unclassified paths (fix with `timesheet scope add work|personal <glob>`), partial days and low-activity days.
- For a daily summary request, show `summary` per day.

Long ranges run as a resumable job: if a run is interrupted (Ctrl+C, closed terminal, crash), running the same command continues where it stopped. If another timesheet process (e.g. the web app) is already computing those days, the CLI waits for it.

## Adjust

- Rebook a category's hours for a day: `timesheet edit <date> "<Category>" <hours> [--project P]`, or `clear`.
- Recategorize a time block (ids from `days[].blocks[].id`): `timesheet block <date> <id> "<Category>"`, or `clear`.
- Meetings that should not count towards the daily target (booked at their real rounded hours on top of the day): `timesheet count <date> <blockId> no`; `yes` counts it again, `auto` returns to the config rule. For a recurring meeting, add a title word to `calendar.uncounted` (e.g. `timesheet config set calendar.uncounted '["All-hands"]'`).
- Mark paths as work or personal: `timesheet scope add work "<glob>" [project]` / `timesheet scope add personal "<glob>"`.
- A low-activity day (flagged): ask the user with AskUserQuestion: "Right as it is" → `timesheet confirm <date>`; "I was off" → add the date to `holidays`; the user types other hours under Other → `timesheet edit`.
- Undo a mistaken edit: `timesheet undo [date]`; list edits: `timesheet history [date]`.
- Locked days (submitted, or locked by the user) refuse edits. Do not unlock a submitted day on your own: ask first with AskUserQuestion ("Unlock and edit" / "Leave it"), since the site already holds its hours (`timesheet unlock <date>`).
- Every question to the user (a choice, a confirmation, which day or category) goes through AskUserQuestion with concrete options, never as plain text.

Category names must match the configured list exactly (see `timesheet day --json` entries or the config at `~/.timesheet/config.json`). Hours must be a multiple of the rounding step. After an adjustment, re-run the report and show the updated paste text.

## Settings

- Read any option: `timesheet config get <key.path>` (e.g. `target`, `scope.work`, `classifier.notes`); all: `timesheet config show`.
- Change one: `timesheet config set <key.path> <json-or-string>`; it is validated and rejected with reasons if invalid. It reports how many cached days will recompute; when the user wants past days kept as they are, add `--from <date>`.
- Days off (nothing is booked on them; recorded work only raises a warning, and hours set with `timesheet edit` still count): `timesheet config set holidays '["2026-12-24","2026-12-25"]'` (the full list).
- Never print or ask for Google client secrets or tokens; they live in the OS keychain.

## Setup problems

- Start with `timesheet doctor`: it lists sources, config problems, credential storage and calendar status.
- No config: the user runs `timesheet init` (terminal wizard, suggest `! timesheet init`) or `timesheet init --web` (browser wizard).
- Calendar not connected: `timesheet auth` (interactive; suggest `! timesheet auth`).
- GitHub not set up or a token failing: `timesheet github` shows status; `timesheet github add <label>` asks for the token hidden (suggest `! timesheet github add <label>`). A warning about a repo "not cloned here" needs a scope rule like `timesheet scope add work "github.com/<owner>/**"`.
- Web app (timesheet, calendar, settings): `timesheet serve --open`.

## Submission (Redmine, NetSuite)

- You may show what would be entered: `timesheet submit plan [week] --json` (read-only). Relay blocking reasons as they are.
- Entering happens in the web app: **Check {site}** first reads what the site already holds (read-only) and shows a grid of what is already there, what will be entered, and which days are held back because the site holds other hours. **Enter** only writes what that check showed, and re-reads each week before writing. Days off with hours already on the site are left as they are.
- Never run anything that enters data (`timesheet submit week …`), and never run `timesheet submit login|inspect`: they open a browser for the user. Tell the user the command instead.
