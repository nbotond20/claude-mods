# Timesheet — design

Builds NetSuite-ready timesheets from Claude Code sessions, git history and Google Calendar.

## Goals
- Per day / week / month, produce hours per (project, task category).
- Two hour figures: **real** (activity incl. waiting on Claude, meetings) and **normalized** to a daily target (default 8, configurable, per weekday overridable).
- NetSuite paste formats: weekly grid (rows × Mon–Sun, TSV) and per-entry lines (date, project, category, hours). Bare numbers, no unit; decimal separator configurable.
- Internal view: time blocks, Claude-written daily summary, CAPEX/OPEX totals.
- Computed past days are cached in SQLite and not recalculated unless `--refresh` or scope changes.

## Surfaces
One TypeScript package (Node ≥ 22) with a shared core:
- CLI `timesheet init|scope|auth|day|week|month|serve` (`--json`, `--copy`, `--target`, `--refresh`, `--format grid|lines|internal`).
- `timesheet serve`: local web page to review, override category/hours, copy.
- Claude Code skill `/timesheet`: calls the CLI with `--json`; never re-implements logic.

## Core modules
| Module | Responsibility |
|---|---|
| `collectors/claude.ts` | Parse `~/.claude*/projects/**/*.jsonl` → activity intervals (user prompt → last assistant/tool event of that turn), with cwd, branch, prompt text |
| `collectors/git.ts` | `git log --all --author=<emails>` per work repo → commit events (window before commit, default 15 min) |
| `collectors/gcal.ts` | Google Calendar API (OAuth desktop, `calendar.readonly`), selected calendars; skip declined, all-day, attendee-less busy blocks; OOO → day = 0 |
| `scope.ts` | Glob rules work→project / personal; most specific wins; unmatched → "unclassified" warning, day marked partial |
| `timeline.ts` | Merge events into blocks (gap > 30 min splits); meetings take precedence over overlapping activity |
| `classify.ts` | One `claude -p` call per day assigning categories and writing the daily summary; runs from a dedicated dir excluded from collection; without it blocks go to the categories holding the meeting, work or fallback rule (`Uncategorized` when there are none) |
| `hours.ts` | Real hours per category; normalization to target, rounded to 0.25 with largest-remainder so the day sums exactly; no-activity days stay 0 |
| `store.ts` | SQLite (`node:sqlite`) at `~/.timesheet/db.sqlite`: days, blocks, entries, overrides |
| `format.ts` | grid / lines / internal renderers |

## Task categories
Configurable list with CAPEX/OPEX flag, optional validity dates and an optional rule (work, meeting, fallback, no-code, deploy, incident). Empty by default; a list can be pasted in Settings. Meetings go to the meeting-rule category unless the classifier finds a better fit.

## Caching rules
- Past, complete days are final; today is always recomputed.
- A day with a failed source or unclassified activity is `partial` and recomputed next run.
- Scope changes invalidate days containing affected paths.
- Overrides survive recomputation.

## Errors
A failing source warns and continues; the day is marked partial.

## Testing
Unit tests (node:test) for timeline, hours, scope, format, claude collector with fixtures; classifier behind an interface, stubbed in tests.

## Additions (2026-09-30)
- **OpenCode** sessions as a second AI-session source (opencode.db 2.x `session_v2`/`session_message`, 1.14+ `session`/`message`/`part`, legacy `storage/` JSON); shared span builder with Claude Code.
- **Web app** (React, built on Loam's component source; prebuilt into `web/dist`): Timesheet, Calendar (Loam Scheduler; drag a block to another category to recategorize), Settings (every option, plus raw JSON), first-run setup wizard (Loam Wizard).
- **Config editing** via web Settings, `timesheet config get|set|edit|reset`, all validated by `validateConfig`.
- **Credentials**: Google OAuth client and refresh token in the OS keychain (macOS Keychain / Secret Service), 0600 file fallback; never in config, repo or package.
- **Distribution**: `npm pack` ships a bundled CLI (`dist/timesheet.mjs`, esbuild) + `web/dist`; `scripts/setup.sh` installs, adds the skill and runs the wizard; `timesheet doctor` verifies.
- **Local server hardening**: loopback-only, Host check, `X-Timesheet` header required for writes.
- **Background jobs** (`jobs.ts`): computing days runs as a job persisted in SQLite (`jobs` table). Progress is derived from the stored days (a date is done when its day was computed with the current settings after the job started, or is still fresh), so a crash loses at most the days in flight. Jobs can be paused (running Claude calls are killed; unfinished days are not saved), resumed and cancelled; jobs left `running` by a dead process become `interrupted` and are resumed by the server. The CLI pauses on Ctrl+C and resumes the matching job on the next run. Reports never block on computation.
- **Staleness**: today is recomputed after 15 minutes, failed days after 5 minutes; days partial only for unclassified paths wait for a scope change.
