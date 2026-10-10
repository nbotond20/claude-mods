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
  test('cuts attribution out of a commit, keeps the rest', async ($, on) => {
    const seen = engine(on)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/w' } as any)
    await $.tool.call({ tool: 'Bash', tool_use_id: '1', command: COMMIT } as any)
    const cmd: string = seen[0].command
    expect(cmd).not.toMatch(/claude|anthropic|🤖/i)
    expect(cmd).toContain('Fix the parser\n\nHandles empty input.')
    expect(cmd).toContain(`git commit -m "$(cat <<'EOF'`)
  })

  test('inline -m trailers and gh pr bodies are cleaned', async ($, on) => {
    const seen = engine(on)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/w' } as any)
    await $.tool.call({ tool: 'Bash', tool_use_id: '1', command: 'git commit -m "Fix" -m "Co-authored-by: Claude <noreply@anthropic.com>"' } as any)
    expect(seen[0].command).toBe('git commit -m "Fix" -m ""')
    await $.tool.call({ tool: 'Bash', tool_use_id: '2', command: 'gh pr create --title "Fix" --body "Summary\n\nGenerated with Claude Code"' } as any)
    expect(seen[1].command).toBe('gh pr create --title "Fix" --body "Summary\n\n"')
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

  test('file writes, edits and MCP arguments are cleaned; Edit old_string untouched', async ($, on) => {
    const seen = engine(on)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/w' } as any)
    await $.tool.call({ tool: 'Write', tool_use_id: 'w', file_path: '/w/a.ts', content: '// Author: Claude\n// Written by Claude Code\nexport const a = 1\n' } as any)
    expect(seen[0].content).toBe('export const a = 1\n')
    await $.tool.call({ tool: 'Edit', tool_use_id: 'e', file_path: '/w/a.ts', old_string: 'Co-Authored-By: Claude', new_string: 'x\nCo-Authored-By: Claude <noreply@anthropic.com>\ny' } as any)
    expect(seen[1]).toMatchObject({ old_string: 'Co-Authored-By: Claude', new_string: 'x\ny' })
    await $.tool.call({ tool: 'mcp__github__create_pull_request', tool_use_id: 'm', owner: 'o', anything: 'Body\n\n🤖 Generated with Claude Code' } as any)
    expect(seen[2].anything).toBe('Body\n\n')
    expect(seen[2].owner).toBe('o')
    await $.tool.call({ tool: 'Write', tool_use_id: 'own', file_path: '/w/docs/no-attribution.md', content: 'Strips `Co-Authored-By: Claude`.\n' } as any)
    expect(seen[3].content).toBe('Strips `Co-Authored-By: Claude`.\n')
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
