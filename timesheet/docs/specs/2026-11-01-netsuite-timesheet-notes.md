# NetSuite weekly timesheet: notes for the adapter

Observed on the live account (Redwood/UIF form, `weeklytimebill.nl`); nothing was saved while exploring.

## Pages
- `…/weeklytimebill.nl?whence=&employee=<id>&trandate=DD%2FMM%2FYYYY` opens the week: an existing open timesheet redirects to `?id=<id>&e=T` (edit), an approved one shows view mode (`isDynamic` false), a missing one opens a new timesheet (id empty).
- The account's date format is DD/MM/YYYY; `trandate` is checked on every page.
- The grid is virtualized, so everything is read and written through `require(['N/currentRecord'])`. Sublist `timeitem`; `hours0..hours6` = Mon..Sun, a number or `''`; project = `customer`, task = `custcol_il_filtered_project_task`, service item `item` is sourced from the task.
- Header: `employee` (+ text, e.g. "E… Name"), `approvalstatus` ('' open, '3' approved), `lockstatus`.
- The project select options come from `getCurrentSublistField(customer).getSelectOptions()`. The task options load lazily, so they are read from the UI dropdown (task cell → `dropdownButton` → `[role=option]`, scrolling `[role=listbox]`).

## Save
Save sends two XHRs:
1. `timelimitvalidation.nl`, `jrmethod=remoteObject.validateWeeklyTimesheetRecordMacro`, `jrparams[0]` = `{EMPLOYEE_ID, ACTION:"save", TIMESHEET_STARTDATE, …}`.
2. `ClientScriptHandler.nl`, `jrmethod=remoteObject.submitDynamicClientRecord`, `jrparams` = `["timesheet", record, {timeitem:{fields,size,data}}, {recordrequestcontext:{id,e}}]`. Hours travel as "H:MM". The record carries `submitted`, `_multibtnstate_` and `approvalstatus`, all '' for a plain Save.

Sanitized captures: `test/fixtures/netsuite/`.

## Safety
- Outside the fill step, a context route blocks every non-GET to NetSuite that is not a read (`protectNetsuite`).
- During a run, a page route blocks every write until the filled-in week has been read back and matches the plan. After that it lets through the time-limit check and exactly one save whose record, employee, week, lines and minutes match, with `submitted` / `_multibtnstate_` / approval fields empty. Submit is never let through.
- Any stop after filling reloads the week (accepting the leave prompt) and checks that it is back as it was; otherwise the tab is closed.
- `test/netsuite-fixture.ts` is a fake of this page and API; `test/submit-netsuite-browser.spec.ts` drives the adapter against it.
