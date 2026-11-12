// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { agentClient, descendsFrom, marksIn, parseLinuxStat, parseMacTable, parseStarted, parseWindowsTable, runWords, shownCommand, splitCommandLine, type ListedProcess } from '../../../src/main/agents/detachedRunScan'

describe('which processes are agent clients', () => {
  it('knows a client by its command, on any system, and under a runtime by its script or package', () => {
    expect(agentClient(['claude', '-p', 'Read and do director.md'])).toBe('Claude Code')
    expect(agentClient(['/home/zach/.local/share/mise/installs/claude/2.1.322/claude', '-p'])).toBe('Claude Code')
    expect(agentClient(['C:\\Users\\zache\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\vendor\\codex.exe', 'exec', 'Fix it'])).toBe('Codex')
    expect(agentClient(['node', '/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js', '-p'])).toBe('Claude Code')
    expect(agentClient(['node.exe', '--no-warnings', 'C:\\npm\\codex.js', 'exec'])).toBe('Codex')
    expect(agentClient(['/usr/bin/grok', 'run'])).toBe('Grok Build')
  })

  it('leaves out everything else, a preview server a thread left running included', () => {
    expect(agentClient(['python3', '/home/zach/.claude/skills/checkpoint/scripts/serve.py', '8174'])).toBeUndefined()
    expect(agentClient(['bash', '-c', 'claude -p hi'])).toBeUndefined()
    expect(agentClient(['node'])).toBeUndefined()
    expect(agentClient([])).toBeUndefined()
  })
})

describe('what a row says about a run', () => {
  const argv = ['claude', '-p', '--session-id', 'fbb9b8df-81c0-44d6-8944-eada812138d5', '--name', 'tetherfall-art-director', '--model', 'claude-fable-5-2',
    '--effort', 'high', '--permission-mode', 'bypassPermissions', 'Read and do .zstack/studio/art-push/director.md']

  it('reads the name, model and effort its command gives', () => {
    expect(runWords({ client: 'Claude Code', argv })).toEqual({ name: 'tetherfall-art-director', model: 'claude-fable-5-2', effort: 'high' })
    expect(runWords({ client: 'Codex', argv: ['codex', 'exec', '-m', 'gpt-6.1-sol', '-c', 'model_reasoning_effort="xhigh"', 'Fix it'] })).toEqual({ model: 'gpt-6.1-sol', effort: 'xhigh' })
    expect(runWords({ client: 'Codex', argv: ['codex', 'exec', '--model=gpt-6.1', 'Fix it'] })).toEqual({ model: 'gpt-6.1' })
    expect(runWords({ client: 'Claude Code', argv: ['claude', '-p', 'hi'] })).toEqual({})
  })

  it('shows the command with its spaced arguments quoted', () => {
    expect(shownCommand(argv)).toBe('claude -p --session-id fbb9b8df-81c0-44d6-8944-eada812138d5 --name tetherfall-art-director --model claude-fable-5-2 --effort high --permission-mode bypassPermissions "Read and do .zstack/studio/art-push/director.md"')
  })

  it('leaves out the value after any flag that names a key, a token, a secret or a password', () => {
    expect(shownCommand(['codex', 'exec', '--api-key', 'sk-live-123', '--token=abc', '--client-secret', 's3', 'go'])).toBe('codex exec --api-key … --token=… --client-secret … go')
  })

  it('leaves out a credential in an override, a header, a bearer token or inline JSON', () => {
    const shown = shownCommand(['codex', 'exec', '-c', 'model_providers.az.query_params.api-key=SECRET1', '-c', 'model_reasoning_effort=high',
      '--header', 'X-Custom: SECRET2', 'Authorization: Bearer SECRET3', '--mcp-config', '{"mcpServers":{"a":{"env":{"GITHUB_TOKEN":"SECRET5"}}}}', 'hi'])
    expect(shown).not.toMatch(/SECRET/u)
    expect(shown).toBe('codex exec -c model_providers.az.query_params.api-key=… -c model_reasoning_effort=high --header … "Authorization: Bearer …" --mcp-config … hi')
    expect(shownCommand(['claude', '-p', '{"env":{"KEY":"SECRET6"}}'])).toBe('claude -p {…}')
  })

  it('cuts a very long command and strips control characters', () => {
    const shown = shownCommand(['claude', '-p', 'x'.repeat(5_000)])
    expect(shown.length).toBe(2_000)
    expect(shown.endsWith('…')).toBe(true)
    expect(shownCommand(['claude', 'a\u0007b'])).toBe('claude a b')
  })
})

describe('reading what the system lists', () => {
  it('splits a command line the way a shell quotes it', () => {
    expect(splitCommandLine('"C:\\Program Files\\claude.exe" -p "Read and do \\"this\\"" --name run')).toEqual(['C:\\Program Files\\claude.exe', '-p', 'Read and do "this"', '--name', 'run'])
    expect(splitCommandLine('  claude   -p  ""  ')).toEqual(['claude', '-p', ''])
  })

  it('takes only the named marks out of an environment, the names compared as the system compares them', () => {
    const entries = ['PATH=/usr/bin', 'CLAUDE_CODE_SESSION_ID=0d15c982-fe12-44e4-8834-23b3be4bd2eb', 'ANTHROPIC_API_KEY=sk-ant-secret', 'codex_thread_id=01a1cd5b']
    expect(marksIn(entries, false)).toEqual([{ name: 'CLAUDE_CODE_SESSION_ID', value: '0d15c982-fe12-44e4-8834-23b3be4bd2eb' }])
    expect(marksIn(entries, true)).toEqual([{ name: 'CLAUDE_CODE_SESSION_ID', value: '0d15c982-fe12-44e4-8834-23b3be4bd2eb' }, { name: 'CODEX_THREAD_ID', value: '01a1cd5b' }])
    expect(JSON.stringify(marksIn(entries, true))).not.toContain('sk-ant')
  })

  it('reads a Linux stat line whose name holds spaces and parentheses', () => {
    const stat = '961128 (claude (art) x) S 1 961128 961128 0 -1 4194560 1 0 0 0 10 2 0 0 20 0 18 0 3412345 1 2 3'
    expect(parseLinuxStat(stat)).toEqual({ parentPid: 1, startTicks: 3412345 })
    expect(parseLinuxStat('garbage')).toBeUndefined()
  })

  it('reads the start ps records on macOS, the same at every read, and its table rows', () => {
    const started = new Date(2026, 10, 11, 17, 4, 5).getTime()
    expect(parseStarted(['Wed', 'Nov', '11', '17:04:05', '2026'])).toBe(started)
    expect(parseStarted(['Wed', 'Novembre', '11', '17:04:05', '2026'])).toBeUndefined()
    expect(parseStarted(['Wed', 'Nov', '11', 'soon', '2026'])).toBeUndefined()
    expect(parseMacTable('  961128     1 Wed Nov 11 17:04:05 2026     claude -p --name run "Read it"\n bad line\n')).toEqual([
      { pid: 961128, parentPid: 1, startedAt: started, commandLine: 'claude -p --name run "Read it"' },
    ])
    // Read again later, the same process has the same start, so its run keeps its ID and Stop finds it.
    expect(parseMacTable('961128 1 Wed Nov 11 17:04:05 2026 claude -p')[0]!.startedAt).toBe(started)
  })

  it('reads the Windows table, a process without a command line kept for its parents', () => {
    const line = Buffer.from('claude.exe -p hi').toString('base64')
    expect(parseWindowsTable(`4\t0\t\t\r\n600\t4\t2026-11-12T00:54:46.0200000Z\t${line}\r\nnoise\r\n`)).toEqual([
      { pid: 4, parentPid: 0, startedAt: undefined, commandLine: '' },
      { pid: 600, parentPid: 4, startedAt: Date.parse('2026-11-12T00:54:46.020Z'), commandLine: 'claude.exe -p hi' },
    ])
  })
})

describe('which runs are under Sotto', () => {
  const table = (rows: readonly ListedProcess[]): Map<number, ListedProcess> => new Map(rows.map(row => [row.pid, row]))

  it('finds a provider and its children under Sotto, and a run cut loose from it outside', () => {
    const processes = table([
      { pid: 1, parentPid: undefined, startedAt: 0 },
      { pid: 100, parentPid: 1, startedAt: 10 }, // Sotto
      { pid: 200, parentPid: 100, startedAt: 20 }, // the thread's Claude Code
      { pid: 300, parentPid: 200, startedAt: 30 }, // a command it runs
      { pid: 400, parentPid: 1, startedAt: 40 }, // the run that command detached
    ])
    expect(descendsFrom(processes, 300, 100)).toBe(true)
    expect(descendsFrom(processes, 400, 100)).toBe(false)
    expect(descendsFrom(processes, 100, 100)).toBe(true)
  })

  it('stops at a parent that started after its child: a process that took a dead parent\'s number', () => {
    const processes = table([
      { pid: 100, parentPid: 1, startedAt: 10 }, // Sotto
      { pid: 500, parentPid: 100, startedAt: 90_000 }, // something new that took the number of the run's dead shell
      { pid: 400, parentPid: 500, startedAt: 40 }, // the run, its recorded parent long gone, as Windows keeps it
    ])
    expect(descendsFrom(processes, 400, 100)).toBe(false)
  })

  it('stops at a parent the table does not list, and on a loop', () => {
    expect(descendsFrom(table([{ pid: 400, parentPid: 77, startedAt: 40 }]), 400, 100)).toBe(false)
    expect(descendsFrom(table([{ pid: 400, parentPid: 401, startedAt: 40 }, { pid: 401, parentPid: 400, startedAt: 30 }]), 400, 100)).toBe(false)
  })
})
