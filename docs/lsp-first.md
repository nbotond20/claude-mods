# lsp-first

Gets the model to use the TypeScript language server for TS/JS symbol questions instead of grepping and reading whole files. Before this, the LSP tool had **never** been called (0 calls against about 15k grep/rg/find searches), because the language server binary was missing.

Source: `lsp-first/hooks/register.ts`. Tests: `lsp-first/tests/`.

## What it does

1. **Keeps the LSP tool's schema in the prompt.** `tool.describe` with `isDeferred: false` puts it in the tool list instead of behind ToolSearch, so using it costs no extra round trip.
2. **Adds the system prompt section `lsp-first:guide`** whenever the LSP tool is present. It covers:
   - `goToDefinition` / `workspaceSymbol` for "where is X defined";
   - `findReferences` / `incomingCalls` / `outgoingCalls` for "who uses X";
   - `hover` for types and signatures;
   - `documentSymbol` for a file's outline;
   - `goToImplementation`.
   grep stays the tool for strings, comments, config and files that are not TS/JS.
3. **Nudges.** When a Bash `grep`/`rg`/`git grep`/`ag` (or a Grep tool, on builds that have one) searches TS/JS for a bare identifier, the result carries a one-line hint naming the LSP operation to use. This happens at most once every 10 minutes.

## The TypeScript language server

- The official plugin **`typescript-lsp@claude-plugins-official`** is enabled in the shared settings and installed in every profile.
- It runs `typescript-language-server`. Version 5.3.0 is installed globally and symlinked, together with `tsc`, into `~/.local/bin`, which is on PATH.
- Check it with `typescript-language-server --version`. In a session, the LSP tool should appear in `/context` under tools that are not deferred.

## Config: `~/.claude-shared/lsp-first/config.json`

`{ "enabled": true, "holdout": 0.2, "upfront": true, "guide": true, "nudges": true }`, or `/lsp-first [status|on|off|holdout <0-1>|nudges|guide on|off]`. In holdout sessions LSP stays deferred, and no guide or nudges are added.

## Measuring it

**`/analytics impact`** compares sessions with and without lsp-first, prices the up-front schema and guide, and shows how often a nudge led to an LSP call. See [mod-impact.md](mod-impact.md). Also:

Use **Tools → LSP vs text search per day** and **LSP operations** in the dashboard, plus the Overview insight "LSP calls: N vs M grep/rg/find searches".
