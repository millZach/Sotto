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
})
