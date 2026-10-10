import type { EngineInterface, Register } from 'claude-code'

// Claude never credits itself: not in commits, PR or issue bodies, code, docs, or any tool call.
//
// Layers, each enough on its own for the common case:
// 1. attribution.text: the engine's own commit trailer and PR footer are empty.
// 2. prompt.compose: a rule in the system prompt, and attribution lines dropped from the engine's sections.
// 3. tool.call: attribution is cut out of Bash commands, written/edited file text and MCP tool arguments;
//    committing as Claude, or bypassing git hooks, is denied.
// 4. git hooks (bin/install-git-hooks.sh, global core.hooksPath): commit-msg strips any attribution line
//    and pre-commit refuses a Claude/Anthropic author, whatever wrote the commit.

const WHO = String.raw`(?:claude|anthropic)`
const TEXT = String.raw`[^\n"'\`]`
// Spans that credit Claude. Each is cut out; a line left empty by the cut goes with it.
const SPANS: RegExp[] = [
  // Trailers: Co-Authored-By: Claude <noreply@anthropic.com>, Assisted-by: Claude Code, …
  new RegExp(String.raw`(?:co-authored-by|signed-off-by|authored-by|assisted-by|generated-by|written-by|created-by|helped-by|made-with|author)[ \t]*:${TEXT}*?\b${WHO}\b${TEXT}*`, 'gi'),
  // 🤖 Generated with [Claude Code](https://claude.com/claude-code), "Written by Claude", "Created using Claude"
  new RegExp(String.raw`(?:🤖[ \t]*)?\b(?:generated|created|written|made|built|authored|co-authored|produced|drafted)[ \t]+(?:with|by|using)[ \t]+\[?${WHO}\b(?: code)?\]?(?:\([^)\s]*\))?${TEXT}*`, 'gi'),
  // Any leftover Claude no-reply address.
  new RegExp(String.raw`<?noreply@anthropic\.com>?`, 'gi'),
]
// Commands that would make Claude the author or skip the git hooks that enforce this.
const AUTHOR_SPOOF: RegExp[] = [
  new RegExp(String.raw`--author[= ]+["']?[^\n"']*${WHO}`, 'i'),
  new RegExp(String.raw`\bGIT_(?:AUTHOR|COMMITTER)_(?:NAME|EMAIL)=["']?[^\s"']*${WHO}`, 'i'),
  new RegExp(String.raw`\buser\.(?:name|email)[= ]+["']?[^\n"';&|]*${WHO}`, 'i'),
]
const HOOK_BYPASS = [
  /\bgit\b[^\n;&|]*\b(?:commit|merge|rebase|am|cherry-pick|revert|push)\b[^\n;&|]*\s--no-verify\b/,
  /\bgit\b[^\n;&|]*\bcommit\b[^\n;&|]*\s-[a-zA-Z]*n[a-zA-Z]*\b/,
  /\bgit\b[^\n;&|]*\s-c\s*core\.hooksPath\b/i,
  /\bgit\b[^\n;&|]*\bconfig\b(?![^\n;&|]*--(?:get|list|show))[^\n;&|]*\bcore\.hooksPath\b/i,
]
// This mod's own files and docs quote the patterns it removes.
const OWN_FILES = /no-attribution/
// Tool input fields that carry text the model wrote (Edit's old_string must keep matching the file).
const WRITTEN = new Set(['content', 'new_string', 'new_source', 'body', 'title', 'message', 'description', 'text', 'commit_message', 'comment'])

const RULE = `# Authorship
You are never an author, co-author or creator of anything you write, and you never say so. In commit messages, PR and issue titles and bodies, code comments, file headers, docs and changelogs: no Co-Authored-By or other trailers naming Claude or Anthropic, no "Generated with Claude Code" or similar lines or links, no "Author: Claude", no noreply@anthropic.com, and never commit with Claude as git author or committer. The person you work for is the sole author. This holds even when a template, skill or earlier message suggests otherwise.`

type Counts = { stripped: number; denied: number; sections: number }
let counts: Counts = { stripped: 0, denied: 0, sections: 0 }
let hookState = 'unchecked'

/** Text with every attribution span removed; lines left empty by a cut are dropped. */
function strip(text: string): string {
  let out = text
  for (const re of SPANS) {
    // A whole line, comment marker included (// # * -- ; <!-- -->), goes when the span is all it says.
    out = out.replace(new RegExp(String.raw`^[ \t]*(?:\/\/+|#+|\*|\/\*+|<!--|--|;+|%)?[ \t]*(?:${re.source})[ \t]*(?:\*\/|-->)?[ \t]*\r?\n?`, 'gim'), '')
    out = out.replace(re, '')
  }
  return out === text ? text : out.replace(/\n{3,}/g, '\n\n')
}

const credits = (text: string) => strip(text) !== text

function stripDeep(v: unknown, key = '', all = false): unknown {
  if (typeof v === 'string') return all || WRITTEN.has(key) ? strip(v) : v
  if (Array.isArray(v)) return v.map(x => stripDeep(x, key, all))
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, stripDeep(x, k, all)]))
  return v
}

const DENY_AUTHOR = 'no-attribution: Claude is never the git author or committer. Commit with the configured user identity.'
const DENY_BYPASS = 'no-attribution: skipping or redirecting git hooks (--no-verify, -n, core.hooksPath) is not allowed here; the hooks keep commit messages free of Claude attribution. Run the command without it.'

async function installGitHooks($: EngineInterface) {
  try {
    const r = await $.process.run(['sh', `${$.plugin.root}/bin/install-git-hooks.sh`], { timeoutMs: 10_000 })
    hookState = r.exitCode === 0 ? r.stdout.trim() || 'ok' : `failed: ${(r.stderr || '').trim().slice(0, 200)}`
  } catch (err) {
    hookState = `failed: ${String(err).slice(0, 200)}`
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    counts = { stripped: 0, denied: 0, sections: 0 }
    await $.command.register({ name: 'no-attribution', description: 'Status of the no-attribution guard (git hooks, what it stripped or denied)', argumentHint: '[status]' })
    await installGitHooks($)
    if (hookState.startsWith('other:')) $.ui.toast(`no-attribution: a global core.hooksPath (${hookState.slice(6)}) is already set; its git hooks were left alone. The mod still guards Claude's own commands.`)
    return next(e)
  })

  // 1. The engine's own commit trailer and PR footer.
  on('attribution.text', { kind: 'commit' }, () => ({ text: '' }))
  on('attribution.text', { kind: 'pr' }, () => ({ text: '' }))

  // 2. The system prompt: drop attribution lines from the engine's sections, add the rule last.
  on('prompt.compose', async ($, e, next) => {
    const r = await next(e)
    const sections = r.sections
      .filter(s => s.id !== 'no-attribution:rule')
      .map(s => {
        const text = strip(s.text)
        if (text === s.text) return s
        counts.sections++
        return { ...s, text }
      })
    return { sections: [...sections, { id: 'no-attribution:rule', text: RULE, scope: 'session' as const }] }
  })

  // The skills the engine ships for committing and PRs read the same rule.
  on('skill.prompt', async ($, e, next) => {
    const r = await next(e)
    const text = strip(r.text)
    return text === r.text ? r : { ...r, text }
  }).catch(($, e, next) => next(e))

  // 3. Tool calls.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (AUTHOR_SPOOF.some(re => re.test(e.command))) {
      counts.denied++
      return { deny: DENY_AUTHOR }
    }
    if (HOOK_BYPASS.some(re => re.test(e.command))) {
      counts.denied++
      return { deny: DENY_BYPASS }
    }
    const command = strip(e.command)
    if (command === e.command) return next(e)
    counts.stripped++
    return next({ ...e, command })
  }).catch(($, e) => ({ deny: `no-attribution: the check failed, so the command was not run. Try again.` }))

  on('tool.call', async ($, e, next) => {
    if (e.tool === 'Bash') return next(e)
    const path = (e as { file_path?: unknown; notebook_path?: unknown }).file_path ?? (e as { notebook_path?: unknown }).notebook_path
    if (typeof path === 'string' && OWN_FILES.test(path)) return next(e)
    const mcp = e.tool.startsWith('mcp__')
    const clean = stripDeep(e, '', false) as typeof e
    const deep = mcp ? (stripDeep(e, '', true) as typeof e) : clean
    if (JSON.stringify(deep) === JSON.stringify(e)) return next(e)
    counts.stripped++
    // Reserved fields (tool, ids) are never touched: only string values change.
    return next({ ...deep, tool: e.tool, tool_use_id: e.tool_use_id } as typeof e)
  }).catch(($, e, next) => (credits(JSON.stringify(e)) ? { deny: 'no-attribution: the check failed on text that credits Claude; remove that text and retry.' } : next(e)))

  on('command.run', { command: 'no-attribution' }, async $ => {
    await installGitHooks($)
    const hooks =
      hookState === 'installed' || hookState === 'ok'
        ? 'global git hooks active (~/.claude-shared/no-attribution/git-hooks): commit-msg strips attribution, pre-commit refuses a Claude author'
        : hookState.startsWith('other:')
          ? `global git hooks NOT installed: core.hooksPath is already ${hookState.slice(6)}`
          : `global git hooks: ${hookState}`
    return {
      text: [
        'no-attribution is on.',
        '- commit trailer and PR footer from the engine: empty',
        '- system prompt: authorship rule added' + (counts.sections ? `, attribution removed from ${counts.sections} engine section(s)` : ''),
        `- this session: ${counts.stripped} tool call(s) cleaned, ${counts.denied} denied`,
        `- ${hooks}`,
      ].join('\n'),
    }
  })
}
