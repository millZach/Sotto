import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AntigravityAcpHost } from '../../src/main/agents/antigravity'
import type { ChildProcessRow } from '../../src/main/agents/detachedRunScan'
import { questionInstructions } from '../../src/main/agents/questionInstructions'
import { agentBackgroundWorkSchema } from '../../src/shared/agentMonitoring'

const FAKE_AGENT_SOURCE = `
import { readFileSync, appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const [,, statePath, configPath] = process.argv
const config = JSON.parse(readFileSync(configPath, 'utf8'))
if (process.argv.includes('--version')) {
  process.stdout.write('1.5.14\\n')
  process.exit(0)
}
const write = obj => process.stdout.write(JSON.stringify(obj) + '\\n')
const log = entry => appendFileSync(statePath, JSON.stringify(entry) + '\\n')

let nextSession = 1
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
rl.on('line', line => {
  if (!line.trim()) return
  const msg = JSON.parse(line)
  if (msg.method) log({ method: msg.method, params: msg.params })
  if (msg.method === 'initialize') {
    write({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion: 1,
        agentInfo: { name: 'agy', version: '1.5.14' },
        agentCapabilities: {
          mcpCapabilities: { http: true },
          sessionCapabilities: { resume: {} },
          _meta: { antigravity: { systemPrompt: { append: !config.noAppend } } },
        },
      },
    })
    return
  }
  if (msg.method === 'authenticate' || msg.method === 'session/set_config_option' || msg.method === 'session/set_mode' || msg.method === 'session/close') {
    write({ jsonrpc: '2.0', id: msg.id, result: {} })
    return
  }
  if (msg.method === 'session/new' || msg.method === 'session/resume') {
    const sessionId = msg.params?.sessionId ?? ('sess-' + (nextSession++))
    write({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        sessionId,
        configOptions: [
          { id: 'model', category: 'model', currentValue: 'gemini-3.1-pro', options: [{ value: 'gemini-3.1-pro', name: 'Gemini 3.1 Pro' }] },
        ],
        modes: { currentModeId: 'default', availableModes: [{ id: 'default', name: 'Ask' }] },
      },
    })
    return
  }
  if (msg.method === 'session/prompt') {
    const sessionId = msg.params.sessionId
    const promptText = msg.params.prompt?.[0]?.text ?? ''
    if (promptText.includes('premature-bg-command')) {
      write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'cmd-1',
        title: 'Running npm test',
        kind: 'execute',
        status: 'in_progress',
        rawInput: { CommandLine: 'npm test', IsBackground: true },
      } } })
      write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Waiting for background tests to finish.' },
      } } })
      write({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } })
      setTimeout(() => {
        write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'cmd-1',
          status: 'completed',
          rawOutput: { exitCode: 0, combinedOutput: 'all green' },
        } } })
        setTimeout(() => {
          write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: {
            sessionUpdate: 'agent_thought_chunk',
            content: { type: 'text', text: 'Tests passed; pushing branch.' },
          } } })
          write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'push-1',
            title: 'git push',
            kind: 'execute',
            status: 'completed',
            rawInput: { CommandLine: 'git push origin fix/demo' },
            rawOutput: { exitCode: 0 },
          } } })
          write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'Tests passed and pushed PR.' },
          } } })
        }, 40)
      }, 60)
      return
    }
    if (promptText.includes('reactive-question')) {
      write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Working on options first.' },
      } } })
      write({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } })
      setTimeout(() => {
        write({
          jsonrpc: '2.0',
          id: 'elicitation-reactive-1',
          method: 'elicitation/create',
          params: {
            sessionId,
            mode: 'form',
            message: 'Pick one to continue.',
            requestedSchema: {
              type: 'object',
              properties: {
                q0: {
                  type: 'string',
                  title: 'Which option should I apply?',
                  oneOf: [
                    { const: 'a', title: 'Option A' },
                    { const: 'b', title: 'Option B' },
                  ],
                },
              },
              required: ['q0'],
            },
          },
        })
      }, 30)
      return
    }
    if (promptText.includes('post-turn-outlived-progress')) {
      write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'cmd-outlived',
        title: 'Running npm run dev',
        kind: 'execute',
        status: 'in_progress',
        rawInput: { CommandLine: 'npm run dev' },
      } } })
      write({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } })
      setTimeout(() => {
        write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'cmd-outlived',
          status: 'in_progress',
          rawOutput: { combinedOutput: 'ready on port 3000' },
        } } })
      }, 30)
      return
    }
    if (promptText.includes('delayed-thought-then-old-tool-done')) {
      write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'cmd-row-1',
        title: 'Running vitest',
        kind: 'execute',
        status: 'in_progress',
        rawInput: { CommandLine: 'vitest run' },
      } } })
      write({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } })
      setTimeout(() => {
        write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: {
          sessionUpdate: 'agent_thought_chunk',
          content: { type: 'text', text: 'Checking command result.' },
        } } })
        setTimeout(() => {
          write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'cmd-row-1',
            status: 'completed',
            rawOutput: { exitCode: 0, combinedOutput: 'passed' },
          } } })
          write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'All green.' },
          } } })
        }, 30)
      }, 30)
      return
    }
    if (promptText.includes('streaming-during-look')) {
      write({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } })
      setTimeout(() => {
        write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'cmd-wake-1',
          title: 'echo check',
          kind: 'execute',
          status: 'completed',
          rawInput: { CommandLine: 'echo check' },
          rawOutput: { exitCode: 0 },
        } } })
        write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'Part 1 ' },
        } } })
        // With settleMs=80ms and childRows=120ms, settle enters lookBeforeEnd at ~80ms..200ms; Part 2 at 110ms lands mid-scan.
        setTimeout(() => {
          write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'Part 2' },
          } } })
        }, 110)
      }, 40)
      return
    }
    if (promptText.includes('slow-pause-after-tool')) {
      write({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } })
      setTimeout(() => {
        write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'r-tool-1',
          title: 'Checking files',
          kind: 'read',
          status: 'in_progress',
        } } })
        setTimeout(() => {
          write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'r-tool-1',
            status: 'completed',
          } } })
          // Pause 110ms (> 50ms settleMs, < 300ms waitMs) before text reply arrives
          setTimeout(() => {
            write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'Delayed answer after tool.' },
            } } })
          }, 110)
        }, 20)
      }, 20)
      return
    }
    if (promptText.includes('lingering-reactive-tool')) {
      write({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } })
      setTimeout(() => {
        write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'stuck-tool-1',
          title: 'Stuck check',
          kind: 'read',
          status: 'in_progress',
        } } })
      }, 20)
      return
    }
    if (promptText.includes('overflow-schedules-with-os-child')) {
      for (let i = 0; i < 64; i++) {
        write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'sched-' + i,
          title: 'Run schedule',
          status: 'completed',
          rawInput: { DurationSeconds: 120, Prompt: 'Wait ' + i },
          rawOutput: { status: 'scheduled', taskId: 't-' + i },
        } } })
      }
      write({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } })
      return
    }
    if (promptText.includes('command-with-mcp-and-conhost')) {
      write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'cmd-mcp-chk',
        title: 'echo ok',
        kind: 'execute',
        status: 'completed',
        rawInput: { CommandLine: 'echo ok' },
        rawOutput: { exitCode: 0 },
      } } })
      write({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } })
      return
    }
    if (promptText.includes('pending-perm-with-conhost')) {
      write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'perm-win-1',
        title: '\`git status\`',
        kind: 'execute',
        status: 'pending',
        rawInput: { CommandLine: 'git status' },
      } } })
      write({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } })
      return
    }
    write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'Done.' },
    } } })
    write({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } })
  }
})
`

describe('Antigravity ACP background work, reactive continuations, worker question prompts, and card resume', () => {
  const cleanups: (() => Promise<void>)[] = []

  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()!()
  })

  async function setup(options: {
    noAppend?: boolean
    childRows?: () => Promise<readonly ChildProcessRow[]> | readonly ChildProcessRow[]
    userMcpConfig?: string
    reactiveTurnSettleMs?: number
    reactiveTurnWaitMs?: number
    reactiveTurnMaxMs?: number
    lookBeforeEndMs?: number
  } = {}) {
    const dir = await mkdtemp(join(tmpdir(), 'sotto-agy-bg-'))
    cleanups.push(() => rm(dir, { recursive: true, force: true }))
    const projectDir = join(dir, 'repo')
    await mkdir(projectDir, { recursive: true })
    const scriptPath = join(dir, 'fake-agy.mjs')
    const statePath = join(dir, 'requests.jsonl')
    const configPath = join(dir, 'config.json')
    await writeFile(scriptPath, FAKE_AGENT_SOURCE, 'utf8')
    await writeFile(configPath, JSON.stringify({ noAppend: options.noAppend === true }), 'utf8')
    await writeFile(statePath, '', 'utf8')
    const host = new AntigravityAcpHost(dir, {
      executable: process.execPath,
      executableArgs: [scriptPath, statePath, configPath],
      requestTimeoutMs: 5_000,
      startTimeoutMs: 5_000,
      lookBeforeEndMs: options.lookBeforeEndMs ?? 150,
      reactiveTurnSettleMs: options.reactiveTurnSettleMs ?? 50,
      ...(options.reactiveTurnWaitMs !== undefined ? { reactiveTurnWaitMs: options.reactiveTurnWaitMs } : {}),
      ...(options.reactiveTurnMaxMs !== undefined ? { reactiveTurnMaxMs: options.reactiveTurnMaxMs } : {}),
      ...(options.userMcpConfig ? { userMcpConfig: options.userMcpConfig } : {}),
      ...(options.childRows ? { childProcesses: async () => await options.childRows!() } : { childProcesses: async () => [] }),
    })
    cleanups.push(async () => { host.disconnect(); await host.closed() })
    await host.connect()
    await host.execute({ type: 'create-project', commandId: 'cmd-proj-1', projectId: 'proj-1', title: 'Repo', path: projectDir })
    return { host, dir, projectDir, statePath }
  }

  it('passes strengthened questionInstructions to non-Watcher worker sessions when append capability is advertised', async () => {
    const withAppend = await setup({ noAppend: false })
    await withAppend.host.execute({
      type: 'create-thread',
      commandId: 'cmd-create-w1',
      projectId: 'proj-1',
      threadId: 'thread-worker-1',
      title: 'Worker',
      modelId: 'gemini-3.1-pro',
    })
    const { readFileSync } = await import('node:fs')
    const entries = readFileSync(withAppend.statePath, 'utf8').trim().split('\n').map(line => JSON.parse(line) as { method: string; params?: Record<string, unknown> })
    const sessionNew = entries.findLast(entry => entry.method === 'session/new')
    const append = (sessionNew?.params?._meta as { antigravity?: { systemPrompt?: { append?: string } } } | undefined)?.antigravity?.systemPrompt?.append
    expect(append).toBe(questionInstructions('ask_question', false))
    expect(append).toContain('Never write a plain-text "question card"')

    const withoutAppend = await setup({ noAppend: true })
    await withoutAppend.host.execute({
      type: 'create-thread',
      commandId: 'cmd-create-w2',
      projectId: 'proj-1',
      threadId: 'thread-worker-2',
      title: 'Worker No Append',
      modelId: 'gemini-3.1-pro',
    })
    const entries2 = readFileSync(withoutAppend.statePath, 'utf8').trim().split('\n').map(line => JSON.parse(line) as { method: string; params?: Record<string, unknown> })
    const sessionNew2 = entries2.findLast(entry => entry.method === 'session/new')
    expect(sessionNew2?.params?._meta).toBeUndefined()
  })

  it('surfaces active background work on premature end_turn and emits a fresh completion turn when reactive wakeup finishes', async () => {
    let liveChildRunning = true
    const { host } = await setup({
      childRows: () => liveChildRunning ? [{ pid: 9999, startedAt: Date.now() - 100, argv: ['bash', '-c', 'npm test'], marks: [] }] : [],
    })
    await host.execute({
      type: 'create-thread',
      commandId: 'cmd-create-bg1',
      projectId: 'proj-1',
      threadId: 'thread-bg-1',
      title: 'BG Turn',
      modelId: 'gemini-3.1-pro',
    })

    let intermediateSnapshot: {
      status: string
      lastTurn?: { id: string; status: string } | undefined
      backgroundWork?: { id: string; label: string; type: string }[] | undefined
      activities?: { id: string; kind: string; status: string; turnId: string }[] | undefined
    } | undefined
    let sawReactiveRunning = false
    let latestThread: {
      status: string
      lastTurn?: { id: string; status: string } | undefined
      backgroundWork?: { id: string; label: string; type: string }[] | undefined
      messages: { role: string; text: string; turnMessageId?: string | undefined }[]
      activities?: { id: string; kind: string; status: string; turnId: string }[] | undefined
    } | undefined
    const trace: { status: string; lastTurn: string | undefined; bg: number; msgs: number }[] = []

    host.subscribe(snap => {
      const thread = snap.threads.find(t => t.id === 'thread-bg-1')
      if (!thread) return
      latestThread = thread
      trace.push({ status: thread.status, lastTurn: thread.lastTurn?.id, bg: thread.backgroundWork?.length ?? 0, msgs: thread.messages.length })
      if (thread.status === 'idle' && thread.lastTurn?.id === 'msg-1' && (thread.backgroundWork?.length ?? 0) > 0 && !intermediateSnapshot) {
        intermediateSnapshot = thread
      }
      if (thread.status === 'running' && thread.lastTurn?.id?.startsWith('msg-1:wakeup:')) {
        sawReactiveRunning = true
        liveChildRunning = false
      }
    })

    const result = await host.execute({
      type: 'send',
      threadId: 'thread-bg-1',
      commandId: 'cmd-send-1',
      messageId: 'msg-1',
      text: 'premature-bg-command',
    })
    expect(result).toEqual({ accepted: true })

    await expect.poll(() => intermediateSnapshot, { timeout: 3_000 }).toBeTruthy()
    expect(agentBackgroundWorkSchema.safeParse(intermediateSnapshot!.backgroundWork).success).toBe(true)
    expect(intermediateSnapshot!.backgroundWork).toHaveLength(1)
    const runningCmd = intermediateSnapshot!.activities?.find(act => act.kind === 'command' && act.turnId === 'msg-1')
    expect(runningCmd?.status).toBe('running')

    await expect.poll(() => ({ sawReactiveRunning, trace })).toMatchObject({ sawReactiveRunning: true })
    await expect.poll(() => latestThread?.status === 'idle' && latestThread?.lastTurn?.id !== 'msg-1' && !latestThread?.backgroundWork?.length).toBe(true)

    expect(latestThread?.lastTurn?.status).toBe('completed')
    expect(latestThread?.lastTurn?.id).toMatch(/^msg-1:wakeup:\d+$/)
    expect(latestThread?.messages.some(m => m.role === 'assistant' && m.text.includes('Tests passed and pushed PR.'))).toBe(true)
  })

  it('transitions an idle thread back to running immediately when an answer is delivered, unless RPC reply fails', async () => {
    const { host } = await setup()
    await host.execute({
      type: 'create-thread',
      commandId: 'cmd-create-ans1',
      projectId: 'proj-1',
      threadId: 'thread-ans-1',
      title: 'Answer Resume',
      modelId: 'gemini-3.1-pro',
    })
    let pendingRequestId: string | undefined
    let currentStatus: string | undefined
    const statusesAfterAnswer: string[] = []
    let answered = false
    host.subscribe(s => {
      const t = s.threads.find(item => item.id === 'thread-ans-1')
      if (!t) return
      currentStatus = t.status
      if (t.requests[0]) pendingRequestId = t.requests[0].id
      if (answered) statusesAfterAnswer.push(t.status)
    })

    await host.execute({
      type: 'send',
      threadId: 'thread-ans-1',
      commandId: 'cmd-q-1',
      messageId: 'msg-q-1',
      text: 'reactive-question',
    })

    await expect.poll(() => pendingRequestId).toBeTruthy()
    expect(currentStatus).toBe('idle')

    answered = true
    const answerResult = await host.execute({
      type: 'answer',
      commandId: 'cmd-ans-1',
      threadId: 'thread-ans-1',
      requestId: pendingRequestId!,
      answer: 'Option A',
      questionAnswers: { q0: { optionIds: ['a'] } },
    })
    expect(answerResult).toEqual({ accepted: true })
    expect(statusesAfterAnswer[0]).toBe('running')

    // Reactive turn settles cleanly afterwards.
    await expect.poll(() => currentStatus).toBe('idle')
  })

  it('keeps outlived backgrounded updates quiet (idle with backgroundWork) and bounds stuck reactive tools with reactiveTurnMaxMs', async () => {
    const { host } = await setup({ reactiveTurnSettleMs: 40, reactiveTurnWaitMs: 120, reactiveTurnMaxMs: 180 })
    await host.execute({ type: 'create-thread', commandId: 'c-outlived', projectId: 'proj-1', threadId: 't-outlived', title: 'Outlived', modelId: 'gemini-3.1-pro' })

    const snapshots: { status: string; lastTurnId: string | undefined; bg: number }[] = []
    host.subscribe(snap => {
      const t = snap.threads.find(item => item.id === 't-outlived')
      if (t) snapshots.push({ status: t.status, lastTurnId: t.lastTurn?.id, bg: t.backgroundWork?.length ?? 0 })
    })

    await host.execute({ type: 'send', threadId: 't-outlived', commandId: 's-1', messageId: 'm-outlived', text: 'post-turn-outlived-progress' })
    await expect.poll(() => (host as unknown as { threads: Map<string, { status: string; backgroundWork?: unknown[] }> }).threads.get('t-outlived')?.status).toBe('idle')

    // Wait past the 30ms post-turn `in_progress` progress update and ensure it never flipped back to running or opened wakeup:1.
    await new Promise(resolve => setTimeout(resolve, 90))
    const current = (await host.snapshot()).threads.find(t => t.id === 't-outlived')!
    expect(current.status).toBe('idle')
    expect(current.lastTurn?.id).toBe('m-outlived')
    expect(current.backgroundWork).toHaveLength(1)
    expect(snapshots.some(s => s.lastTurnId?.startsWith('m-outlived:wakeup:'))).toBe(false)

    // A stuck in_progress reactive tool settles when reactiveTurnMaxMs elapses instead of remaining running forever.
    await host.execute({ type: 'send', threadId: 't-outlived', commandId: 's-2', messageId: 'm-stuck', text: 'lingering-reactive-tool' })
    await expect.poll(async () => (await host.snapshot()).threads.find(t => t.id === 't-outlived')?.lastTurn).toEqual({ id: 'm-stuck:wakeup:1', status: 'completed' })
    const afterStuck = (await host.snapshot()).threads.find(t => t.id === 't-outlived')!
    expect(afterStuck.status).toBe('idle')
  })

  it('preserves original tool row ownership when a delayed thought opens a reactive turn before completion', async () => {
    const { host } = await setup()
    await host.execute({ type: 'create-thread', commandId: 'c-row', projectId: 'proj-1', threadId: 't-row', title: 'Row', modelId: 'gemini-3.1-pro' })
    await host.execute({ type: 'send', threadId: 't-row', commandId: 's-row', messageId: 'm-row', text: 'delayed-thought-then-old-tool-done' })

    await expect.poll(async () => {
      const t = (await host.snapshot()).threads.find(item => item.id === 't-row')
      return t?.status === 'idle' && t?.lastTurn?.id === 'm-row:wakeup:1'
    }).toBe(true)

    const thread = (await host.snapshot()).threads.find(item => item.id === 't-row')!
    const cmdRows = (thread.activities ?? []).filter(act => act.kind === 'command')
    expect(cmdRows).toHaveLength(1)
    expect(cmdRows[0]!.turnId).toBe('m-row')
    expect(cmdRows[0]!.status).toBe('completed')
  })

  it('re-checks activity revision after lookBeforeEnd and waits through slow post-tool pauses within one reactive turn', async () => {
    const { host: scanHost } = await setup({
      reactiveTurnSettleMs: 80,
      reactiveTurnWaitMs: 320,
      lookBeforeEndMs: 250,
      childRows: async () => {
        await new Promise(resolve => setTimeout(resolve, 120))
        return []
      },
    })
    await scanHost.execute({ type: 'create-thread', commandId: 'c-scan', projectId: 'proj-1', threadId: 't-scan', title: 'ScanRace', modelId: 'gemini-3.1-pro' })
    const wakeupEnds: string[] = []
    scanHost.subscribe(snap => {
      const t = snap.threads.find(item => item.id === 't-scan')
      if (t?.status === 'idle' && t.lastTurn?.id.startsWith('m-scan:wakeup:') && wakeupEnds.at(-1) !== t.lastTurn.id) {
        wakeupEnds.push(t.lastTurn.id)
      }
    })
    await scanHost.execute({ type: 'send', threadId: 't-scan', commandId: 's-scan', messageId: 'm-scan', text: 'streaming-during-look' })
    await expect.poll(async () => {
      const t = (await scanHost.snapshot()).threads.find(item => item.id === 't-scan')
      return t?.messages.some(m => m.role === 'assistant' && m.text.includes('Part 2')) && t?.status === 'idle'
    }, { timeout: 3_000 }).toBe(true)
    expect(wakeupEnds).toEqual(['m-scan:wakeup:1'])

    const { host: pauseHost } = await setup({ reactiveTurnSettleMs: 50, reactiveTurnWaitMs: 350 })
    await pauseHost.execute({ type: 'create-thread', commandId: 'c-pause', projectId: 'proj-1', threadId: 't-pause', title: 'Pause', modelId: 'gemini-3.1-pro' })
    const pauseEnds: string[] = []
    pauseHost.subscribe(snap => {
      const t = snap.threads.find(item => item.id === 't-pause')
      if (t?.status === 'idle' && t.lastTurn?.id.startsWith('m-pause:wakeup:') && pauseEnds.at(-1) !== t.lastTurn.id) {
        pauseEnds.push(t.lastTurn.id)
      }
    })
    await pauseHost.execute({ type: 'send', threadId: 't-pause', commandId: 's-pause', messageId: 'm-pause', text: 'slow-pause-after-tool' })
    await expect.poll(async () => {
      const t = (await pauseHost.snapshot()).threads.find(item => item.id === 't-pause')
      return t?.status === 'idle' && t?.messages.some(m => m.role === 'assistant' && m.text.includes('Delayed answer after tool.'))
    }, { timeout: 3_000 }).toBe(true)
    expect(pauseEnds).toEqual(['m-pause:wakeup:1'])
  })

  it('filters stdio npx MCP servers and Windows conhost, ignores pending permissions, and preserves OS child processes under the 64-item cap', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sotto-agy-mcp-'))
    cleanups.push(() => rm(dir, { recursive: true, force: true }))
    const mcpPath = join(dir, 'mcp_config.json')
    await writeFile(mcpPath, JSON.stringify({
      mcpServers: {
        sqlite: { command: 'npx', args: ['-y', '@mcp/sqlite'] },
      },
    }), 'utf8')

    let mode: 'mcp' | 'pending' | 'overflow' = 'mcp'
    const { host } = await setup({
      userMcpConfig: mcpPath,
      childRows: () => mode === 'overflow'
        ? [{ pid: 888, startedAt: Date.now() - 50, argv: ['bash', '-c', 'sleep 30'], marks: [] }]
        : [
            { pid: 501, startedAt: Date.now() - 100, argv: ['node', '/usr/local/bin/npx', '-y', '@mcp/sqlite'], marks: [] },
            { pid: 502, startedAt: Date.now() - 100, argv: ['C:\\Windows\\system32\\conhost.exe', '0x4'], marks: [] },
          ],
    })
    await host.execute({ type: 'create-thread', commandId: 'c-mcp', projectId: 'proj-1', threadId: 't-mcp', title: 'MCP', modelId: 'gemini-3.1-pro' })

    // Running command turn ends cleanly with 0 background work because npx MCP + conhost are filtered out during lookBeforeEnd.
    await host.execute({ type: 'send', threadId: 't-mcp', commandId: 's-mcp-1', messageId: 'm-mcp-1', text: 'command-with-mcp-and-conhost' })
    await expect.poll(async () => (await host.snapshot()).threads.find(t => t.id === 't-mcp')?.lastTurn).toEqual({ id: 'm-mcp-1', status: 'completed' })
    expect((await host.snapshot()).threads.find(t => t.id === 't-mcp')?.backgroundWork).toBeUndefined()

    // Pending permission prompt + conhost never leaves phantom background work either.
    mode = 'pending'
    await host.execute({ type: 'send', threadId: 't-mcp', commandId: 's-mcp-2', messageId: 'm-mcp-2', text: 'pending-perm-with-conhost' })
    await expect.poll(async () => (await host.snapshot()).threads.find(t => t.id === 't-mcp')?.lastTurn).toEqual({ id: 'm-mcp-2', status: 'completed' })
    expect((await host.snapshot()).threads.find(t => t.id === 't-mcp')?.backgroundWork).toBeUndefined()

    // Under 64 tracked schedules + 1 live OS child process, live OS child process is not evicted by the cap.
    mode = 'overflow'
    await host.execute({ type: 'send', threadId: 't-mcp', commandId: 's-mcp-3', messageId: 'm-mcp-3', text: 'overflow-schedules-with-os-child' })
    await expect.poll(async () => (await host.snapshot()).threads.find(t => t.id === 't-mcp')?.lastTurn).toEqual({ id: 'm-mcp-3', status: 'completed' })
    const overflowWork = (await host.snapshot()).threads.find(t => t.id === 't-mcp')?.backgroundWork ?? []
    expect(overflowWork).toHaveLength(64)
    expect(overflowWork.some(item => item.label === 'sleep 30')).toBe(true)
  })
})
