# claude-mods

Local Claude Code mods (function-hook plugins), shipped as the marketplace **`my-mods`** and installed in every profile (`~/.claude-db`, `~/.claude-infi`, `~/.claude-my`).

| Mod | What it does | Doc |
| --- | --- | --- |
| **budget-guard** | Live spend/context band, model and subagent routing, context hold, budgets, output trimming, keep-alive, savings ledger, `/budget` | [docs/budget-guard.md](docs/budget-guard.md) |
| **usage-analytics** | Logs every session to a central store, folds all profiles' transcripts into one SQLite DB, `/analytics` reports and a web dashboard | [docs/usage-analytics.md](docs/usage-analytics.md) |
| **lean-tools** | Caps huge shell output, bounds `git log`, nudges toward batched calls / ranged reads / Edit over Write | [docs/lean-tools.md](docs/lean-tools.md) |
| **lsp-first** | Keeps the LSP tool loaded and tells the model to use it for TS/JS symbols instead of grep + Read | [docs/lsp-first.md](docs/lsp-first.md) |
| *Mod impact* | Each mod leaves a random holdout of sessions untouched; `/analytics impact` says whether it saves money or costs more | [docs/mod-impact.md](docs/mod-impact.md) |
| *typescript-lsp* (official plugin) | The LSP server lsp-first relies on | [docs/lsp-first.md](docs/lsp-first.md#the-typescript-language-server) |

## Commands

| Command | Does |
| --- | --- |
| `/dashboard [tab]` | opens the analytics dashboard (starts it if needed); e.g. `/dashboard impact`, `/dashboard tools` |
| `/analytics impact` | are the mods saving money or costing more |
| `/analytics status` · `ingest` · `stop` | data status · fold in new data now · stop the dashboard |
| `/analytics [report] [--days N] [--profile P]` | terminal reports |
| `/budget …` · `/budget holdout <0-1>` | budget-guard (see its doc) |
| `/lean [status\|on\|off\|holdout <0-1>\|cap\|nudges\|guide on\|off]` | lean-tools |
| `/lsp-first [status\|on\|off\|holdout <0-1>\|nudges\|guide on\|off]` | lsp-first |

## Where everything lives

```
~/Desktop/projects/claude-mods/          ← this repo (the source; marketplace "my-mods")
  .claude-plugin/marketplace.json        ← lists the four mods
  budget-guard/  usage-analytics/  lean-tools/  lsp-first/
    .claude-plugin/plugin.json           ← name, version, description
    hooks/hooks.json → hooks/register.ts(x)   ← the mod
    tests/*.test.ts                      ← `claude plugin test <dir>`
  docs/                                  ← these docs

~/.claude-shared/                        ← shared by every profile
  settings.json                          ← symlinked as ~/.claude-*/settings.json
  budget-guard/   budgets.json, key-baselines.json, sessions/<profile>-<session>.json
  usage-analytics/ config.json, events/<profile>/<day>/*.jsonl, usage.db, pricing.json, dashboard.log
  lean-tools/     config.json
  lsp-first/      config.json

~/.claude-<profile>/plugins/cache/my-mods/<mod>/<version>/   ← installed copies (what actually runs)
~/.local/bin/typescript-language-server, tsc                 ← for the LSP
```

## Shared settings that matter (`~/.claude-shared/settings.json`)

- `model: claude-opus-5-5`, `effortLevel: high` with an Opus override to `medium` (budget-guard also caps Opus at medium).
- `env.CLAUDE_CODE_SUBAGENT_MODEL = claude-sonnet-5-5`: subagents default to Sonnet.
- `autoCompactWindow: 200000` (was 250000). About 40–50% of spend came from requests over 200k context, so auto-compaction now fires earlier. budget-guard reads this value and shows `compacts ~200k` in its band.
- `enabledPlugins`: `budget-guard@my-mods`, `usage-analytics@my-mods`, `lean-tools@my-mods`, `lsp-first@my-mods`, `typescript-lsp@claude-plugins-official`.
- `outputStyle: Concise`.

## Installing and updating

The settings file is shared, but every profile keeps its own plugin cache. Install or update once per profile:

```sh
for p in db infi my; do
  export CLAUDE_CONFIG_DIR=~/.claude-$p
  claude plugin marketplace update my-mods
  for m in budget-guard usage-analytics lean-tools lsp-first; do
    claude plugin update $m@my-mods || claude plugin install $m@my-mods
  done
done
```

After you change a mod, **bump its `version`** in `.claude-plugin/plugin.json`; `update` only copies a new cache when the version changes. Then restart the sessions. To work on a mod without installing it: `claude --plugin-dir ./<mod>`.

## Checking a mod

```sh
claude plugin validate <mod>    # manifest + what the engine would refuse
claude plugin test <mod>        # tests/*.test.ts
```

Type-check with a tsconfig whose `include` names the engine's `claude-code.d.ts` and the mod's `hooks/` (see each mod's `tsconfig.json`).

## Secrets

`~/.zshrc` holds the gateway token and Cloudflare Access headers for claude-infi. None of the mods store them. usage-analytics records only *whether* a token is set and the gateway **hostname**; its test checks that no secret ends up in the log.
