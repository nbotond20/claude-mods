# timesheet

NetSuite-ready timesheets built from your AI coding sessions (Claude Code, OpenCode), git history, GitHub activity and Google Calendar.

- **Two figures per day:** real activity (session time including waiting on the assistant, commits, meetings) and booked hours normalized to a daily target (default 8, per-weekday overrides, `--target`).
- **Recorded minutes:** next to those, the exact minutes backed by timestamps only (session messages and meetings; no prompt/commit/GitHub lead-ins, history tails, block padding or rounding). Shown per day, category, block and piece of work in the CLI and, with the *Recorded minutes* switch, in the web app.
- **Task categories:** every hour lands in one of the NetSuite task categories; CAPEX/OPEX follows the category. A headless Claude call classifies each day's time blocks and writes an internal daily summary. It judges the work by what changed, not just the prompts: commit types, lines and files per area (code, tests, lockfiles, CI, infra, docs) and, for AI sessions, which files the assistant edited, how much it only read, and which commands it ran (program and subcommand only).
- **Cached:** past days are computed once and cached in SQLite (`~/.timesheet/db.sqlite`). Days with errors, unclassified repos or a failed classification stay *partial* and are recomputed.
- **Three front-ends over one core:** CLI, a local web app (timesheet, Loam Scheduler calendar, settings, setup wizard), and a Claude Code mod (`/timesheet` plus the skill).

## Install

Requirements: Node.js ≥ 22.18, git. Optional: the `claude` CLI (classification and summaries) and Google Calendar.

As a Claude Code mod (recommended), with the other my-mods or on its own:

```sh
sh bin/mods install --only timesheet     # every profile on this machine; or, in Claude Code:
/plugin install timesheet@my-mods
```

The plugin carries the CLI, the web app and the `timesheet` skill. Each session points `~/.local/bin/timesheet` at the installed version (updates keep working), and:

| | |
| --- | --- |
| `/timesheet week last` | your timesheet through the skill; also `day`, `month`, or any question about your hours |
| `/timesheet setup` | a guided setup: doctor, the wizard (browser or terminal), calendar and GitHub |
| `/timesheet open` | starts the web app on http://127.0.0.1:4280/ and opens it |
| `/timesheet doctor` · `status` · `install` | checks, a summary, re-install the launcher (`--force` replaces a foreign one) |

`/mods status`, `/mods doctor` and `/mods setup` include it. The submission automation's one dependency (`playwright-core`) is installed next to the plugin once a submission system is configured. A copy of the skill from before (`~/.claude*/skills/timesheet`) shadows the plugin's: `/mods doctor` says where to remove it.

Without Claude Code plugins:

```sh
# from a release tarball or a checkout
./scripts/setup.sh          # checks prerequisites, installs `timesheet` + the skill, runs the wizard
./scripts/setup.sh --web    # same, with the wizard in the browser
```

Manual equivalent: `npm install -g ./timesheet-<version>.tgz` (or `npm link` in a checkout), `timesheet install-skill`, `timesheet init` (or `timesheet init --web`). `timesheet doctor` checks everything afterwards.

## Use

```sh
timesheet day yesterday            # blocks, summary, CAPEX/OPEX + paste block
timesheet week last --copy         # weekly NetSuite grid, copied to the clipboard
timesheet month 2026-09 --format lines
timesheet week --no-header --copy  # grid rows only, for pasting straight into cells
timesheet week --target 7.5        # normalize to a different target
timesheet week --real              # book real (rounded) hours instead
timesheet serve --open             # web app at http://127.0.0.1:4280
```

Adjustments survive recomputes:

```sh
timesheet edit 2026-09-15 "Testing" 2          # override booked hours (or `clear`); the rest of the day fills up to the target
timesheet block 2026-09-15 3 "Team Meeting"     # recategorize time block #3; it follows the block through recomputes
timesheet history 2026-09-15                    # every hand edit, newest first
timesheet undo                                  # revert the last one (or `undo <date>`)
timesheet scope add work "~/work/**" "Client A"
timesheet scope review                          # classify repos seen in sessions
```

Hours must be a multiple of `rounding` and between 0 and 24; the project and category must exist.

### Before submitting

```sh
timesheet review last                 # each day: booked vs target, flags, warnings, locks; whether Redmine/NetSuite plans are ready
timesheet why 2026-09-15 Development  # the blocks (and edits) behind a category's hours
timesheet confirm 2026-09-15          # accept a low-activity day as it is (--clear takes it back)
timesheet lock week last              # keep days exactly as they are; `unlock` reverses it
```

A workday whose recorded work is below `lowActivityRatio` of its target (default half) is flagged: normalizing 1h of activity to 8h is usually a sign that something was not captured. It blocks submission until you confirm the day or set its hours.

When a week is saved to Redmine or NetSuite, its past days lock: settings changes, `--refresh` and deleted transcripts can no longer change what was entered. Unlock a day to change it, then submit again.

### Long runs: pause, resume, crashes

Computing days (collecting activity and one Claude call per day) runs as a background job saved in `~/.timesheet/db.sqlite`. Each finished day is stored on its own, so nothing done is lost:

- **Web app:** reports show cached days right away and compute the rest in the background. The top bar shows progress with **Pause**, **Resume** and discard.
- **CLI:** Ctrl+C pauses (`Paused (18/30 days done). Run the same command to continue.`). Running the same command again continues where it stopped.
- **Close or crash:** a job left running by a process that is gone is picked up on the next `timesheet serve` (or by the running web app within a second), and continues with the days not yet stored.
- Settings changes restart the running job with the new settings.

Past days that are complete are recomputed once, a day after they ended (to pick up commits pushed or calendars synced late), then kept. Today is refreshed at most every 15 minutes, and a day where something failed (a source or the classifier) is retried after 5 minutes. A day flagged only for unclassified folders waits until you change the work scope. Locked days are never recomputed. When a recompute changes booked hours, the CLI prints the difference.

Claude Code deletes transcripts after `cleanupPeriodDays` (30 by default). Each computed day keeps a compressed copy of its AI-session activity in the database, so recomputing an old day still uses real timings; `timesheet doctor` shows the archive and warns about a short cleanup period.

In the web app's **Calendar** tab, drag a block onto another category in the Resources view (or open it and change its resource) to recategorize it.

## Configuration

Every option is editable three ways, all validated before saving:

- the web app → **Settings** (including a raw JSON editor),
- `timesheet config edit` (opens `$EDITOR`, re-prompts on invalid config), `timesheet config get|set <key.path> [value]`,
- `~/.timesheet/config.json` directly.

| key | default | |
|---|---|---|
| `claudeDirs`, `opencodeDirs` | `~/.claude/projects`, `~/.local/share/opencode` | session stores; empty list = off |
| `authorEmails` | global git email | commits by these authors count |
| `projects`, `defaultProject` | `Default` | NetSuite projects |
| `scope.work` / `scope.personal` | – | globs; most specific wins; only work is booked. Personal and unassigned activity shows as "Other" (toggleable) but is never booked |
| `target`, `weekdayTargets` | `8`, weekends = real hours | |
| `gapMinutes`, `promptLeadMinutes`, `commitLeadMinutes`, `minBlockMinutes` | 30, 2, 15, 15 | how activity becomes time blocks |
| `idleMinutes` | 10 | assistant work longer than this after your last prompt (an agent left running) is not counted; real hours are recorded minutes only, split at quiet gaps longer than this, and never past now |
| `rounding`, `decimalSeparator`, `dateFormat` | 0.25, `.`, `YYYY-MM-DD` | paste output |
| `github` | off | `repos` to watch without a clone (`owner/name`, `owner/*`); `leadMinutes` (10) credited before each action |
| `calendar` | off | calendars, project; which replies count (`includeTentative` on, `includeUnanswered` on, `includeDeclined` off); solo events; `maxMeetingHours` (4) ignores longer meetings |
| `classifier` | `claude`, `sonnet` | `notes` adds team guidance to the prompt |
| `categories` | September 2026 task list | CAPEX flag, validity dates, classifier opt-out, color |
| `holidays` | `[]` | dates (`YYYY-MM-DD`) off work: no target, real hours only |
| `lowActivityRatio` | 0.5 | flag workdays with recorded work below this share of the target; 0 = off |
| `timezone` | machine's | IANA zone (e.g. `Europe/Budapest`) days are cut in |

Changing a setting that shapes days recomputes cached days the next time they are shown (locked days excepted). To apply it only from a date on, keeping earlier days as they were: `timesheet config set gapMinutes 45 --from 2026-10-01`.

Out-of-office calendar events covering the day's target make it a day off; shorter ones (a doctor's appointment) lower that day's target by their length.

## Activity sources

- **Claude Code:** `<config dir>/projects/*/*.jsonl`; `CLAUDE_CONFIG_DIR` is honored.
- **OpenCode:** all storage generations: `opencode.db` with `session_v2`/`session_message` (2.x) or `session`/`message`/`part` (1.14+), and the older `storage/` JSON tree. Read-only.
- **git:** `git log --all` in repos found through session paths and work-scope folders.
- **GitHub:** issues and PRs you opened, reviews, comments (last 90 days only), tags, releases you published, workflows you ran by hand (manual deploys and releases) and re-ran, and deployments you approved or rejected in protected environments. Each action counts `github.leadMinutes` before it. Actions land in the local clone of their repo, so work scope applies as usual; repos without a clone get the path `github.com/owner/name`, which scope rules match too (`timesheet scope add work "github.com/acme/**"`). Repos are found from your clones, your GitHub contributions and `github.repos`, which is where to list a platform repo whose deployments you only approve.
- **Google Calendar:** meetings with other attendees that you accepted, marked tentative or never answered (each reply type, declined included, is a setting); out-of-office ≥ 4h disables normalization that day.

The classifier's own `claude -p` sessions and temp directories are never counted.

## Google Calendar and credentials

Create an OAuth client once (per team or per person):

1. https://console.cloud.google.com → project → APIs & Services → enable **Google Calendar API**.
2. Google Auth Platform → Audience: **Internal** (Workspace) or External with testers; Data access: `calendar.readonly`.
3. Clients → Create client → **Desktop app** → download the JSON.

Then `timesheet auth --client-file ~/Downloads/client_secret_….json` (or paste it in the wizard / Settings → Calendar), and approve in the browser.

**Where secrets live:** the OAuth client and the refresh token are stored in the **macOS Keychain** (service `timesheet`), the **Secret Service** on Linux (`secret-tool`), or, only if neither exists, `~/.timesheet/secrets.json` with mode 600. The downloaded client file is deleted after import. Nothing secret is written to the config, the repo or the package. Managed setups can pass `TIMESHEET_GOOGLE_CLIENT_ID` / `TIMESHEET_GOOGLE_CLIENT_SECRET` instead. `timesheet auth --logout` removes the token; `--forget` also removes the client.

The local web server listens on 127.0.0.1 only, rejects non-loopback `Host` headers and requires an `X-Timesheet` header on every write, so other websites cannot drive it.

## GitHub tokens

Create a read-only **fine-grained** token for each account or organization you work in (a fine-grained token covers one owner). `timesheet github token acme --open` (or Settings → GitHub → *Create token on GitHub*) opens GitHub's token form with the name, owner, expiry (366 days) and permissions filled in; only repository access has to be chosen by hand:

1. Resource owner: your account, or the organization. The organization may have to approve the token.
2. Repository access: **All repositories**.
3. Repository permissions, all **Read-only**: Actions (manual runs, approvers), Contents (releases, tags), Deployments, Environments (which need a reviewer), Issues, Metadata, Pull requests.

Then `timesheet github add acme` (the token is typed hidden, and the same link is offered first), or paste it in Settings → GitHub. Tokens are checked against GitHub and stored in the same secret store as the Google credentials (secret `github-tokens`), never in the config. `timesheet github` shows which tokens work and as whom; `timesheet github remove acme` deletes one. `TIMESHEET_GITHUB_TOKEN` (comma-separated) overrides the stored tokens; with neither, a logged-in `gh` CLI's token is used.

Approvals have no timestamp on GitHub's side; they are dated by the deployment's first status after it stopped waiting for review.

## Submitting to Redmine and NetSuite (in progress)

There are no API keys, so the timesheet drives the real pages in a separate Chrome window with its own profile (`~/.timesheet/browser`). You log in there yourself (SSO, MFA); only the session cookies are kept, never passwords.

```sh
timesheet config set submit.redmine.url https://redmine.example.com/work_time/index
timesheet submit login redmine        # log in once in the window
timesheet submit plan last            # what would be entered (read-only)
timesheet submit inspect netsuite     # save sanitized page snapshots for building the automation
```

Booked hours map to Redmine issue + activity and NetSuite project + task through `submit.<system>.rules` (`{ "project", "category" | "*", "target" }`). Anything unmapped, a partial day, or hours already on the site that differ from the plan stops that system for the whole week, with nothing entered.

## Development

```sh
npm test                 # node:test, no build needed
npm run typecheck        # CLI/core; `npm run typecheck:web` for the UI
npm run dev:web          # Vite dev server (proxy to `timesheet serve` on :4280)
npm run build            # dist/timesheet.mjs + web/dist
npm pack                 # distributable tarball (builds the CLI, requires web/dist)
```

The UI is built from [Loam](../loam)'s component source (Scheduler, form controls, tokens) through Vite aliases. Loam is only needed to **build** the UI: set `LOAM_DIR` if it is not a sibling checkout. The built `web/dist` ships in the package, so installing needs nothing but Node.
