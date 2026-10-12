# timesheet

NetSuite-ready timesheets from your Claude Code and OpenCode sessions, git and GitHub history and Google Calendar. The mod bundles the `timesheet` CLI and web app, the timesheet skill, and `/timesheet`. The full manual is [timesheet/README.md](../timesheet/README.md).

Needs Node 22.18 or newer (it uses `node:sqlite` and runs TypeScript directly).

## Commands

| Command | What it does |
| --- | --- |
| `/timesheet` · `/timesheet status` | target hours per day, whether calendar and GitHub are connected, launcher warnings |
| `/timesheet setup` | a guided setup through the skill |
| `/timesheet doctor` | the CLI's own checks |
| `/timesheet open` | starts the web app on port 4280 (log: `<mods home>/timesheet/web.log`) and opens it |
| `/timesheet day\|week\|month [date]` | the timesheet for that period, through the skill |
| `/timesheet <anything else>` | handed to the skill as a request |
| `/timesheet install [--force]` | (re)installs the `timesheet` launcher |

Once a week, about half a minute into a session, a toast says when last week still needs something: days not computed, days flagged for a look, or (with submission set up) workdays not entered yet. It reads only days already computed and never starts the classifier.

## The launcher

Plugins live in a per-version cache, so their folder changes on every update. At session start the mod writes the current plugin folder to `<mods home>/timesheet/entry` and installs `~/.local/bin/timesheet`, a small script that reads that file (or `$TIMESHEET_ENTRY`). An existing `~/.local/bin/timesheet` that is not ours is left alone; `/timesheet install --force` replaces it. If `~/.local/bin` is not on `PATH`, the status says so.

`playwright-core` (only for NetSuite submission) is installed into the plugin folder the first time a submit URL is configured, once per version.

## Older installs

A copy of the skill at `<profile>/skills/timesheet/` (from the standalone install) shadows the plugin's newer skill. `/mods doctor` and `bin/mods install` point it out; remove it with `rm -r <profile>/skills/timesheet`. Data in `~/.timesheet` is used as is.

## Security

Google client secrets and tokens live in the OS keychain. The skill and the setup never ask for, print or store them; `timesheet init` is run by you (`! timesheet init`). The skill never runs `timesheet submit week`, `submit login` or `submit inspect`: it gives you the command. `timesheet submit plan` is read-only and allowed.
