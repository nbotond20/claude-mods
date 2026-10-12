# budget-guard

Keeps spend and context visible and pushes work to cheaper models where that is safe. Source: `budget-guard/hooks/register.tsx`. The state contract is in `budget-guard/types/index.d.ts`.

## What you see

**The band above the prompt** (`ui.render AbovePrompt`):
- the main model and effort;
- session cost and burn rate ($/h over the last 20 minutes);
- gauges for the daily and monthly budgets;
- either LiteLLM key spend (gateway profiles) or the 5h/7d plan limits;
- context tokens, with `compacts ~200k`: the mod's `compactAt`, or `autoCompactWindow` when that is lower;
- live subagents with the model each one actually runs on, and background tasks.

When a new-task prompt is held, the band shows the choice `[c] clear · [k] compact · [y] keep`.

**Toasts**:
- context over `warn` (consider /compact);
- a heavy turn (context grew by more than `bigTurn`);
- a tool result over about 30k chars;
- every 10th screenshot;
- budgets at 80% and at 100%.

**Savings pane** (`/budget savings`, pane id `budget-savings`): the estimated dollars each lever saved, for this session and across all sessions.

## What it does

| Lever | Behaviour | Ledger category |
| --- | --- | --- |
| **Session routing** | On the first prompt of a session, Haiku sorts it as *quick*, *normal* or *hard*. Quick runs on Sonnet 5.5 at low effort; normal and hard run on Opus 5.5 at medium. This applies only while the session model is Opus. `/budget route opus\|sonnet` pins the choice. | `route-session` |
| **Opus effort cap** | Every Opus request, main loop and subagents, is capped at `opusMaxEffort` (default `medium`). A rule: it applies in holdout sessions too. | (none) |
| **Compaction at `compactAt`** | When a turn ends with the context at or over `compactAt` (default 200k), the conversation is compacted before the next prompt, whatever `autoCompactWindow` says. Each session also switches the engine's auto-compact back on if it was turned off. A rule: it applies in holdout sessions too. `/budget compact off` leaves compaction to the engine. | (none) |
| **Subagent routing** | `Explore`, `claude-code-guide` and `statusline-setup` run on Haiku. `fork` keeps its model. Every other subagent runs on Sonnet. Engine forks (compaction, memory) are left alone. | `route-agents` |
| **Subagent cap** | At most `maxAgents` (default 3) Agent calls per session; further calls are denied with a message. | (not counted) |
| **New-task check** | With at least `newTaskAt` (default 60k) of context loaded, a substantial prompt that Haiku judges to be a new task is held. You then choose clear, compact or keep. | `new-task` |
| **Context hold** | At `block` (default 300k) prompts are held until you /compact or /clear. Prefix a prompt with `force:` to send it anyway. | (none) |
| **Read guards** | Reads of images are denied (unless `/budget images on`), as are reads of generated or vendored files: `node_modules`, `dist`, `build`, `.next`, `coverage`, lockfiles, `*.min.*`, `*.map`, `*.log`. | (not counted) |
| **Build/test output trim** | Noisy commands keep only their last 300 lines in context; the full log goes to `$TMPDIR/budget-guard.XXXXXX`. Noisy means npm/pnpm/yarn/bun test/build/lint, jest, vitest, playwright, tsc, eslint, pytest, go/cargo test/build, docker build. | `output-trim` |
| **Keep-alive** | On gateway profiles only, a tiny fork ping every 270s (at most 6) keeps the prompt cache warm while you are idle. It turns itself off if a ping misses the cache. | `keep-alive` |
| **Spend polling** | On gateway profiles, it reads LiteLLM `/key/info` every 60s for key spend, max budget and reset time. | (none) |

lean-tools works alongside this. It caps *other* large shell output and leaves budget-guard's noisy commands to budget-guard.

## `/budget`

```
/budget                          status
/budget savings                  savings pane (or a text summary)
/budget route opus|sonnet|auto|off
/budget daily|monthly <$|off>    per-profile budget, saved to budgets.json
/budget warn|block|agents|bigturn|newtask <n>    e.g. /budget block 250k
/budget images|keepalive|trim|agentroute on|off
/budget reset                    session limits back to defaults
/budget refresh                  re-read LiteLLM spend now
/budget compact <n>|off          compact at n tokens of context (default 200k), saved to config.json
/budget holdout <0-1>            share of sessions without the cost levers, for /analytics impact (default 0.1)
/budget pause <30m|2h|1d|session>   routing, the effort cap, compaction, trimming and keep-alive step aside
/budget resume                   ends a pause (so does its time running out)
```

A pause keeps the budgets, the band and the context hold: it is for a stretch of work that needs Opus at full effort, not for turning the guard off. `/mods pause` pauses budget-guard with the other mods.

Limits set with `/budget` last for the current session. Budgets persist.

## Defaults

`warn 150k · block 300k · maxAgents 3 · bigTurn 50k · newTaskAt 60k · allowImages off · route on · routeAgents on · keepAlive on · trimOutput on`. These are `DEFAULTS` at the top of `register.tsx`.

## Files

| Path | Contents |
| --- | --- |
| `<mods home>/budget-guard/budgets.json` | `{ profiles: { "<profile>": { daily: 25, monthly: 500 } } }` (set by `/budget setup` or `/budget daily|monthly`) |
| `<mods home>/budget-guard/sessions/<profile>-<session>.json` | Per-session ledger: day, profile, spend, and savings by category. The dashboard's Savings tab reads these. |
| `<mods home>/budget-guard/config.json` | What every session starts from: `holdout` (0.1, see /budget holdout), `limits` (overrides of the defaults below, e.g. `{ "route": false, "block": 400000 }`), `opusMaxEffort` (`medium`; `max` means no cap), `compactAt` (200000; 0 leaves compaction to the engine), `litellm` (`auto`: poll LiteLLM key spend on a gateway and stop if it has no `/key/info`; `on`; `off`). `/budget setup` writes it. |
| `<mods home>/budget-guard/key-baselines.json` | LiteLLM key spend at period starts: the fallback for the daily and monthly gauges when the gateway has no `/user/daily/activity` (normally the gauges use LiteLLM's per-day spend). |
| `$TMPDIR/budget-guard.*` | Full logs of trimmed commands. |

## Is it worth it?

A random 10% of sessions run in the **holdout** arm. The band and budgets stay on there, but routing, trimming, keep-alive, the new-task check, the guards and the effort cap are off. `/budget` shows the session's arm. `/analytics impact` compares the two arms and prices the Haiku classifier calls and keep-alive pings against the savings. See [mod-impact.md](mod-impact.md).

## Notes

- Savings are estimates: the cost of the same tokens on Opus minus the actual cost, or tokens kept out of context multiplied by about 10 future re-reads.
- The prices in `PRICE` are internal per-MTok weights used for those estimates. The analytics DB uses its own `pricing.json`.
