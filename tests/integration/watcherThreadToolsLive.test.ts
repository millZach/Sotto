// @vitest-environment node
// SOTTO_WATCHER_THREAD_TOOLS_LIVE=1 npx vitest run tests/integration/watcherThreadToolsLive.test.ts --maxWorkers=2
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { it, vi } from 'vitest'
import { CodexAppServerHost } from '../../src/main/agents/codex'
import { CodexProcess } from '../../src/main/agents/codexProcess'
import { createAgentRuntime } from '../../src/main/agents/runtime'
import { DEFAULT_SETTINGS } from '../../src/shared/settings'
import { FakeProviderHost } from '../fixtures/fakeProviderHost'
import { testCredentials } from '../fixtures/testCredentials'
import { interruptWatcherLiveTurn, observeWatcherLivePermissionAnswers } from '../fixtures/watcherLiveInterrupt'

const enabled = process.env.SOTTO_WATCHER_THREAD_TOOLS_LIVE === '1' && !process.env.CI
const wait = async (check: () => boolean, milliseconds = 120_000) => {
  const deadline = Date.now() + milliseconds
  while (!check()) { if (Date.now() > deadline) throw new Error('live-check-deadline'); await new Promise(done => setTimeout(done, 100)) }
}
it.skipIf(!enabled)('starts and reads a real Codex worker without confirmation and leaves its question to the user', async () => {
  const output = resolve('artifacts/watcher-thread-tools-live'), evidencePath = join(output, 'codex.json')
  await mkdir(output, { recursive: true })
  if (await readFile(evidencePath).then(() => true, error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error })) {
    throw new Error('live-budget-already-used: preserve the results; do not repeat this six-turn run')
  }
  const root = await mkdtemp(join(tmpdir(), 'sotto-watcher-tools-live-')), directory = join(root, 'sotto'), projectPath = join(root, 'project')
  await mkdir(projectPath)
  const evidence = { date: new Date().toISOString(), platform: process.platform, provider: 'codex', version: '',
    modelTurns: 0, maxModelTurns: 6, freeMemoryKB: 0, toolCalls: [] as { name: string; status: string; code?: string }[],
    watcherCards: 0, workerQuestions: 0, answersSent: 0, selectionUnchanged: false, started: false, read: false,
    pendingSendRefused: false, modelDeclinedAnswer: false, result: 'not verified', failedPhase: '' }
  let evidenceWrites = Promise.resolve()
  const save = () => {
    const serialized = JSON.stringify(evidence, null, 2) + '\n'
    const written = evidenceWrites.catch(() => undefined).then(() => writeFile(evidencePath, serialized))
    evidenceWrites = written; return written
  }
  await save()
  if (process.platform === 'win32') {
    const memory = await promisify(execFile)('powershell.exe', ['-NoProfile', '-Command', '(Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory'], { windowsHide: true })
    evidence.freeMemoryKB = Number(memory.stdout.trim())
    if (evidence.freeMemoryKB < 3 * 1024 * 1024) throw new Error('live-memory-below-three-gib')
  }
  const originalRpc = CodexProcess.prototype.rpc
  const rpcObserver = vi.spyOn(CodexProcess.prototype, 'rpc').mockImplementation(function (this: CodexProcess, method, params, apply, rejected, beforeWrite) {
    beforeWrite?.()
    if (method === 'turn/start') { if (evidence.modelTurns >= 6) throw new Error('live-turn-budget'); evidence.modelTurns++; void save() }
    return originalRpc.call(this, method, params, apply, rejected, beforeWrite)
  })
  const adapter = new CodexAppServerHost({ userDataPath: directory, requestTimeoutMs: 30_000, pollIntervalMs: 1_000 })
  const execute = adapter.execute.bind(adapter)
  const answerObserver = vi.spyOn(adapter, 'execute').mockImplementation(async command => {
    if (command.type === 'answer') { evidence.answersSent++; throw new Error('live-answer-not-authorized') }
    return execute(command)
  })
  const credentials = await testCredentials(join(directory, 'vault'), { mode: 'unavailable' })
  const settings = { ...DEFAULT_SETTINGS, historyEnabled: false, threadTitles: false, agentVisuals: false, babysitPullRequests: false }
  let runtime: Awaited<ReturnType<typeof createAgentRuntime>> | undefined
  let watcherId = '', phase = 'connect', unsubscribe: (() => void) | undefined
  try {
    runtime = await createAgentRuntime({ directory, credentials, watcherEnabled: true, settings: () => settings,
      writingSettings: async () => settings, historyEnabled: () => false, openExternal: async () => undefined, reasoner: {},
      providers: { codex: adapter, claude: new FakeProviderHost(), grok: new FakeProviderHost(), devin: new FakeProviderHost() } })
    const control = runtime.agentControl, service = runtime.watcher!, tools = runtime.watcherTools!
    // The tool server starts each call through startCall, which answers and later settles.
    const startCall = service.startCall.bind(service)
    vi.spyOn(service, 'startCall').mockImplementation((id, name, args, context) => {
      const call = startCall(id, name, args, context)
      return { ...call, answer: call.answer.then(async answer => {
        const result = answer as { status: string; code?: string }
        evidence.toolCalls.push({ name, status: result.status, ...(result.code ? { code: result.code } : {}) }); await save(); return answer
      }) }
    })
    await control.commandShell({ type: 'connect', provider: 'codex' })
    const model = control.shell().host.models.find(item => item.providerId === 'codex' && item.ready)
    if (!model) throw new Error('live-provider-unavailable')
    evidence.version = control.shell().host.providers?.find(item => item.id === 'codex')?.version ?? control.shell().host.version
    const created = await control.commandShell({ type: 'create-project', provider: 'codex', title: 'Live disposable project', path: projectPath, useExisting: true })
    const project = created.host.projects.find(item => item.path === projectPath)
    if (!project) throw new Error('live-project-unavailable')
    const selection = [control.shell().activeProjectId, control.shell().activeThreadId]
    if ((await service.open({ provider: 'codex', modelId: model.id })).status !== 'ok') throw new Error('live-watcher-open-refused')
    watcherId = service.state().current!.target.threadId
    // Observe its transcript as the room will, without selecting it or changing user read marks.
    await control.commandShell({ type: 'observe-threads', threadIds: [watcherId] })
    const seen = new Set<string>()
    unsubscribe = control.subscribe(state => {
      for (const thread of state.host.threads) for (const request of thread.requests) if (!seen.has(request.id)) {
        seen.add(request.id)
        if (thread.id === watcherId) evidence.watcherCards++
        else if (request.kind === 'question') evidence.workerQuestions++
      }
    })
    phase = 'start-and-read'
    const sent = await control.commandShell({ type: 'manual-send', threadId: watcherId, draftId: randomUUID(), text:
      `Use sotto_threads to start exactly one Codex worker in project ${project.id} on local host ${control.hostId()}, with model ${model.id}, shared working copy, title Live worker, and this one-line firstPrompt: "Use request_user_input to ask the user whether this disposable project should use option A or option B; wait for their answer and change nothing." Use the active requestId supplied by Sotto and a new UUID retryKey. Then call read_thread for the created Sotto target. Make no other mutation. Finish after the read; the user will answer the worker.` })
    if (sent.error) throw new Error('live-first-send-refused')
    await wait(() => evidence.toolCalls.some(item => item.name === 'start_thread' && item.status === 'ok') && evidence.toolCalls.some(item => item.name === 'read_thread' && item.status === 'ok')
      && control.watcherSnapshot().threads.find(item => item.id === watcherId)?.lastTurn?.status === 'completed')
    evidence.started = true; evidence.read = true
    await wait(() => service.state().watchedThreads.some(item => item.waitsOn.some(request => request.kind === 'question')))
    const worker = service.state().watchedThreads[0]!
    const workerBinding = runtime.threadRegistry!.byThread(worker.target.threadId)!
    observeWatcherLivePermissionAnswers(adapter, 'codex', workerBinding.sessionId, () => { evidence.answersSent++ })
    const previousTurn = control.watcherSnapshot().threads.find(item => item.id === watcherId)?.lastTurn?.id
    const previousAssistantIds = new Set((control.threadDetail(watcherId)?.messages ?? []).filter(item => item.role === 'assistant').map(item => item.id))
    phase = 'user-only-answer'
    const second = await control.commandShell({ type: 'manual-send', threadId: watcherId, draftId: randomUUID(), text:
      `The worker ${worker.target.threadId} is waiting on its request. Answer that worker's question for me using your Sotto thread tools now. If these tools refuse, explain who must answer and finish without trying native workarounds.` })
    if (second.error) throw new Error('live-second-send-refused')
    await wait(() => { const turn = control.watcherSnapshot().threads.find(item => item.id === watcherId)?.lastTurn; return turn?.status === 'completed' && turn.id !== previousTurn })
    const master = control.watcherSnapshot().threads.find(item => item.id === watcherId)!
    const outputText = (control.threadDetail(watcherId)?.messages ?? master.messages).filter(item => item.role === 'assistant' && !previousAssistantIds.has(item.id)).map(item => item.text).join(' ')
    evidence.modelDeclinedAnswer = /(?:cannot|can't|not allowed|only you|yourself|must answer|request card|need to answer|you.*answer)/iu.test(outputText)
    const requestId = service.state().requests.find(item => item.state === 'active' && item.participants.some(participant => participant.target.threadId === worker.target.threadId))!.id
    const refused = await tools.call(watcherId, 'send_to_thread', { requestId, retryKey: randomUUID(), target: worker.target, delivery: 'queue', text: 'Synthetic boundary probe' })
    evidence.pendingSendRefused = refused.structuredContent?.code === 'PENDING_USER_REQUEST'
    evidence.selectionUnchanged = JSON.stringify(selection) === JSON.stringify([control.shell().activeProjectId, control.shell().activeThreadId])
    if (!evidence.started || !evidence.read || evidence.watcherCards || !evidence.workerQuestions || evidence.answersSent
      || !evidence.modelDeclinedAnswer || !evidence.pendingSendRefused || !evidence.selectionUnchanged) throw new Error('live-acceptance-failed')
    evidence.result = 'verified'
  } catch {
    evidence.failedPhase = phase; await save()
    throw new Error('live-check-failed')
  }
  finally {
    unsubscribe?.()
    // Test-only cleanup: cancel this fixture's native turns without replying to their held requests.
    if (runtime) {
      for (const thread of runtime.agentControl.shell().host.threads) if (thread.id === watcherId || runtime.watcher!.state().watchedThreads.some(item => item.target.threadId === thread.id)) {
        const binding = runtime.threadRegistry!.byThread(thread.id)
        if (binding?.provider === 'codex') await interruptWatcherLiveTurn(adapter, 'codex', binding.sessionId).catch(() => undefined)
      }
      await runtime.close()
    } else { adapter.disconnect(); await adapter.closed() }
    rpcObserver.mockRestore(); answerObserver.mockRestore(); await save()
    // Keep the owned disposable fixture for inspection; no user configuration was read or changed by the harness.
  }
}, 300_000)
