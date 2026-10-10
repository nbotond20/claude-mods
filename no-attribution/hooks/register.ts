import type { EngineInterface, Register } from 'claude-code'

// Claude never credits itself: not in commits, PR or issue bodies, code, docs, or any tool call.
//
// Layers, each enough on its own for the common case:
// 1. attribution.text: the engine's own commit trailer and PR footer are empty.
// 2. prompt.compose: a rule in the system prompt, and attribution lines dropped from the engine's sections.
// 3. tool.call: a Bash command, file write/edit or MCP call carrying attribution is refused (never rewritten,
//    so what runs is exactly what was approved) with the clean version to send; so is committing as Claude
//    or bypassing git hooks.
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

/**
 * The folder the mods share: $CLAUDE_MODS_HOME, else ~/.claude-shared when it already exists, else ~/.claude-mods.
 */
let modsHomeDir = ''
async function modsHome($: EngineInterface) {
  if (modsHomeDir) return modsHomeDir
  const set = await $.env.get('CLAUDE_MODS_HOME')
  const home = (await $.env.get('HOME')) ?? ''
  modsHomeDir = set ? set.replace(/\/+$/, '') : (await $.fs.exists(`${home}/.claude-shared`).catch(() => false)) ? `${home}/.claude-shared` : `${home}/.claude-mods`
  return modsHomeDir
}

type Config = {
  /** install the global git hooks (core.hooksPath) that clean every commit message, whoever writes it */
  gitHooks: boolean
}
const DEFAULTS: Config = { gitHooks: true }
let cfg: Config = DEFAULTS
let firstRun = false

async function configPath($: EngineInterface) {
  return `${await modsHome($)}/no-attribution/config.json`
}

async function loadConfig($: EngineInterface) {
  const path = await configPath($)
  try {
    cfg = { ...DEFAULTS, ...JSON.parse(String(await $.fs.read(path))) }
    firstRun = false
  } catch {
    cfg = DEFAULTS
    firstRun = true
    await $.fs.write(path, JSON.stringify(cfg, null, 2) + '\n').catch(() => {})
  }
}

/** The setup wizard, run by the model: one question, then the config file and the hooks to match. */
export function setupPrompt(configFile: string, script: string, current: Config) {
  return `Set up the no-attribution mod with me. Keep it short.

Whatever I answer, Claude never credits itself: the engine's trailers are empty, the system prompt says so, and tool calls carrying attribution are refused.
1. Ask me with the AskUserQuestion tool: "Also clean commit messages in every repository with global git hooks?": "Yes (recommended)": a commit-msg hook strips Claude attribution lines from every commit, whoever writes it, and pre-commit refuses Claude as author; each repository's own hooks still run (gitHooks true). "No, only what Claude does" (gitHooks false). Mark my current choice "(current)". Mention that a repository with its own core.hooksPath (Husky, lefthook) bypasses global hooks.
2. Write ${configFile} with gitHooks set, keeping other keys.
3. Run \`sh "${script}"\` to install them, or \`sh "${script}" remove\` to remove them, to match.
4. Tell me in one line what is set; /no-attribution setup runs this again.

Current config (${configFile}):
${JSON.stringify(current, null, 2)}`
}

type Counts = { denied: number; sections: number }
let counts: Counts = { denied: 0, sections: 0 }
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

/** The deny message: the attribution found, and what to do instead. */
function denyText(text: string, fix: string) {
  const found = new Set<string>()
  for (const re of SPANS) for (const m of text.matchAll(new RegExp(re.source, 'gi'))) found.add(m[0].trim().slice(0, 120))
  return `no-attribution: this credits Claude, which is never allowed (${[...found].map(f => JSON.stringify(f)).join(', ')}). ${fix}`
}

async function installGitHooks($: EngineInterface, remove = false) {
  if (!cfg.gitHooks && !remove) {
    hookState = 'off'
    return
  }
  try {
    const r = await $.process.run(['sh', `${$.plugin.root}/bin/install-git-hooks.sh`, ...(remove ? ['remove'] : [])], { timeoutMs: 10_000, env: { CLAUDE_MODS_HOME: await modsHome($) } })
    hookState = r.exitCode === 0 ? r.stdout.trim() || 'ok' : `failed: ${(r.stderr || '').trim().slice(0, 200)}`
  } catch (err) {
    hookState = `failed: ${String(err).slice(0, 200)}`
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    counts = { denied: 0, sections: 0 }
    await $.command.register({ name: 'no-attribution', description: 'Status of the no-attribution guard (git hooks, what it refused) · setup · hooks on|off', argumentHint: '[status | setup | hooks on|off]' })
    await loadConfig($)
    await installGitHooks($)
    if (firstRun && hookState === 'installed') $.ui.toast('no-attribution installed global git hooks that strip Claude attribution from commit messages. /no-attribution hooks off removes them.')
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
    // Never rewrite: the person approved this exact command. Refuse it and show the clean one to send instead.
    const command = strip(e.command)
    if (command === e.command) return next(e)
    counts.denied++
    return { deny: denyText(e.command, `Run it again without that text:\n${command}`) }
  }).catch(($, e) => ({ deny: `no-attribution: the check failed, so the command was not run. Try again.` }))

  on('tool.call', async ($, e, next) => {
    if (e.tool === 'Bash') return next(e)
    const path = (e as { file_path?: unknown; notebook_path?: unknown }).file_path ?? (e as { notebook_path?: unknown }).notebook_path
    if (typeof path === 'string' && OWN_FILES.test(path)) return next(e)
    const clean = stripDeep(e, '', e.tool.startsWith('mcp__'))
    if (JSON.stringify(clean) === JSON.stringify(e)) return next(e)
    // Never rewrite what the person approved: refuse, and the model sends it again without the attribution.
    counts.denied++
    return { deny: denyText(JSON.stringify(e), `Send the ${e.tool} call again with that text removed.`) }
  }).catch(($, e, next) => (credits(JSON.stringify(e)) ? { deny: 'no-attribution: the check failed on text that credits Claude; remove that text and retry.' } : next(e)))

  on('command.run', { command: 'no-attribution' }, async ($, e) => {
    const [what, val] = e.args.trim().split(/\s+/)
    if (what === 'setup') {
      const text = setupPrompt(await configPath($), `${$.plugin.root}/bin/install-git-hooks.sh`, cfg)
      // Submitted once this command has returned (a command hook cannot wait on the turn it would start).
      $.clock.after(50, () => void $.prompt.submit({ text }).catch(() => {}))
      return { text: 'Starting the no-attribution setup…' }
    }
    if (what === 'hooks' && (val === 'on' || val === 'off')) {
      cfg = { ...cfg, gitHooks: val === 'on' }
      await $.fs.write(await configPath($), JSON.stringify(cfg, null, 2) + '\n')
      await installGitHooks($, val === 'off')
      if (val === 'off') return { text: hookState === 'removed' ? 'Global git hooks removed (core.hooksPath unset).' : 'No no-attribution git hooks were installed.' }
    } else if (what && what !== 'status') {
      return { text: 'Usage: /no-attribution [status | setup | hooks on|off]' }
    } else {
      await installGitHooks($)
    }
    const hooks =
      hookState === 'installed' || hookState === 'ok'
        ? `global git hooks active (${await modsHome($)}/no-attribution/git-hooks): commit-msg strips attribution, pre-commit refuses a Claude author`
        : hookState === 'off'
          ? 'global git hooks off (/no-attribution hooks on adds them)'
          : hookState.startsWith('other:')
            ? `global git hooks NOT installed: core.hooksPath is already ${hookState.slice(6)}`
            : `global git hooks: ${hookState}`
    return {
      text: [
        'no-attribution is on.',
        '- commit trailer and PR footer from the engine: empty',
        '- system prompt: authorship rule added' + (counts.sections ? `, attribution removed from ${counts.sections} engine section(s)` : ''),
        `- this session: ${counts.denied} tool call(s) refused (attribution, Claude as author, or skipped hooks)`,
        `- ${hooks}`,
      ].join('\n'),
    }
  })
}
