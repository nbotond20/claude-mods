# Changelog

## 0.5.3
- Docs: a README for the mod with a screenshot.

## 0.5.2
- `/mods` and `bin/mods install` know the new observability mod (local Grafana: traces, logs, metrics and dashboards for every profile).

## 0.5.1
- `bin/mods install` asks which mods to install when run in a terminal (Enter = all); `--except a,b` skips some, `--only` and `--yes` skip the question.
- Docs: "On by default" table, every config key and command.

## 0.5.0
- `/lean off 1h` (or `30m`, `1d`, `session`) pauses the caps and nudges for a while; `/lean on` resumes.
- Joins `/mods`: one combined toast for first runs and updates, `/mods status`, `setup`, `doctor` and `uninstall`.

## 0.4.0
- Setup wizard and a shared data folder any profile can use.
