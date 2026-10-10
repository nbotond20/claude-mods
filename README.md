# claude-mods

Claude Code mods (function-hook plugins), shipped as the marketplace **`my-mods`**. They work with a single `~/.claude` setup and with several profiles (`CLAUDE_CONFIG_DIR=~/.claude-work`, `~/.claude-personal`, …).

| Mod | What it does | Doc |
| --- | --- | --- |
| **usage-analytics** | Logs every session, folds every profile's transcripts (including history from before the install) into one SQLite DB, `/analytics` reports and a live web dashboard | [docs/usage-analytics.md](docs/usage-analytics.md) |
| **budget-guard** | Live spend/context band, model and subagent routing, context hold, budgets, output trimming, keep-alive, savings ledger, `/budget` | [docs/budget-guard.md](docs/budget-guard.md) |
| **lean-tools** | Caps huge shell output, bounds `git log`, nudges toward batched calls, ranged reads and Edit over Write | [docs/lean-tools.md](docs/lean-tools.md) |
| **lsp-first** | Keeps the LSP tool loaded and tells the model to use it for code symbols instead of grep + Read | [docs/lsp-first.md](docs/lsp-first.md) |
| **no-attribution** | Claude never credits itself: engine attribution off, a prompt rule, tool calls with attribution refused, optional global git hooks | [docs/no-attribution.md](docs/no-attribution.md) |
| *Mod impact* | Each mod leaves a random holdout of sessions untouched; `/analytics impact` says whether it saves money or costs more | [docs/mod-impact.md](docs/mod-impact.md) |

## Install

Requires Claude Code with mod support and **python3** (standard library only) for usage-analytics.

```
/plugin marketplace add nbotond20/claude-mods
/plugin install usage-analytics@my-mods
/plugin install budget-guard@my-mods        # and any of: lean-tools, lsp-first, no-attribution
```

Restart the session. Each mod starts with sensible defaults and says so once in a toast. To tailor one, run its setup wizard; it asks a few questions and writes the config:

| Wizard | Asks about |
| --- | --- |
| `/analytics setup` | which profiles to track, whether to keep prompt text, when the dashboard runs (with Claude Code, also from login, or only on `/dashboard`) |
| `/budget setup` | daily/monthly limits for this profile, model routing, the Opus effort cap, when to hold large-context prompts |
| `/lean setup` | output caps and nudges |
| `/lsp-first setup` | whether the language server is installed, guide and nudges |
| `/no-attribution setup` | whether to install the global git hooks |

On first start usage-analytics starts the dashboard server and imports every transcript already on disk in the background; the dashboard shows the progress and fills in as it goes.

### Several profiles

Install the mods once per config dir (each keeps its own plugin cache):

```sh
for d in ~/.claude ~/.claude-work ~/.claude-personal; do
  CLAUDE_CONFIG_DIR=$d claude plugin marketplace add nbotond20/claude-mods
  for m in usage-analytics budget-guard lean-tools lsp-first no-attribution; do
    CLAUDE_CONFIG_DIR=$d claude plugin install $m@my-mods
  done
done
```

All profiles share one data folder, so the dashboard shows them together and per profile. Every session registers its config dir, so usage-analytics also finds profiles outside `~/.claude*`; `profileDirs` in its config (or `/analytics setup`) lists them explicitly.

### Updating

```sh
claude plugin marketplace update my-mods
claude plugin update <mod>@my-mods            # per profile: prefix with CLAUDE_CONFIG_DIR=…
```

A running dashboard server older than the installed mod is replaced at the next session start.

## Commands

| Command | Does |
| --- | --- |
| `/dashboard [tab]` | opens the dashboard, e.g. `/dashboard live`, `/dashboard impact`. One server per machine; it is started on demand and updates live as you work. |
| `/analytics setup` · `status` · `ingest` · `stop` | setup wizard · data status · fold in new data now · stop the dashboard |
| `/analytics impact` | are the mods saving money or costing more |
| `/analytics [report] [--days N] [--profile P]` | terminal reports |
| `/budget …` · `/budget setup` | budget-guard (see its doc) |
| `/lean [setup\|status\|on\|off\|holdout <0-1>\|cap\|nudges\|guide on\|off]` | lean-tools |
| `/lsp-first [setup\|status\|on\|off\|holdout <0-1>\|nudges\|guide on\|off]` | lsp-first |
| `/no-attribution [setup\|status\|hooks on\|off]` | no-attribution |

The CLI behind usage-analytics is `<plugin>/bin/claude-usage` (`claude-usage --help`); `claude-usage autostart on` also keeps the dashboard running from login (launchd on macOS, systemd on Linux).

## Where data lives

Everything the mods keep goes in one **mods home**, shared by every profile:

1. `$CLAUDE_MODS_HOME`, if set;
2. else `~/.claude-shared`, if it already exists (older installs keep working);
3. else `~/.claude-mods`.

```
<mods home>/
  usage-analytics/ config.json, usage.db, events/<profile>/<day>/*.jsonl, profiles/, live/, pricing.json, dashboard.log
  budget-guard/    config.json, budgets.json, key-baselines.json, sessions/<profile>-<session>.json
  lean-tools/      config.json
  lsp-first/       config.json
  no-attribution/  config.json, git-hooks/      ← global core.hooksPath when gitHooks is on
```

`CLAUDE_USAGE_DIR` overrides the usage-analytics folder alone.

## Developing

```
.claude-plugin/marketplace.json            ← lists the mods
<mod>/.claude-plugin/plugin.json           ← name, version, description
<mod>/hooks/hooks.json → hooks/register.ts(x)
<mod>/tests/*.test.ts
docs/
```

```sh
claude --plugin-dir ./<mod>       # run a mod without installing it
claude plugin validate <mod>      # manifest + what the engine would refuse
claude plugin test <mod>          # tests/*.test.ts
```

After a change, **bump the mod's `version`**: `plugin update` only copies a new cache when the version changes.

## Secrets

None of the mods store credentials. usage-analytics records only *whether* an auth token is set and the gateway **hostname**, and blanks anything that looks like a credential in commands and output before writing it; its tests check that no secret ends up in the log.
