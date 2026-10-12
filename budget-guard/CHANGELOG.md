# Changelog

## 0.11.0
- A session routed to Sonnet moves to Opus when a later prompt asks for implementation ("ok, implement it"). A local check of ~150 verbs and go-ahead phrases ("do it", "lgtm", "option 2", a few Hungarian ones) decides for free; only long prompts with no match cost one Haiku call. Never downgrades; `/budget route sonnet|opus` pins the model.

## 0.10.0
- Compacts at `compactAt` (default 200k) whatever `autoCompactWindow` says; `/budget compact <n>|off`.
- The Opus effort cap covers subagents too and is set by `opusMaxEffort`.
- `/budget pause 2h` (or `session`) lets routing, the effort cap, compaction and trimming step aside; budgets stay. `/budget resume` ends it.
- Joins `/mods`: one combined toast for first runs and updates, `/mods status`, `setup`, `doctor` and `uninstall`.

## 0.9.0
- Setup wizard, a shared data folder any profile can use, and a holdout share for `/analytics impact`.
