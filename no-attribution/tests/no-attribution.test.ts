import { describe, expect, test } from 'claude-code/testing'

function engine(on: any) {
  const seen: any[] = []
  on('session.start', ($: any, e: any) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: undefined }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: 'ok\n', stderr: '' } }))
  on('ui.toast', () => ({ value: undefined }))
  on('tool.call', ($: any, e: any) => (seen.push(e), { result: 'ok', text: 'ok' }))
  on('attribution.text', ($: any, e: any) => ({ text: e.text }))
  on('prompt.compose', () => ({
    sections: [{ id: 'actions', scope: 'shared', text: 'Commit like this:\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>\n\nDone.' }],
  }))
  return seen
}

const COMMIT = `git commit -m "$(cat <<'EOF'
Fix the parser

Handles empty input.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"`

describe('no-attribution', () => {
  test('a commit carrying attribution is refused, never rewritten, with the clean command to send', async ($, on) => {
    const seen = engine(on)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/w' } as any)
    const r: any = await $.tool.call({ tool: 'Bash', tool_use_id: '1', command: COMMIT } as any)
    expect(seen.length).toBe(0)
    expect(r.deny).toMatch(/no-attribution: this credits Claude/)
    expect(r.deny).toContain('Co-Authored-By: Claude Opus 5.5')
    const clean = r.deny.slice(r.deny.indexOf('without that text:\n') + 'without that text:\n'.length)
    expect(clean).not.toMatch(/claude|anthropic|🤖/i)
    expect(clean).toContain('Fix the parser\n\nHandles empty input.')
  })

  test('inline -m trailers and gh pr bodies are refused', async ($, on) => {
    const seen = engine(on)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/w' } as any)
    const a: any = await $.tool.call({ tool: 'Bash', tool_use_id: '1', command: 'git commit -m "Fix" -m "Co-authored-by: Claude <noreply@anthropic.com>"' } as any)
    expect(a.deny).toContain('git commit -m "Fix" -m ""')
    const b: any = await $.tool.call({ tool: 'Bash', tool_use_id: '2', command: 'gh pr create --title "Fix" --body "Summary\n\nGenerated with Claude Code"' } as any)
    expect(b.deny).toMatch(/Generated with Claude Code/)
    expect(seen.length).toBe(0)
  })

  test('denies Claude as author and skipping hooks; leaves normal git alone', async ($, on) => {
    const seen = engine(on)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/w' } as any)
    for (const command of [
      'git commit --author="Claude <noreply@anthropic.com>" -m x',
      'GIT_AUTHOR_NAME=Claude git commit -m x',
      'git config user.name "Claude"',
      'git commit --no-verify -m x',
      'git commit -nm x',
      'git -c core.hooksPath=/dev/null commit -m x',
    ]) {
      const r: any = await $.tool.call({ tool: 'Bash', tool_use_id: command, command } as any)
      expect(r.deny).toMatch(/no-attribution/)
    }
    expect(seen.length).toBe(0)
    for (const command of ['git log -n 30 --oneline', 'git push -n origin main', 'git config --get core.hooksPath', 'git commit -m "Use the Claude API for summaries"']) {
      await $.tool.call({ tool: 'Bash', tool_use_id: command, command } as any)
    }
    expect(seen.map(e => e.command)).toEqual(['git log -n 30 --oneline', 'git push -n origin main', 'git config --get core.hooksPath', 'git commit -m "Use the Claude API for summaries"'])
  })

  test('file writes, edits and MCP arguments with attribution are refused; clean ones pass unchanged', async ($, on) => {
    const seen = engine(on)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/w' } as any)
    const w: any = await $.tool.call({ tool: 'Write', tool_use_id: 'w', file_path: '/w/a.ts', content: '// Author: Claude\nexport const a = 1\n' } as any)
    expect(w.deny).toMatch(/Author: Claude/)
    const ed: any = await $.tool.call({ tool: 'Edit', tool_use_id: 'e', file_path: '/w/a.ts', old_string: 'x', new_string: 'x\nCo-Authored-By: Claude <noreply@anthropic.com>' } as any)
    expect(ed.deny).toMatch(/no-attribution/)
    const m: any = await $.tool.call({ tool: 'mcp__github__create_pull_request', tool_use_id: 'm', owner: 'o', anything: 'Body\n\n🤖 Generated with Claude Code' } as any)
    expect(m.deny).toMatch(/no-attribution/)
    expect(seen.length).toBe(0)
    // Removing attribution (it is only in old_string) and the mod's own files are fine.
    await $.tool.call({ tool: 'Edit', tool_use_id: 'e2', file_path: '/w/a.ts', old_string: 'Co-Authored-By: Claude', new_string: '' } as any)
    await $.tool.call({ tool: 'Write', tool_use_id: 'own', file_path: '/w/docs/no-attribution.md', content: 'Strips `Co-Authored-By: Claude`.\n' } as any)
    await $.tool.call({ tool: 'Write', tool_use_id: 'ok', file_path: '/w/b.ts', content: 'export const b = 2\n' } as any)
    expect(seen.map(e => e.tool_use_id)).toEqual(['e2', 'own', 'ok'])
    expect(seen[2].content).toBe('export const b = 2\n')
  })

  test('the engine attribution texts are empty and the system prompt carries the rule', async ($, on) => {
    engine(on)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/w' } as any)
    expect((await $.attribution.text({ kind: 'commit', text: 'Co-Authored-By: Claude <noreply@anthropic.com>' } as any)).text).toBe('')
    expect((await $.attribution.text({ kind: 'pr', text: '🤖 Generated with Claude Code' } as any)).text).toBe('')
    const r: any = await $.prompt.compose({ model: 'claude-opus-5-5', promptModel: 'claude-opus-5-5', surfaces: [], tools: [], outputStyle: null, traits: [] } as any)
    expect(r.sections[0].text).not.toMatch(/noreply@anthropic|Co-Authored/i)
    expect(r.sections.at(-1).id).toBe('no-attribution:rule')
  })
})
