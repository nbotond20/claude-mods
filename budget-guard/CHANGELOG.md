# Changelog

## 0.10.0
- Compacts at `compactAt` (default 200k) whatever `autoCompactWindow` says; `/budget compact <n>|off`.
- The Opus effort cap covers subagents too and is set by `opusMaxEffort`.
- `/budget pause 2h` (or `session`) lets routing, the effort cap, compaction and trimming step aside; budgets stay. `/budget resume` ends it.
- Joins `/mods`: one combined toast for first runs and updates, `/mods status`, `setup`, `doctor` and `uninstall`.

## 0.9.0
- Setup wizard, a shared data folder any profile can use, and a holdout share for `/analytics impact`.
