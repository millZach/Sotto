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

  async function setup(options: { noAppend?: boolean; childRows?: () => readonly ChildProcessRow[] } = {}) {
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
      lookBeforeEndMs: 150,
      reactiveTurnSettleMs: 50,
      ...(options.childRows ? { childProcesses: async () => options.childRows!() } : { childProcesses: async () => [] }),
    })
    cleanups.push(async () => { host.disconnect(); await host.closed() })
    await host.connect()
    await host.execute({ type: 'create-project', commandId: 'cmd-proj-1', projectId: 'proj-1', title: 'Repo', path: projectDir })
    return { host, projectDir, statePath }
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
})
