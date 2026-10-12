# Redmine Worktime plugin: what the adapter must know

From the source of [redmine_work_time](https://github.com/tkusukawa/redmine_work_time) (`app/controllers/work_time_controller.rb`, `app/views/work_time/_user_day_table.html.erb`, `show.html.erb`). To be confirmed against the user's instance with `timesheet submit inspect redmine`.

## Pages and side effects
- Daily page: `GET /work_time/index?year=Y&month=M&day=D&user=UID` (without `user` it redirects to add it). `index` runs `ticket_pos`, `prj_pos`, `ticket_del`, `hour_update`, `set_holiday` **on every request, GET included**, driven by query params. The adapter therefore only ever navigates to URLs it builds itself with exactly `year`, `month`, `day`, `user` (and nothing else) — never follows links on the page (`ticket_del=…` deletes rows, `ticket_del=closed` removes closed tickets, `set_holiday` changes holidays).
- The **Update** button submits the whole day form (`form_tag @link_params`, POST) via JS `submit()`.

## Form fields of the daily table (`#time_input_table`)
- Project header rows: black background, project name, project total.
- Issue without entries that day: row `#time_entry_pos<issueId>_0` with
  - `new_time_entry[<issueId>][0][hours]` (text, empty)
  - `new_time_entry[<issueId>][0][activity_id]` (select; options = project activities; default preselected)
  - `new_time_entry[<issueId>][0][status_id]` (select, or plain text if no transitions)
  - `new_time_entry[<issueId>][0][comments]`
  - optional `…[remaining_hours]` (backlog plugin), custom fields `new_time_entry_<issueId>_0[...]`.
- Existing time entry: row `#time_entry_pos<entryId>` with `time_entry[<entryId>][hours]` (value `%1.2f`), `time_entry[<entryId>][activity_id]`, `[status_id]`, `[comments]`. The issue is identified by the row's link `a.wt_iss_link[data-issue]`.
- Issue identity: `a.wt_iss_link` with `data-issue="<issueId>"` in every issue row.
- `private` row: hours on issues the user cannot see that day (`@day_pack[:other]`). Not editable; non-zero = hours we cannot attribute → conflict.
- Day total: `#currentTotal` (title holds the saved value).

## Server behaviour on Update
- New entry created only when `hours` is non-blank; requires `activity_id`.
- **Existing entry with blank `hours` is destroyed.** The adapter never edits `time_entry[...]` fields; resubmitting them unchanged is a no-op.
- `status_id` changes the issue only if its value starts with `M` (set by the page's `statusUpdateOnDailyTable` JS when the user changes the select). Untouched selects never change status. The adapter never touches status, remaining hours, comments or custom fields.
- Errors (`@message`) are rendered at the top of `#content`, before `.contextual`, as `<div style="background:#faa;">…</div><br>`. **The month table's day scroller (`#day_scroll`, `_user_month_table.html.erb`) renders every Sunday cell with the same `style="background:#faa;"`** (`@wday_color[0]`), so the adapter counts a `#faa` div as an error only outside `#day_scroll`. The sanitizer keeps `style` attributes so captures show this.
- `time_entry[<id>][activity_id]` is `options_for_select(activities, hour.activity_id)`: if the entry's activity is no longer offered (inactive), no option is marked and the browser shows the first one — Update would rewrite the entry's activity. The adapter requires exactly one option with the `selected` attribute per existing entry, else it stops ("fix it by hand").
- Existing hours are rendered as `sprintf("%1.2f")`, and Update posts them back. The adapter requires the shown value to be exactly the rendered one; an entry stored with more than two decimals (e.g. 1.255) shows rounded and **cannot be detected** — Update would round it.

## Implications for the adapter
- `read(day)`: every `time_entry[...]` row → cell (date, issueId from `data-issue`, activity = selected option text, hours); `private` row non-zero → conflict.
- `fill(cell)`: exactly one row `#time_entry_pos<issueId>_0` with an empty `new_time_entry[<issueId>][0][hours]`; select the activity by exact option text (exactly one match); type hours with `.` decimal.
- An issue that already has an entry that day has no `new_time_entry` row unless "+" is used: covered by the diff (an existing equal value = no-op; different = conflict).
- Mutating GET parameters (`ticket_del`, `ticket_pos`, `prj_pos`, `member_pos`, `set_holiday`, `del_holiday`, `memo`) are blocked for every request to the Redmine origin during a preparation or run, also redirect hops and the user's own clicks (DevTools `Fetch` interception, since `page.route` does not see redirects); a blocked request stops the run. The configured address may not carry a query or fragment; the browser is always opened at the bare `…/work_time/index`.
- From the first keystroke, every form POST of the tab is blocked until the filled-in form is verified; then exactly that body may pass once. Once a POST passed, any later problem is reported as failed ("check by hand"), never as "nothing saved". Any stop after filling reloads the day while POSTs are still blocked (closing the tab if the reload does not come back clean), so no filled-in value is left for a later Update.
- Before clicking Update: assert URL params, the user in the "Monthly Report (<name>)" heading, the date in "Daily Report YYYY-MM-DD", and that only our inputs changed (compare all form values with the values read on load except our cells).
