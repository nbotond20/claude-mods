# no-attribution

Claude never credits itself. That means no `Co-Authored-By: Claude …`, no `🤖 Generated with [Claude Code](…)`, no `Author: Claude`, no `noreply@anthropic.com`, and no commits with Claude as author. This covers commits, PR and issue bodies, code, docs and any tool call. Source: `no-attribution/hooks/register.ts`; tests: `no-attribution/tests/`.

## Layers

Each layer works on its own; together they cover each other's gaps.

| # | Where | What |
| --- | --- | --- |
| 1 | Your `settings.json` (optional, recommended) | `attribution: { commit: "", pr: "", sessionUrl: false }`, `includeCoAuthoredBy: false` |
| 2 | `attribution.text` | The engine's commit trailer and PR footer are returned empty, whatever the settings say. |
| 3 | `prompt.compose` / `skill.prompt` | Attribution lines are removed from the engine's system prompt sections and skill prompts. The section `no-attribution:rule` tells the model it is never an author, anywhere. |
| 4 | `tool.call` | Anything carrying attribution is **refused, never rewritten**, so what runs is exactly what you approved. The refusal names the offending text and, for Bash, gives the clean command, so the model sends it again. This covers Bash commands (heredoc commit messages, `-m`, `--body`, `--trailer`, …), the new text in Write/Edit/NotebookEdit (Edit's `old_string` may still contain it, which allows removing attribution), and every string argument of MCP tools such as a GitHub PR tool. **Also refused:** committing as Claude (`--author`, `GIT_AUTHOR_*`/`GIT_COMMITTER_*`, `git config user.name/email`) and skipping hooks (`--no-verify`, `git commit -n`, `-c core.hooksPath`, `git config core.hooksPath`). If the check itself fails, the call is refused, not let through. |
| 5 | Global git hooks, when `gitHooks` is on (`git config --global core.hooksPath <mods home>/no-attribution/git-hooks`) | **`commit-msg`** strips attribution lines from every commit message, whoever wrote it. **`pre-commit`** refuses a Claude/Anthropic author or committer. Every hook then runs the repository's own `.git/hooks/<name>`, so existing repo hooks keep working. |

What counts as attribution:
- trailers (`Co-Authored-By`, `Signed-off-by`, `Assisted-by`, `Generated-by`, `Written-by`, `Author`, …) that name Claude or Anthropic;
- phrases such as "generated / written / created / made / built … with / by / using Claude (Code)", with or without 🤖 and a link;
- any `noreply@anthropic.com`.

Ordinary mentions are kept, such as "Use the Claude API for summaries".

## Check it

`/no-attribution` shows:
- the layers;
- what was refused this session;
- whether the git hooks are active.

It also reinstalls the hooks if they are missing. They are installed again at every session start.

## Config: `<mods home>/no-attribution/config.json`

`{ "gitHooks": true }`. `/no-attribution setup` asks; `/no-attribution hooks off` removes the global hooks (only if they are this mod's) and keeps them off.

## Limits and notes

- A repository that sets its **own** `core.hooksPath` (Husky, lefthook) overrides the global one, so layer 5 does not run there. Layers 2–4 still apply to everything Claude does.
- If another global `core.hooksPath` is already set, the installer leaves it alone, and `/no-attribution` says so.
- Files whose path contains `no-attribution` are not rewritten, so this mod's own docs and source can quote the patterns.
- To remove the git layer: `git config --global --unset core.hooksPath`.
