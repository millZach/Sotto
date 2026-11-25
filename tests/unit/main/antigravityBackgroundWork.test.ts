import { describe, expect, it } from 'vitest'
import { antigravityToolCallSignal, parseAntigravitySystemWakeup } from '../../../src/main/agents/antigravityActivity'
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
      // A schedule timer is waited on, not worked: never an agent.
      ['command', 'Run schedule'],
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

  describe('schedule timers', () => {
    const scheduleCall = (i: number, input: Record<string, unknown>, status: 'completed' | 'in_progress' = 'completed', extra: Record<string, unknown> = {}) => antigravityToolCallSignal({
      sessionUpdate: 'tool_call',
      toolCallId: `sched-call-${i}`,
      title: 'Run schedule',
      status,
      rawInput: input,
      rawOutput: { status: 'scheduled', taskId: `conv-1/sched-${i}` },
      ...extra,
    }, `k-sched-${i}`)!

    it('reports a timer as waited-on work rather than an agent, with no process behind it', () => {
      const once = scheduleCall(1, { DurationSeconds: 120, Prompt: 'Check CI' })
      const cron = scheduleCall(2, { CronExpression: '*/5 * * * *', Prompt: 'Poll' })
      for (const signal of [once, cron]) {
        expect(signal.isTimer).toBe(true)
        expect(signal.type).toBe('command')
        expect(signal.isCommand).toBe(false)
        expect(signal.backgroundLaunch).toBe(true)
      }
      const tasks = new AntigravityBackgroundTasks()
      tasks.observe(once, 't1')
      tasks.observe(cron, 't1')
      tasks.turnEnded('t1', false, false)
      expect(tasks.working(new Set(), [], false).map(item => item.type)).toEqual(['command', 'command'])
      // No live OS process ever matches a timer, so it is not pruned as an exited command.
      expect(tasks.working(new Set(), [], false)).toHaveLength(2)
    })

    it('does not pile up one-shot timers a single long turn sets one after another as each fires', () => {
      let clock = 1_000_000
      const tasks = new AntigravityBackgroundTasks(() => clock)
      for (let i = 0; i < 18; i++) {
        tasks.observe(scheduleCall(i, { DurationSeconds: 180, Prompt: `Check release ${i}` }), 't1')
        // Held by the running turn, so nothing shows while it runs.
        expect(tasks.working(new Set(), [], true)).toEqual([])
        clock += 181_000
        // The timer wakes the running turn with its own prompt: no task id, so its time being up settles it.
        expect(parseAntigravitySystemWakeup('<SYSTEM_MESSAGE>\nCheck release\n</SYSTEM_MESSAGE>').completedTaskIds).toEqual([])
        expect(tasks.settleFiredTimers()).toBe(true)
        expect(tasks.hasAny).toBe(false)
      }
      tasks.observe(scheduleCall(99, { DurationSeconds: 180, Prompt: 'Last check' }), 't1')
      expect(tasks.turnEnded('t1', false, false)).toBe(true)
      expect(tasks.working(new Set(), [], false).map(item => [item.type, item.label])).toEqual([['command', 'Run schedule']])
    })

    it('drops a timer well past its time when the turn sets the next one or ends, even without a recognised wakeup', () => {
      let clock = 1_000_000
      const tasks = new AntigravityBackgroundTasks(() => clock)
      tasks.observe(scheduleCall(1, { DurationSeconds: 60 }), 't1')
      clock += 91_000
      tasks.observe(scheduleCall(2, { DurationSeconds: 60 }), 't1')
      clock += 91_000
      tasks.observe(scheduleCall(3, { DurationSeconds: 600 }), 't1')
      clock += 1_000
      tasks.turnEnded('t1', false, false)
      expect(tasks.working(new Set(), [], false)).toHaveLength(1)

      // A turn that ends well after its only timer's time leaves nothing behind.
      const lone = new AntigravityBackgroundTasks(() => clock)
      lone.observe(scheduleCall(4, { DurationSeconds: 30 }), 't2')
      clock += 61_000
      expect(lone.turnEnded('t2', false, false)).toBe(true)
      expect(lone.working(new Set(), [], false)).toEqual([])
    })

    it('keeps a timer just due at turn end for the wakeup turn it starts, so the thread never looks settled before it', () => {
      let clock = 1_000_000
      const tasks = new AntigravityBackgroundTasks(() => clock)
      tasks.observe(scheduleCall(1, { DurationSeconds: 30 }), 't1')
      clock += 31_000
      tasks.turnEnded('t1', false, false)
      expect(tasks.working(new Set(), [], false)).toHaveLength(1)
      expect(tasks.turnEnded('t1:wakeup:1', true, false)).toBe(true)
      expect(tasks.working(new Set(), [], false)).toEqual([])
    })

    it('settles a wakeup that lands a moment before Sotto reckons the timer due, but not one far from due', () => {
      let clock = 1_000_000
      const tasks = new AntigravityBackgroundTasks(() => clock)
      tasks.observe(scheduleCall(1, { DurationSeconds: 60 }), 't1')
      clock += 30_000
      expect(tasks.settleFiredTimers()).toBe(false)
      clock += 28_000
      expect(tasks.settleFiredTimers()).toBe(false)
      clock += 1_500
      expect(tasks.settleFiredTimers()).toBe(true)
    })

    it('settles a timer that outlived its turn when it wakes a later turn the user started', () => {
      let clock = 1_000_000
      const tasks = new AntigravityBackgroundTasks(() => clock)
      tasks.observe(scheduleCall(1, { DurationSeconds: 60 }), 't1')
      tasks.turnEnded('t1', false, false)
      clock += 61_000
      // The user's own turn t2 is running when the timer fires into it.
      expect(tasks.settleFiredTimers()).toBe(true)
      expect(tasks.hasAny).toBe(false)

      // Unrecognised, it still goes when a later turn ends well past its time.
      const quiet = new AntigravityBackgroundTasks(() => clock)
      quiet.observe(scheduleCall(2, { DurationSeconds: 60 }), 't1')
      quiet.turnEnded('t1', false, false)
      clock += 91_000
      expect(quiet.turnEnded('t2', false, false)).toBe(true)
      expect(quiet.hasAny).toBe(false)
    })

    it('ends a timer that fired a moment early with the wakeup turn it started', () => {
      let clock = 1_000_000
      const tasks = new AntigravityBackgroundTasks(() => clock)
      tasks.observe(scheduleCall(1, { DurationSeconds: 60 }), 't1')
      tasks.turnEnded('t1', false, false)
      clock += 59_500
      expect(tasks.turnEnded('t1:wakeup:1', true, false)).toBe(true)
      expect(tasks.hasAny).toBe(false)
    })

    it('keeps the length a pending schedule call asked for when the update that runs it carries no input', () => {
      let clock = 1_000_000
      const tasks = new AntigravityBackgroundTasks(() => clock)
      const pending = scheduleCall(1, { DurationSeconds: 60 }, 'in_progress', { status: 'pending' })
      expect(pending.pending).toBe(true)
      expect(tasks.observe(pending, 't1')).toBe(false)
      const done = antigravityToolCallSignal({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'sched-call-1',
        status: 'completed',
        rawOutput: { status: 'scheduled', taskId: 'conv-1/sched-1' },
      }, 'k-sched-1', { title: 'Run schedule', status: 'running' })!
      expect(done.durationSeconds).toBeUndefined()
      tasks.observe(done, 't1')
      clock += 61_000
      expect(tasks.settleFiredTimers()).toBe(true)
      expect(tasks.hasAny).toBe(false)
    })

    it('keeps a timer that outlived its turn until the wakeup turn it starts ends', () => {
      let clock = 1_000_000
      const tasks = new AntigravityBackgroundTasks(() => clock)
      tasks.observe(scheduleCall(1, { DurationSeconds: 60 }), 't1')
      tasks.turnEnded('t1', false, false)
      expect(tasks.working(new Set(), [], false)).toHaveLength(1)
      clock += 61_000
      // The wakeup arrives with no turn running, so the adapter settles nothing on it (`settleFiredTimers` is for a running
      // turn): the reactive turn it opens holds the thread from here.
      expect(tasks.working(new Set(), [], false)).toHaveLength(1)
      expect(tasks.turnEnded('t1:wakeup:1', true, false)).toBe(true)
      expect(tasks.working(new Set(), [], false)).toEqual([])
    })

    it('keeps the timer and its end when a later update omits DurationSeconds', () => {
      let clock = 1_000_000
      const tasks = new AntigravityBackgroundTasks(() => clock)
      tasks.observe(scheduleCall(1, { DurationSeconds: 60 }, 'in_progress'), 't1')
      clock += 10_000
      const done = antigravityToolCallSignal({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'sched-call-1',
        status: 'completed',
        rawOutput: { status: 'scheduled', taskId: 'conv-1/sched-1' },
      }, 'k-sched-1', { title: 'Run schedule', status: 'running' })!
      expect(done.durationSeconds).toBeUndefined()
      tasks.observe(done, 't1')
      tasks.turnEnded('t1', false, false)
      expect(tasks.working(new Set(), [], false).map(item => item.type)).toEqual(['command'])
      clock += 51_000
      expect(tasks.turnEnded('t1:wakeup:1', true, false)).toBe(true)
      expect(tasks.working(new Set(), [], false)).toEqual([])
    })
  })

  describe('agents beside timers', () => {
    it('still reports a background run_workflow as a workflow and leaves invoke_subagent to the child watch', () => {
      const tasks = new AntigravityBackgroundTasks()
      const workflow = antigravityToolCallSignal({
        sessionUpdate: 'tool_call',
        toolCallId: 'wf-1',
        title: 'Run run_workflow',
        status: 'completed',
        rawInput: { ScriptPath: '/repo/release.py', IsBackground: true },
        rawOutput: { status: 'running', workflowId: 'wf-native-1' },
      }, 'k-wf-1')!
      expect(workflow.isTimer).toBe(false)
      expect(workflow.type).toBe('workflow')
      expect(workflow.backgroundLaunch).toBe(true)
      const subagent = antigravityToolCallSignal({
        sessionUpdate: 'tool_call',
        toolCallId: 'sub-1',
        title: 'Run invoke_subagent',
        kind: 'other',
        status: 'in_progress',
        rawInput: { Role: 'Reviewer', Prompt: 'Review the diff' },
      }, 'k-sub-1')!
      expect(subagent.isTimer).toBe(false)
      expect(subagent.type).toBe('subagent')
      tasks.observe(workflow, 't1')
      tasks.observe(subagent, 't1')
      tasks.observe(antigravityToolCallSignal({ sessionUpdate: 'tool_call', toolCallId: 'sched-1', title: 'Run schedule', status: 'completed', rawInput: { DurationSeconds: 300 } }, 'k-s')!, 't1')
      tasks.turnEnded('t1', false, false)
      // The subagent's launch shows while it runs and the child watch takes over once it ends; only real agents are agents.
      expect(tasks.working(new Set(['sub-1']), [], false).map(item => item.type)).toEqual(['workflow', 'command'])
      expect(tasks.working(new Set(), [], false).map(item => item.type).sort()).toEqual(['command', 'subagent', 'workflow'])
    })
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

  it('recognizes real agy background-task output containing finished words in Log output and extracts nativeTaskId', () => {
    const tasks = new AntigravityBackgroundTasks()
    const launched = antigravityToolCallSignal({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'cmd-agy-1',
      title: 'Running python train_colab.py',
      kind: 'execute',
      status: 'completed',
      rawInput: { CommandLine: 'python train_colab.py', WaitMsBeforeAsync: 5000 },
      content: [{
        type: 'content',
        content: {
          type: 'text',
          text: 'Tool is running as a background task with task id: conv-9/task-42\nTask logs are available at: /tmp/task.log\nLog output:\nSetup done\n0 failed\nWaiting on Colab GPU...',
        },
      }],
    }, 'k-agy-1')!
    expect(launched.backgroundLaunch).toBe(true)
    expect(launched.nativeTaskId).toBe('conv-9/task-42')
    expect(tasks.observe(launched, 't1')).toBe(true)
    expect(tasks.working(new Set(), [], false).map(item => item.label)).toEqual(['python train_colab.py'])

    const stillRunning = antigravityToolCallSignal({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'cmd-agy-check',
      title: 'Running command_status',
      status: 'completed',
      rawInput: { Action: 'status', TaskId: 'conv-9/task-42' },
      content: [{
        type: 'content',
        content: {
          type: 'text',
          text: 'Background command is still running after 300s: step 1 done',
        },
      }],
    }, 'k-agy-check')!
    expect(stillRunning.isControlTool).toBe(true)
    expect(stillRunning.statusQueryRunning).toBe(true)
    expect(stillRunning.statusQueryFinished).toBe(false)

    // Matching nativeTaskId extracted from text lets manage_task kill clear it later.
    const killed = antigravityToolCallSignal({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'cmd-agy-kill',
      title: 'Running manage_task',
      status: 'completed',
      rawInput: { Action: 'kill', TaskId: 'conv-9/task-42' },
      content: [{ type: 'content', content: { type: 'text', text: 'Task cancelled.' } }],
    }, 'k-agy-kill')!
    expect(tasks.observe(killed, 't2')).toBe(true)
    expect(tasks.working(new Set(), [], false)).toEqual([])
  })

  it('ignores background phrases and task ids appearing inside Log output rather than the header', () => {
    const completed = antigravityToolCallSignal({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'cmd-log-only',
      title: 'Running cat test-fixture.log',
      kind: 'execute',
      status: 'completed',
      rawInput: { CommandLine: 'cat test-fixture.log' },
      content: [{
        type: 'content',
        content: {
          type: 'text',
          text: 'Command exited cleanly.\nLog output:\nTool is running as a background task with task id: conv-9/fake-99\nBackground command is still running after 300s',
        },
      }],
    }, 'k-log-only')!
    expect(completed.backgroundLaunch).toBe(false)
    expect(completed.nativeTaskId).toBeUndefined()
  })

  it('parses complete SYSTEM_MESSAGE wakeup envelopes, ignores pasted fragments, and settles by nativeTaskId', () => {
    expect(parseAntigravitySystemWakeup('<SYSTEM_MESSAGE> pasted text without closing tag')).toEqual({ isWakeup: false, completedTaskIds: [] })
    expect(parseAntigravitySystemWakeup('[Message] timestamp=2026-11-23T00:00:00Z sender=foo content=Task id "t" finished')).toEqual({ isWakeup: false, completedTaskIds: [] })
    expect(parseAntigravitySystemWakeup('<SYSTEM_MESSAGE>foo</SYSTEM_MESSAGE>\nWhy did this happen?')).toEqual({ isWakeup: false, completedTaskIds: [] })

    expect(parseAntigravitySystemWakeup(
      'The following is a <SYSTEM_MESSAGE> not actually sent by the user. It is provided by the system.\n\n<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-23T05:00:00Z sender=conv-1/task-7 priority=HIGH content=Task id "conv-1/task-7" finished with result:\nCommand output:\nTask id "conv-1/fake-1" finished\n</SYSTEM_MESSAGE>',
    )).toEqual({ isWakeup: true, completedTaskIds: ['conv-1/task-7'] })

    const tasks = new AntigravityBackgroundTasks()
    tasks.observe(antigravityToolCallSignal({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'cmd-settle-1',
      title: 'Running python a.py',
      kind: 'execute',
      status: 'completed',
      rawInput: { CommandLine: 'python a.py' },
      content: [{ type: 'content', content: { type: 'text', text: 'Tool is running as a background task with task id: conv-1/task-7' } }],
    }, 'k-settle-1')!, 't1')
    tasks.observe(antigravityToolCallSignal({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'cmd-settle-2',
      title: 'Running python b.py',
      kind: 'execute',
      status: 'completed',
      rawInput: { CommandLine: 'python b.py' },
      content: [{ type: 'content', content: { type: 'text', text: 'Tool is running as a background task with task id: conv-1/other-task-7' } }],
    }, 'k-settle-2')!, 't1')

    expect(tasks.settleNativeTask('task-7')).toBe(true)
    expect(tasks.working(new Set(), [], false).map(item => item.label)).toEqual(['python b.py'])
  })
})
