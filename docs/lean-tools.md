# lean-tools

Makes tool output smaller and round trips fewer. Every tool call re-sends the whole context, and every character a tool returns stays in context until compaction. In the last 30 days, cache reads were about 63% of spend, Bash produced about 68% of all tool output, and about 88% of requests made exactly one tool call.

Source: `lean-tools/hooks/register.ts`. Tests: `lean-tools/tests/`.

## What it does

| Hook | Behaviour |
| --- | --- |
| **Bash output cap** | Wraps the command. When output exceeds `maxBytes` (24k) or `maxLines` (400), the model sees the first 150 and last 80 lines plus a pointer to the full log in `$TMPDIR/lean-tools.XXXXXX`. Exit codes are preserved, and `cd`, env and heredocs keep working. |
| (cap exemptions) | Commands already bounded or risky to wrap are left alone: pipes to head/tail/less, redirects other than `2>&1`, heredocs, `sed -n`/`head`/`tail`/`awk`, `exit`/`exec`/`set -e`, bare `cd`/`export`/`source`, background runs, and budget-guard's noisy build/test commands, which budget-guard trims itself. |
| **`git log` bound** | Adds `-n 30` to a `git log` that has no count, range or date limit. |
| **System prompt section** `lean-tools:guide` | Five rules: batch independent calls; search, then do ranged reads; don't re-read; Edit over Write; keep command output small. |
| **Batching nudge** | After 4 main-loop turns in a row that each made one read-only call, a hidden note tells the model how many tokens each of those calls re-sent and asks it to parallelise. |
| **Big-read nudge** | A whole-file Read over 30k chars gets a note: next time, grep or LSP documentSymbol first, then Read with offset/limit. |
| **Re-read nudge** | Reading the same file whole again, unedited, gets a note to reuse what is already in context. |
| **Write nudge** | A Write over 3k chars to an existing file gets a note to use Edit. |

Each kind of nudge fires at most once every 10 minutes, so they cost almost nothing.

## Config: `~/.claude-shared/lean-tools/config.json`

The file is written with these defaults on first start:

```json
{ "enabled": true, "holdout": 0.2, "capOutput": true, "maxBytes": 24000, "maxLines": 400, "headLines": 150, "tailLines": 80,
  "boundGitLog": true, "nudges": true, "streak": 4, "bigRead": 30000, "guide": true }
```

Set `capOutput`, `nudges` or `guide` to `false` to switch those parts off. Changes take effect at the next session start. Or use `/lean [status|on|off|holdout <0-1>|cap|nudges|guide on|off]`.

`holdout` is the share of sessions where lean-tools stays passive and only logs what it would have done; see [mod-impact.md](mod-impact.md).

## Measuring it

**`/analytics impact`** (or `/dashboard impact`) gives the holdout verdict, the cap savings against the guide and nudge costs, and how often each nudge is followed. Also, in the dashboard:

In the dashboard:
- **Tools → Bash commands:** the `capped` column.
- **Tools → Read: whole vs ranged** and **Edit vs Write.**
- **Context → Tool calls per request.**
- **Cost & tokens → Efficiency per day.**

Compare the days before and after installation (2026-10-10).
