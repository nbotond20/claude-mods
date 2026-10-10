# lsp-first

Gets the model to use the language server for symbol questions instead of grepping and reading whole files. Without it the LSP tool is deferred and, in practice, rarely called (one setup measured 0 LSP calls against about 15k grep/rg/find searches).

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

lsp-first needs a language server plugin; without one it does nothing. For TypeScript/JavaScript:

```sh
npm i -g typescript-language-server typescript
```
```
/plugin install typescript-lsp@claude-plugins-official
```

Check it with `typescript-language-server --version`. In a session, the LSP tool should appear in `/context` under tools that are not deferred. `/lsp-first setup` checks for the LSP tool and walks through the options.

## Config: `<mods home>/lsp-first/config.json`

`{ "enabled": true, "holdout": 0.2, "upfront": true, "guide": true, "nudges": true }`, or `/lsp-first [status|on|off|holdout <0-1>|nudges|guide on|off]`. In holdout sessions LSP stays deferred, and no guide or nudges are added.

## Measuring it

**`/analytics impact`** compares sessions with and without lsp-first, prices the up-front schema and guide, and shows how often a nudge led to an LSP call. See [mod-impact.md](mod-impact.md). Also:

Use **Tools → LSP vs text search per day** and **LSP operations** in the dashboard, plus the Overview insight "LSP calls: N vs M grep/rg/find searches".
