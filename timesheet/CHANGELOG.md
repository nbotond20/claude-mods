# Changelog

## 0.3.5
- `bin/mods install` asks which mods to install when run in a terminal (Enter = all); `--except a,b` skips some, `--only` and `--yes` skip the question.
- Docs: an "On by default" table, the full config reference (history import, classifier, calendar and submit keys) and `submit week`; test fixtures anonymized.

## 0.3.4
- `timesheet serve` only reuses or stops a server after the OS confirms the process listening on the port runs timesheet; the pid in an HTTP reply is never trusted, so another local service cannot pose as timesheet or get an unrelated process killed.

## 0.3.3
- `timesheet serve` checks what already holds the port: a running server of this version (or newer) is reused and just opened, an older one is stopped cleanly and replaced, anything else is reported instead of crashing. `--restart` always replaces it. New `GET /api/version`.

## 0.3.2
- Personal toggle in the timesheet: real hours spent in personal folders, shown next to work in the totals, under the NetSuite export grid (on screen only, never copied) and on each day. Never booked, rounded or targeted.

## 0.3.1
- Block details are quieter: one line per piece of work (summary, repo, branch, counts, duration) that opens on click to its commits, GitHub actions, sessions and prompts. Repositories and branches sit in a collapsed Context row; time ranges and recorded minutes show on hover.
- Redmine: issue discovery reads every issue a day page lists, even on days with private or odd rows; error banners are detected more reliably; a day where two categories map to one issue says how to fix it.
- The Redmine mapping lists every current category of every project, not only recently booked ones.
- Google Calendar authorization no longer keeps the process alive after the browser tab closes.

## 0.3.0
Reliability: hours that were entered stay put, and a day that looks wrong says so before it is submitted.
- Locked days: a week saved to Redmine or NetSuite locks its past days, so later settings changes, recomputes and cleaned-up transcripts cannot move them. `timesheet lock|unlock <date|week> [when]`, and a lock button in the web app.
- Low-activity check: a workday with less recorded work than `lowActivityRatio` (0.5) of its target is flagged and blocks submission until you confirm it (`timesheet confirm`) or set its hours.
- `timesheet review [week]`: per-day status, flags, warnings, locks and whether each system's plan is ready. `timesheet why <date> <category>`: the blocks behind a category's hours.
- Every hand edit is logged: `timesheet history [date]`, `timesheet undo [date]` (also `/api/undo` and `/api/history`).
- Hand edits are validated: hours must be 0–24 and a multiple of the rounding step, the project and category must exist, the block must exist on the stored day. The web API returns 400, or 409 on a locked day.
- Hours set by hand rebalance the rest of the day to the target instead of overshooting it.
- Recategorized blocks follow their block through a recompute; one that cannot follow is dropped with a warning naming its time.
- AI session activity is archived per day, so a day recomputed after Claude Code deleted its transcripts keeps its real timing instead of a history.jsonl guess. `timesheet doctor` warns when `cleanupPeriodDays` is below 90.
- Part-day out of office (calendar) lowers the target by that time; `holidays` lists days off with no target.
- `timezone` cuts days in a fixed zone, whatever the machine is set to.
- `timesheet config set K V --from DATE` applies a change only from a date on; settings changes say how many days will recompute (the web API too).
- Recomputes print what changed in booked hours.
- A completed day is recomputed once a day after it ended, to pick up late-synced activity.
- Overlapping work in two projects is split by recorded minutes instead of going all to the first.
- Rebased and cherry-picked commits count once.
- Calendar meetings over `maxMeetingHours` and blocks the classifier skipped now show as warnings instead of disappearing.
- `--copy` works on Linux (wl-copy, xclip, xsel) and Windows and says when it fails; a CLI waiting on a crashed web app takes the job over.
- Weekly reminder toast when last week is not computed, flagged, or not submitted.

## 0.2.0
- Ships as a my-mods plugin: the CLI, web app and skill install with `/plugin install timesheet@my-mods` or `sh bin/mods install`.
- `/timesheet week last` (or day, month, any question) runs through the skill; `/timesheet setup` walks through setup.
- `/timesheet open` starts the web app; `/timesheet doctor`, `status` and `install` check and repair the setup.
- The `timesheet` launcher follows plugin updates; `/mods status`, `doctor` and `setup` include timesheet.

## 0.1.0
- First release: timesheets from Claude Code and OpenCode sessions, git, GitHub and Google Calendar; CLI, web app and skill.
