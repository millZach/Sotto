import { describe, expect, it } from 'vitest'
import { antigravityToolCallSignal } from '../../../src/main/agents/antigravityActivity'
import { AntigravityBackgroundTasks, antigravityBackgroundCommand, antigravityCommandWords, isAntigravityStdioServerChild, mergeAntigravityBackgroundWork } from '../../../src/main/agents/antigravityBackgroundWork'
import type { ChildProcessRow } from '../../../src/main/agents/detachedRunScan'

const row = (argv: readonly string[], pid = 101): ChildProcessRow => ({ pid, startedAt: 1_700_000_000_000, argv, marks: [] })

describe('antigravityBackgroundWork', () => {
  it('unwraps shell scripts for command labels and returns only program basenames after exec', () => {
    expect(antigravityCommandWords(['bash', '-lc', 'npm run test:unit'])).toBe('npm run test:unit')
    expect(antigravityCommandWords(['pwsh.exe', '-Command', 'pnpm test'])).toBe('pnpm test')
    expect(antigravityCommandWords(['cmd', '/c', 'pytest -q'])).toBe('pytest -q')
    expect(antigravityCommandWords(['/usr/bin/node', '--token', 'secret-value', 'server.js'])).toBe('node')
    expect(antigravityCommandWords(['C:\\Tools\\vitest.exe', '--secret', 'abc'])).toBe('vitest')
  })

  it('ignores local stdio MCP servers attached to the session', () => {
    const servers = [
      { name: 'filesystem', command: '/usr/local/bin/mcp-server-filesystem', args: ['/repo'], env: [] },
      { name: 'db', command: 'npx', args: ['-y', '@mcp/sqlite'], env: [] },
    ]
    expect(isAntigravityStdioServerChild(row(['mcp-server-filesystem', '/repo']), servers)).toBe(true)
    expect(isAntigravityStdioServerChild(row(['bash', '-c', 'npx', '-y', '@mcp/sqlite']), servers)).toBe(true)
    expect(isAntigravityStdioServerChild(row(['mcp-server-filesystem', '/other']), servers)).toBe(false)
    expect(antigravityBackgroundCommand(servers, row(['mcp-server-filesystem', '/repo']))).toBeUndefined()
    expect(antigravityBackgroundCommand(servers, row(['bash', '-c', 'npm test']))).toBe('npm test')
  })

  it('keeps foreground tool calls out of backgroundWork while the turn runs and promotes only outlived/background work', () => {
    const tasks = new AntigravityBackgroundTasks()
    const running = antigravityToolCallSignal({
      sessionUpdate: 'tool_call',
      toolCallId: 'tool-1',
      title: 'Running npm test',
      kind: 'execute',
      status: 'in_progress',
      rawInput: { CommandLine: 'npm test' },
    }, 'k-1')!
    expect(running.isCommand).toBe(true)
    expect(tasks.observe(running, 'turn-1')).toBe(true)
    // While foreground turn is running, in-flight tool is not backgroundWork yet.
    expect(tasks.working(new Set(), false, true)).toEqual([])
    expect(tasks.isToolActive(running.activityId)).toBe(true)

    // Completing normally clears the tracked tool.
    const done = antigravityToolCallSignal({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tool-1',
      status: 'completed',
      rawOutput: { exitCode: 0 },
    }, 'k-1', { title: 'Running npm test', status: 'running', command: 'npm test' })!
    expect(tasks.observe(done, 'turn-1')).toBe(true)
    expect(tasks.working(new Set(), false, false)).toEqual([])
  })

  it('surfaces in-flight tools and explicit background commands/schedules/workflows when a turn closes prematurely', () => {
    const tasks = new AntigravityBackgroundTasks()
    const stillRunning = antigravityToolCallSignal({
      sessionUpdate: 'tool_call',
      toolCallId: 'call-in-flight',
      title: 'Waiting for subagent',
      status: 'in_progress',
    }, 'k-flight')!
    const bgCmd = antigravityToolCallSignal({
      sessionUpdate: 'tool_call',
      toolCallId: 'call-bg-cmd',
      title: 'Running npm run build',
      kind: 'execute',
      status: 'completed',
      rawInput: { CommandLine: 'npm run build', IsBackground: true },
      rawOutput: { status: 'running', commandId: 'cmd-42' },
    }, 'k-bg')!
    const timer = antigravityToolCallSignal({
      sessionUpdate: 'tool_call',
      toolCallId: 'call-timer',
      title: 'Run schedule',
      status: 'completed',
      rawInput: { DurationSeconds: 60, Prompt: 'Check CI status' },
      rawOutput: { status: 'scheduled', taskId: 'sched-7' },
    }, 'k-sched')!
    const syncWorkflow = antigravityToolCallSignal({
      sessionUpdate: 'tool_call',
      toolCallId: 'call-wf-sync',
      title: 'Run run_workflow',
      status: 'completed',
      rawInput: { ScriptPath: '/repo/wf.py' },
      rawOutput: { ok: true },
    }, 'k-wf')!

    expect(tasks.observe(stillRunning, 't1')).toBe(true)
    expect(tasks.observe(bgCmd, 't1')).toBe(true)
    expect(tasks.observe(timer, 't1')).toBe(true)
    expect(tasks.observe(syncWorkflow, 't1')).toBe(false)
    expect(bgCmd.backgroundLaunch).toBe(true)
    expect(timer.backgroundLaunch).toBe(true)
    expect(syncWorkflow.backgroundLaunch).toBe(false)

    // Turn ends prematurely -> stillRunning is promoted to outlived, bgCmd + timer stay active.
    expect(tasks.turnEnded('t1', false, false)).toBe(true)
    const items = tasks.working(new Set(), false, false)
    expect(items.map(item => [item.type, item.label])).toEqual([
      ['command', 'Waiting for subagent'],
      ['command', 'npm run build'],
      ['workflow', 'Run schedule'],
    ])
    for (const item of items) {
      expect(item.id).toMatch(/^[0-9a-f-]{36}$/i)
      // Private prompt text from schedule must never leak into label.
      expect(item.label).not.toContain('Check CI status')
    }

    // Cancelling timer via manage_task removes it cleanly.
    const cancel = antigravityToolCallSignal({
      sessionUpdate: 'tool_call',
      toolCallId: 'call-cancel',
      title: 'Run manage_task',
      status: 'completed',
      rawInput: { Action: 'kill', TaskId: 'sched-7' },
    }, 'k-cancel')!
    expect(tasks.observe(cancel, 't1')).toBe(true)
    expect(tasks.working(new Set(), false, false).map(i => i.label)).toEqual(['Waiting for subagent', 'npm run build'])

    // If OS process monitor observes bgCmd, heuristic command duplicate is suppressed and pruned when process exits.
    expect(tasks.working(new Set(), true, false).map(i => i.label)).toEqual(['Waiting for subagent'])
    expect(tasks.working(new Set(), false, false).map(i => i.label)).toEqual(['Waiting for subagent'])
  })

  it('prunes prior heuristic command tasks when a reactive wakeup turn finishes cleanly', () => {
    const tasks = new AntigravityBackgroundTasks()
    const bgCmd = antigravityToolCallSignal({
      sessionUpdate: 'tool_call',
      toolCallId: 'call-bg-cmd',
      title: 'Run command',
      kind: 'execute',
      status: 'completed',
      rawInput: { CommandLine: 'vitest run' },
      rawOutput: 'Command is still running in the background.',
    }, 'k-bg')!
    expect(tasks.observe(bgCmd, 'turn-1')).toBe(true)
    expect(tasks.working(new Set(), false, false).map(i => i.label)).toEqual(['vitest run'])
    expect(tasks.turnEnded('turn-1:wakeup:1', true, false)).toBe(true)
    expect(tasks.working(new Set(), false, false)).toEqual([])
  })

  it('bounds merged backgroundWork entries to 64 unique IDs', () => {
    const items = Array.from({ length: 70 }, (_, idx) => ({
      id: `00000000-0000-4000-8000-${String(idx).padStart(12, '0')}`,
      label: `Task ${idx}`,
      type: 'command' as const,
    }))
    const merged = mergeAntigravityBackgroundWork([...items, items[0]!])
    expect(merged).toHaveLength(64)
  })

  it('redacts credentials in bash -c scripts and signal command labels', () => {
    const label = antigravityCommandWords(['bash', '-lc', 'API_KEY=topsecret curl -H "Bearer mytok" https://user:pw@example.com'])
    expect(label).not.toContain('topsecret')
    expect(label).not.toContain('mytok')
    expect(label).not.toContain('pw@')
    expect(label).toContain('API_KEY=…')

    const signal = antigravityToolCallSignal({
      sessionUpdate: 'tool_call',
      toolCallId: 'cmd-secret',
      kind: 'execute',
      status: 'in_progress',
      rawInput: { CommandLine: 'bash -c "TOKEN=xyz123 npm test"' },
    }, 'k-secret')!
    expect(signal.label).not.toContain('xyz123')
  })

  it('ignores Windows console helpers and interpreter-wrapped npx stdio MCP servers', () => {
    expect(antigravityBackgroundCommand([], row(['\\??\\C:\\Windows\\system32\\conhost.exe', '0x4']))).toBeUndefined()
    expect(antigravityBackgroundCommand([], row(['openconsole.exe']))).toBeUndefined()

    const servers = [
      { name: 'db', command: 'npx', args: ['-y', '@mcp/sqlite'], env: [] },
      { name: 'py', command: 'uvx', args: ['mcp-server-git'], env: [] },
    ]
    expect(isAntigravityStdioServerChild(row(['node', '/usr/local/bin/npx', '-y', '@mcp/sqlite']), servers)).toBe(true)
    expect(isAntigravityStdioServerChild(row(['node.exe', 'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npx-cli.js', '-y', '@mcp/sqlite']), servers)).toBe(true)
    expect(isAntigravityStdioServerChild(row(['node', '/home/u/.npm/_npx/99/@mcp/sqlite/dist/index.js']), servers)).toBe(true)
    expect(isAntigravityStdioServerChild(row(['python3', '/usr/bin/uvx', 'mcp-server-git']), servers)).toBe(true)
    expect(antigravityBackgroundCommand(servers, row(['node', '/usr/local/bin/npx', '-y', '@mcp/sqlite']))).toBeUndefined()
    expect(antigravityBackgroundCommand(servers, row(['node', 'server.js']))).toBe('node')
  })

  it('never treats non-command file reads as background launches and prunes unbacked heuristic commands on next turn end', () => {
    const tasks = new AntigravityBackgroundTasks()
    const readSchedule = antigravityToolCallSignal({
      sessionUpdate: 'tool_call',
      toolCallId: 'read-1',
      title: 'Read src/schedule.ts',
      kind: 'read',
      status: 'completed',
      rawOutput: { status: 'running', content: 'running in the background' },
    }, 'k-read-1')!
    const readReadme = antigravityToolCallSignal({
      sessionUpdate: 'tool_call',
      toolCallId: 'read-2',
      title: 'Viewed README.md',
      status: 'completed',
      rawOutput: 'The daemon is running in the background by default.',
    }, 'k-read-2')!
    expect(readSchedule.backgroundLaunch).toBe(false)
    expect(readReadme.backgroundLaunch).toBe(false)
    expect(tasks.observe(readSchedule, 't1')).toBe(false)
    expect(tasks.observe(readReadme, 't1')).toBe(false)

    // Unbacked heuristic command is cleared once a later user turn closes with no live process.
    const heuristicCmd = antigravityToolCallSignal({
      sessionUpdate: 'tool_call',
      toolCallId: 'cmd-h1',
      title: 'Running vitest',
      kind: 'execute',
      status: 'completed',
      rawInput: { CommandLine: 'vitest run' },
      rawOutput: 'Command is still running in the background.',
    }, 'k-cmd-h1')!
    expect(tasks.observe(heuristicCmd, 't1')).toBe(true)
    expect(tasks.working(new Set(), [], false)).toHaveLength(1)
    expect(tasks.turnEnded('t2', false, false)).toBe(true)
    expect(tasks.working(new Set(), [], false)).toEqual([])
  })

  it('does not treat error/failed words inside running command_status output as finished', () => {
    const runningStatus = antigravityToolCallSignal({
      sessionUpdate: 'tool_call',
      toolCallId: 'status-1',
      title: 'Run command_status',
      status: 'completed',
      rawInput: { CommandId: 'cmd-42' },
      rawOutput: { status: 'running', combinedOutput: 'AssertionError: test failed (error)' },
    }, 'k-status-1')!
    expect(runningStatus.statusQueryRunning).toBe(true)
    expect(runningStatus.statusQueryFinished).toBe(false)

    const exitedStatus = antigravityToolCallSignal({
      sessionUpdate: 'tool_call',
      toolCallId: 'status-2',
      title: 'Run command_status',
      status: 'completed',
      rawInput: { CommandId: 'cmd-42' },
      rawOutput: { status: 'done', exitCode: 1, combinedOutput: 'failed' },
    }, 'k-status-2')!
    expect(exitedStatus.statusQueryFinished).toBe(true)
  })

  it('keeps unrelated pending schedules and crons alive when an earlier timer finishes its reactive turn', () => {
    let clock = 1_000_000
    const tasks = new AntigravityBackgroundTasks(() => clock)
    const timer1 = antigravityToolCallSignal({
      sessionUpdate: 'tool_call',
      toolCallId: 'sched-call-1',
      title: 'Run schedule',
      status: 'completed',
      rawInput: { DurationSeconds: 10, Prompt: 'Check build' },
      rawOutput: { status: 'scheduled', taskId: 'sched-1' },
    }, 'k-s1')!
    const timer2 = antigravityToolCallSignal({
      sessionUpdate: 'tool_call',
      toolCallId: 'sched-call-2',
      title: 'Run schedule',
      status: 'completed',
      rawInput: { DurationSeconds: 60, Prompt: 'Follow up' },
      rawOutput: { status: 'scheduled', taskId: 'sched-2' },
    }, 'k-s2')!
    const cron = antigravityToolCallSignal({
      sessionUpdate: 'tool_call',
      toolCallId: 'cron-call-1',
      title: 'Run schedule',
      status: 'completed',
      rawInput: { CronExpression: '*/5 * * * *', Prompt: 'Poll' },
      rawOutput: { status: 'scheduled', taskId: 'cron-1' },
    }, 'k-c1')!

    tasks.observe(timer1, 't1')
    tasks.observe(timer2, 't1')
    tasks.observe(cron, 't1')
    expect(tasks.working(new Set(), [], false)).toHaveLength(3)

    // At t+11s timer1 fired and its reactive continuation completed; timer2 (60s) and cron must stay tracked.
    clock += 11_000
    expect(tasks.turnEnded('t1:wakeup:1', true, false)).toBe(true)
    expect(tasks.working(new Set(), [], false)).toHaveLength(2)
  })

  it('keeps tasks tracked while manage_task cancellation is in progress or fails', () => {
    const tasks = new AntigravityBackgroundTasks()
    const timer = antigravityToolCallSignal({
      sessionUpdate: 'tool_call',
      toolCallId: 'call-timer',
      title: 'Run schedule',
      status: 'completed',
      rawInput: { DurationSeconds: 60, Prompt: 'Check CI' },
      rawOutput: { status: 'scheduled', taskId: 'sched-7' },
    }, 'k-s')!
    tasks.observe(timer, 't1')

    const killing = antigravityToolCallSignal({
      sessionUpdate: 'tool_call',
      toolCallId: 'call-kill',
      title: 'Run manage_task',
      status: 'in_progress',
      rawInput: { Action: 'kill', TaskId: 'sched-7' },
    }, 'k-kill')!
    tasks.observe(killing, 't1')
    expect(tasks.working(new Set(), [], false)).toHaveLength(1)

    const failedKill = antigravityToolCallSignal({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call-kill',
      title: 'Run manage_task',
      status: 'failed',
      rawInput: { Action: 'kill', TaskId: 'sched-7' },
    }, 'k-kill')!
    tasks.observe(failedKill, 't1')
    expect(tasks.working(new Set(), [], false)).toHaveLength(1)

    const succeededKill = antigravityToolCallSignal({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call-kill-2',
      title: 'Run manage_task',
      status: 'completed',
      rawInput: { Action: 'kill', TaskId: 'sched-7' },
      rawOutput: { status: 'cancelled' },
    }, 'k-kill-2')!
    tasks.observe(succeededKill, 't1')
    expect(tasks.working(new Set(), [], false)).toEqual([])
  })

  it('dedupes non-heuristic in-flight commands against matching live OS processes and skips pending permission prompts', () => {
    const tasks = new AntigravityBackgroundTasks()
    const pendingPerm = antigravityToolCallSignal({
      sessionUpdate: 'tool_call',
      toolCallId: 'perm-1',
      title: '`git status`',
      kind: 'execute',
      status: 'pending',
      rawInput: { CommandLine: 'git status' },
    }, 'k-perm')!
    expect(tasks.observe(pendingPerm, 't1')).toBe(false)

    const devCmd = antigravityToolCallSignal({
      sessionUpdate: 'tool_call',
      toolCallId: 'dev-1',
      title: 'Running npm run dev',
      kind: 'execute',
      status: 'in_progress',
      rawInput: { CommandLine: 'npm run dev' },
    }, 'k-dev')!
    tasks.observe(devCmd, 't1')
    tasks.turnEnded('t1', false, true)

    // OS monitor already lists `npm run dev`, so tracked copy is suppressed (not double-counted) while keeping row active.
    expect(tasks.working(new Set(), [{ id: 'os-1', label: 'npm run dev', type: 'command' }], false)).toEqual([])
    expect(tasks.isToolActive('antigravity-tool-k-dev')).toBe(true)

    // Once OS process exits, the sawProcess command task clears.
    expect(tasks.working(new Set(), [], false)).toEqual([])
  })
})
