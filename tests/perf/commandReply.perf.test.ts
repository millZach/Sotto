// @vitest-environment node
/**
 * What one command's reply costs in main when eight threads hold long histories (issue #313).
 * The histories are synthetic and the timers read nothing but durations, so no thread content is
 * reported. It asserts no time, so it runs only under `SOTTO_PERF_BENCH=1` (`tests/fixtures/perfBench.ts`):
 *
 *   SOTTO_PERF_BENCH=1 npx vitest run tests/perf/commandReply.perf.test.ts --maxWorkers=1 --disable-console-intercept
 *
 * Each command goes the way the desktop window sends it: the `AGENT_COMMAND` handler, the desktop
 * host router and the local host service, joined as `index.ts` joins them. The time is from the
 * handler's call to its answer, and it includes the command's own work. `get()` and `shell()` are
 * timed alone beside them. Nothing here reaches a renderer, so the structured clone Electron makes
 * to send the answer is not counted.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { AgentControl, type PublishScheduler } from '../../src/main/agents/control'
import { AgentCredentials } from '../../src/main/agents/credentials'
import { LocalHostService } from '../../src/main/agents/hostService'
import { E2EAgentHost, e2eAgentReasoner } from '../../src/main/e2e/agentEffects'
import { DesktopHostRouter } from '../../src/main/hosts/desktopHostRouter'
import { emptyDesktopState } from '../../src/main/hosts/inactiveLocalHost'
import type { IpcInvocationEvent, IpcMainAdapter, TrustedIpcSender } from '../../src/main/ipc/registerIpc'
import { AGENT_COMMAND, type AgentCommand, type AgentHostSnapshot, type AgentMessage, type AgentState, type AgentThread } from '../../src/shared/agents'
import { median, PERF_BENCH, round } from '../fixtures/perfBench'

vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => 'D:/fixture' } }))
import { registerAgentIpc } from '../../src/main/agents/ipc'

const THREADS = 8
const MESSAGES_PER_THREAD = 1_500
const TEXT_LENGTH = 800
const WARMUP = 5
const ITERATIONS = 40
const HOST_ID = '11111111-1111-4111-8111-111111111111'

/** The broadcast is a separate cost from the reply; holding it closed keeps the timing on the reply. */
const neverPublish: PublishScheduler = () => () => undefined

function history(threadId: string): AgentMessage[] {
  const filler = 'x'.repeat(TEXT_LENGTH)
  return Array.from({ length: MESSAGES_PER_THREAD }, (_, index): AgentMessage => ({
    id: `${threadId}-m${index}`, role: index % 2 ? 'assistant' : 'user', text: filler,
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
  }))
}

/** The fixture host with eight threads that each hold a long history instead of its two empty ones. */
class LongHistoryHost extends E2EAgentHost {
  private readonly threads: AgentThread[] = Array.from({ length: THREADS }, (_, index): AgentThread => ({
    id: `thread-${index}`, title: `Thread ${index}`, projectId: 'project', modelId: 'claude:test', status: 'idle',
    messages: history(`thread-${index}`), requests: [],
  }))
  override async snapshot(): Promise<AgentHostSnapshot> {
    return { ...(await super.snapshot()), threads: structuredClone(this.threads) }
  }
}

async function time(work: () => unknown): Promise<number> {
  for (let index = 0; index < WARMUP; index++) await work()
  const samples: number[] = []
  for (let index = 0; index < ITERATIONS; index++) {
    const started = performance.now()
    await work()
    samples.push(performance.now() - started)
  }
  return round(median(samples), 2)
}

describe.skipIf(!PERF_BENCH)('command reply cost', () => {
  let root = ''
  let control: AgentControl | undefined
  let dispose: (() => void) | undefined
  afterAll(async () => {
    dispose?.()
    control?.dispose()
    if (root) await rm(root, { recursive: true, force: true })
  })

  it('reports the median time to answer one command from the window', async () => {
    root = await mkdtemp(join(tmpdir(), 'sotto-perf-command-reply-'))
    const credentials = new AgentCredentials(root, { isEncryptionAvailable: () => false, encryptString: text => Buffer.from(text), decryptString: bytes => bytes.toString() })
    await credentials.load()
    control = new AgentControl({ schedule: neverPublish, directory: root, host: new LongHistoryHost(), credentials, reasoner: e2eAgentReasoner,
      membership: { status: async () => ({ status: 'beta', label: 'Fixture', expiresAt: null }), action: async () => ({ status: 'beta', label: 'Fixture', expiresAt: null }) } })
    await control.start(); await control.command({ type: 'connect' })
    const live = control
    expect(live.get().host.threads.reduce((count, thread) => count + thread.messages.length, 0)).toBe(THREADS * MESSAGES_PER_THREAD)

    const router = new DesktopHostRouter(() => emptyDesktopState(HOST_ID))
    router.add({ hostId: HOST_ID, name: 'This computer', kind: 'local', service: new LocalHostService({ control: live }),
      detail: threadId => live.threadDetail(threadId), preview: () => null })
    const listeners = new Map<string, (event: IpcInvocationEvent, ...args: unknown[]) => unknown>()
    const ipc: IpcMainAdapter = { handle: (channel, handler) => { listeners.set(channel, handler) }, removeHandler: channel => { listeners.delete(channel) } }
    const url = 'file:///main.html'
    const main: TrustedIpcSender = { role: 'main', url, webContents: { mainFrame: { parent: null, url }, isDestroyed: () => false, getURL: () => url } }
    const unregister = registerAgentIpc(ipc, router, router, () => [main], 'win32', { status: vi.fn(), download: vi.fn() },
      { synthesize: vi.fn(), voices: vi.fn(), cancel: vi.fn() }, { synthesize: vi.fn(), cancel: vi.fn() })
    dispose = () => { unregister(); router.dispose() }
    const send = (command: AgentCommand) =>
      listeners.get(AGENT_COMMAND)!({ sender: main.webContents, senderFrame: main.webContents.mainFrame }, command) as Promise<AgentState>

    let flip = false
    const voice = () => { flip = !flip; return send({ type: 'voice', action: flip ? 'mute' : 'unmute' }) }
    let selected = 0
    const select = () => send({ type: 'select-thread', threadId: `thread-${selected++ % THREADS}` })
    let typed = 0
    const draft = () => send({ type: 'save-thread-draft', threadId: 'thread-0', draftId: randomUUID(), text: `Draft ${typed++}` })

    const replies = [await voice(), await select(), await draft()]
    const report = {
      threads: THREADS, messagesPerThread: MESSAGES_PER_THREAD, textLength: TEXT_LENGTH, iterations: ITERATIONS,
      replyCarriesMessages: replies.map(reply => reply.host.threads.some(thread => thread.messages.length > 0)),
      ms: {
        get: await time(() => live.get()),
        shell: await time(() => live.shell()),
        voice: await time(voice),
        selectThread: await time(select),
        saveThreadDraft: await time(draft),
      },
    }
    console.info(`command reply: ${JSON.stringify(report)}`)
  }, 120_000)
})
