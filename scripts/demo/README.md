# Demo data for the docs screenshots

Every screenshot in `docs/images/` uses generated data: fictional projects (acme-web, billing-api, mobile-app, infra, design-system), two profiles (`claude-work`, `claude-personal`) and fixed random seeds. Nothing is read from the real machine. Each script writes into a folder you pass and refuses a non-empty folder it did not create.

## usage-analytics dashboard

```sh
python3 scripts/demo/usage-analytics-demo.py /tmp/ua-demo     # 45 days, ~260 sessions, mod events, budget-guard ledgers
HOME=/tmp/ua-demo CLAUDE_USAGE_PORT=8799 python3 usage-analytics/bin/claude-usage ingest
HOME=/tmp/ua-demo CLAUDE_USAGE_PORT=8799 python3 usage-analytics/bin/claude-usage serve --open
HOME=/tmp/ua-demo python3 usage-analytics/bin/claude-usage stop --port 8799
```

Overriding `HOME` keeps the CLI away from your real profiles and data folder.

With the server up, `node scripts/demo/shoot-dashboard.mjs /tmp/shots` takes every dashboard screenshot at 900×625, 2x, in headless Chrome. Pass names to take only some, and `SID=<id>` to pick a session with subagents for the drill-down. Run `pngquant --quality 80-95 --ext .png --force` on the results before copying them to `docs/images/usage-analytics/`.

## timesheet web app

```sh
unset CLAUDE_CONFIG_DIR XDG_DATA_HOME
node --experimental-sqlite --no-warnings scripts/demo/timesheet-demo.mjs /tmp/ts-demo
HOME=/tmp/ts-demo/home TIMESHEET_HOME=/tmp/ts-demo/home/.timesheet TIMESHEET_SECRETS=file \
  PATH="$(dirname "$(command -v node)"):/usr/bin:/bin" TZ=Europe/Berlin \
  node --experimental-sqlite --no-warnings timesheet/bin/timesheet.js serve --port 4391
```

Run the server in that environment only. Without it the app reads your real `~/.timesheet`, profiles and keychain. The data covers weekdays from Sep 1 to Oct 12, 2026; the week of Oct 5 is the fullest.

## Terminal scenes

`terminal-scenes.html` draws the in-session UI (budget-guard's band, the savings pane, `/mods`, the session toast, a lean-tools capped result, an LSP lookup) in the mods' own text formats, with demo values.

```sh
cd scripts/demo && python3 -m http.server 8798
# open http://127.0.0.1:8798/terminal-scenes.html?s=band-gateway
```

Scene ids: `band-gateway`, `band-subscription`, `newtask-hold`, `budget-savings`, `mods-status`, `mods-toast`, `lean-cap`, `lsp-first`. Each page is exactly one scene. Size the viewport to the body and screenshot at 2x.

When a mod's output format changes, update its scene here so the screenshot stays accurate.
