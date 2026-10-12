# Changelog

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
