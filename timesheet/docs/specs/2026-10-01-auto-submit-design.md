# Auto-submission to Redmine and NetSuite — design

Enter a week's booked hours into Redmine (Worktime plugin, per day) and NetSuite (weekly timesheet) by driving the real web UIs, since no API keys are available. **Doing nothing is always preferred over doing something wrong.**

## Decisions
- **UI automation** with `playwright-core` on the installed Chrome (no bundled browser download), **headed**, own profile in `~/.timesheet/browser/` (mode 700). The user logs in themselves (NetSuite SSO; Redmine Google or password + MFA); only the profile's cookies persist, no credentials are stored.
- **Manual trigger with review.** Never scheduled, never started by the Claude skill.
- **Same hours in both systems:** the booked (normalized, rounded) entries already shown in the timesheet.
- **Redmine comment empty.** Status is never touched.
- **NetSuite: fill + Save only.** Submit for approval is left to the user.
- **Conflicting existing data → that system aborts for the whole week, zero writes.**
- **Fill-only mode** per system (default on): fill and verify inputs, do not press Update/Save; the user presses it in the open window.

## Target systems

### Redmine (redmine_work_time plugin)
Monthly report page with a daily report below it: issue rows grouped by Redmine project (e.g. `Acme Platform` → `Feature #4242`), each with WorkTime (hours), Activity (select, localized names), Status (select) and Comment, and an **Update** button per day. A cell is identified by **date + issue ID + activity**. The adapter writes WorkTime and Activity only.

### NetSuite (weekly timesheet)
Rows: customer:project, task (case/task/event), service item, Mon–Sun hours; **Save** (not Submit). A cell is identified by **week + project + task + weekday**.

## Mapping and discovery
- `discover` (after login) reads what each system offers and stores it in `submit_catalog`:
  - Redmine: the issue rows listed in Worktime (ID, title, Redmine project) and the activity options.
  - NetSuite: the project and task options of the timesheet row selects.
- **Mapping** (`config.submit.*.mapping`), editable in the setup wizard and Settings, extendable later (*Refresh from site* re-runs discovery):
  - Redmine: `(project, category)` → `{ issueId, activity }`. A rule may use `category: "*"` for "any category on this project"; an exact rule wins over `*`.
  - NetSuite: `(project, category)` → `{ project, task }` option texts (NetSuite tasks can depend on the project), same rule shape and `*` wildcard as Redmine. Pre-filled when option texts equal our names exactly; the user confirms.
- A mapping that points at something no longer in the catalog is shown as broken and blocks submission.
- Adding issues to the Worktime list ("Add ticket") is out of scope: map only to issues the page already lists.

## Architecture (`src/core/submit/`)

| Unit | Responsibility | Depends on |
|---|---|---|
| `plan.ts` | Pure: week's booked entries + mapping → per-system `Plan` (list of cells with target value) or `blocked` with reasons. | types, config |
| `diff.ts` | Pure: `Plan` + `Snapshot` (what the site holds) → `noop` / `write(cells)` / `conflict(reasons)`. | plan types |
| `browser.ts` | Launch/reuse the headed Chrome with the dedicated profile; single-instance lock in `~/.timesheet/browser.lock`. | playwright-core |
| `redmine.ts`, `netsuite.ts` | Adapter: `checkLogin()`, `discover()`, `read(week): Snapshot`, `fill(cells)`, `save()`. All selectors and page assertions live here. | browser |
| `run.ts` | Orchestrates one system for one week, records everything. | all above, store |
| `store.ts` (extended) | Tables `submit_catalog`, `submit_runs` (plan, fingerprint, snapshot before, cells written, readback, outcome, screenshot paths). | |

`Plan` cells: `{ date, target, hours }` where `target` is `{ issueId, activity }` (Redmine) or `{ project, task }` (NetSuite). Hours use the existing rounding (0.25) and are compared as integers of hundredths to avoid float mismatches.

## Run flow (one system, one week)
1. **Plan.** Blocked if: any entry unmapped or mapped to a missing catalog item; any day of the week is `partial` or still computing; any future day has hours. `today` is allowed but flagged in the review.
2. **Login check.** On the expected host, signed in as the expected user (Redmine: name in the report title; NetSuite: the employee on the timesheet, recorded at discovery). Not logged in → the window is brought to front, the run waits for the user to log in (max 5 min) or aborts.
3. **Read** the week as a `Snapshot`.
4. **Diff.**
   - Every planned cell already equal → `noop` (idempotent rerun).
   - A planned cell holds a different non-zero value, or the site has hours on rows/days we would not write in that week (e.g. a manual Redmine entry on another issue on a planned day; an extra NetSuite row) → **conflict, abort the system, nothing written**.
   - Otherwise → cells to write (empty targets only).
5. **Review.** The UI/CLI shows the diff per system and day. The user confirms; confirmation carries the plan **fingerprint** (hash of plan + snapshot). Before writing, the adapter reads again; if plan or snapshot changed, abort.
6. **Fill.** Per Redmine day / NetSuite week: locate each target by stable identity (issue ID in the row link; project/task option text), assert exactly one match, fill, then read the inputs back from the DOM and compare.
7. **Save** (skipped in fill-only mode, run ends as `filled`). Click Update/Save once, wait for navigation, assert no error banner.
8. **Verify.** Reload, read the snapshot again, require it to equal the plan exactly. Otherwise outcome `failed — check manually` with screenshots; never retried automatically.
9. **Record** the run in `submit_runs` and show the outcome.

Redmine saves per day, so a week is several Update clicks. If day 3 fails verification, days 1–2 are saved and verified, the run stops, and the review shows exactly which days are in. A rerun is safe: saved days become `noop`, the rest proceed.

## Hard rules (adapters have no code path for these)
- Never delete or decrease a value, never clear a cell, never change Redmine Status or Comment, never press Submit for approval, never use "Add ticket" or "delete closed tickets".
- Never act on a page that fails an assertion: wrong host/user/date/week, zero or multiple matches for a target, unexpected dialog, error banner, element missing. Abort before any click that saves.
- Only one run at a time (lock); a run aborted mid-way leaves the browser open for the user to inspect, but never with filled-in values: after any stop that follows filling, the page is reloaded (submissions still blocked) or the tab closed.
- Once a submission reached the site, every later problem is `failed — check by hand`, never "nothing saved".
- A run left `running` by a process that is gone is marked `failed` ("interrupted … check the site by hand") when a runner starts. After a `failed` run, the same system and week cannot be prepared or entered for 5 minutes.
- The CLI never quits while a run is in progress: the first Ctrl+C cancels, later ones wait for the run to settle.
- The Claude skill and `--json` output may show plans but cannot apply them.

## Surfaces
- **Web app:** a *Submit* panel in the week view of the Timesheet tab. Per system: login status + *Open browser / Log in*, *Prepare* → diff table (date, target, current, new, state), fill-only switch, *Confirm* → live progress → outcome with link to the page and screenshots on failure. History of runs from `submit_runs`.
- **Setup wizard / Settings:** new *Submission* step/section: base URLs (Redmine host, NetSuite account URL), *Log in*, *Discover*, mapping editor with suggestions, fill-only switches.
- **CLI:** `timesheet submit login <system>`, `timesheet submit discover <system>`, `timesheet submit plan <week>` (read-only, `--json` allowed), `timesheet submit week <week> [--system redmine|netsuite] [--save]` (interactive confirmation only; refuses without a TTY; fill-only unless `--save` or the setting is off).
- `timesheet doctor`: Chrome found, profile present, mapping complete.

## Building the adapters against the real pages
The selectors cannot be designed blind. First milestone: `browser.ts` + `timesheet submit inspect <system>` which, with the user logged in, saves a sanitized DOM snapshot (form structure, ids, names, labels; personal data such as other users' names stripped) and a screenshot of the relevant pages into `~/.timesheet/inspect/`. Adapters and test fixtures are built from those snapshots; the user reviews them before sharing.

## Error handling
Every abort carries a human reason ("Redmine 2026-10-06: issue #4242 already has 2.00 h, plan says 3.00 h — nothing written"). Timeouts (navigation 30 s, login 5 min) abort. Browser closed by the user mid-run → abort, nothing pressed. Session expiry mid-run → abort before the next save.

## Testing
- `plan.ts`, `diff.ts`: unit tests (unmapped, partial days, wildcard rules, noop, conflicts, float/rounding).
- Adapters: Playwright against **local HTML fixtures** derived from the inspect snapshots, served by a test HTTP server that records posted forms: happy path, fill-only, pre-filled matching (noop), conflict, duplicate row match, missing row, error banner after save, readback mismatch, wrong user. Asserts that nothing was posted in every abort case.
- A manual end-to-end checklist for the first real week in fill-only mode.

## Out of scope
Scheduled runs, Submit for approval, adding issues to Worktime, editing/deleting existing entries, per-system different hours, Redmine comments.
