# Changelog

## 0.3.3
- Docs: a README for the mod, and screenshots of a refused commit and of `/no-attribution`.

## 0.3.2
- `/mods` and `bin/mods install` know the new observability mod (local Grafana: traces, logs, metrics and dashboards for every profile).

## 0.3.1
- `bin/mods install` asks which mods to install when run in a terminal (Enter = all); `--except a,b` skips some, `--only` and `--yes` skip the question.
- Docs: "On by default" and "Managing it" sections.

## 0.3.0
- Joins `/mods`: one combined toast for first runs and updates, `/mods status`, `setup`, `doctor` (checks the global git hooks) and `uninstall`, which also unsets the hooks it installed.

## 0.2.0
- Optional global git hooks, so plain `git commit` is guarded too.

## 0.1.1
- Refuses instead of rewriting approved tool calls.
