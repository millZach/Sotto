import { createHash, randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { ClaudeProtocol } from '../../src/main/agents/claudeProtocol'
import { CodexProcess } from '../../src/main/agents/codexProcess'
import type { AgentCommand, AgentState } from '../../src/shared/agents'
import { ThreadDraftStore } from '../../src/renderer/src/agents/threadDraftStore'
import { claudeFixture } from './claudeFixture'
import { codexFixture } from './codexFixture'
import type { DurableWriteRecorder } from './durableWrites'
import { manualSendCoordinator } from './manualSendCoordinator'

/** One send, from the press to Sotto writing the prompt to the provider's process. */
export interface SendWrites {
  /** Durable writes in that time, by file. */
  readonly writes: Record<string, number>
  /** The bytes they made durable, by file. */
  readonly bytes: Record<string, number>
  readonly ms: number
}

async function until(check: () => boolean | Promise<boolean>, what: string, deadline = 30_000): Promise<void> {
  for (const end = Date.now() + deadline; !await check();) {
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}.`)
    await delay(10)
  }
}

/** The sizes of the stores on the development machine when #767 was written, as the old code wrote them: indented. */
export const DEVELOPMENT_STORE_BYTES = { claude: 388 * 1024, codex: 1300 * 1024 } as const

const synthetic = (seed: string): string => createHash('sha256').update(seed).digest('hex')

/**
 * Grows the provider's thread store to `bytes` with other threads like the one under test, each with synthetic
 * history records and a native session no client knows, so the store each send rewrites is the size it is on a
 * machine that has used Sotto for a while. Nothing in it is taken from real data.
 */
async function growThreadStore(provider: 'claude' | 'codex', root: string, threadId: string, bytes: number): Promise<void> {
  const path = join(root, provider === 'claude' ? 'claude-threads.json' : 'codex-threads.json')
  const aliases = JSON.parse(await readFile(path, 'utf8')) as Record<string, Record<string, unknown>>
  const template = aliases[threadId] ?? Object.values(aliases)[0]
  if (!template) throw new Error('There is no thread record to grow the store from.')
  const createdAt = new Date().toISOString()
  // Measured as the old code laid the store out, so "before" rewrites a file the size the issue saw.
  for (let index = 0; JSON.stringify(aliases, null, 2).length < bytes; index += 1) {
    const id = randomUUID()
    aliases[id] = provider === 'claude'
      ? { ...template, sessionId: randomUUID(), title: `Other ${index}`, origins: Array.from({ length: 40 }, (_, turn) => ({
        messageId: randomUUID(), commandId: randomUUID(), uuid: randomUUID(), digest: synthetic(`${id}:${turn}`), createdAt })) }
      : { ...template, codexThreadId: randomUUID(), title: `Other ${index}`, origins: [], messageIdentities: Array.from({ length: 40 }, (_, turn) => ({
        turnId: randomUUID(), ordered: true, sealed: true, messages: (['user', 'assistant'] as const).map(role => ({
          id: randomUUID(), nativeIds: [randomUUID()], role, digest: synthetic(`${id}:${turn}:${role}`), createdAt, complete: true })) })) }
  }
  await writeFile(path, JSON.stringify(aliases))
}

/**
 * Makes `sends` manual sends to one new thread the way the Threads page does, through the window's own draft store
 * (its debounce included) and the coordinator over the real adapter and its fake client, and reports for each the
 * durable writes between the press and the prompt being written to the client. Each send after the first goes
 * to a session that is already running, which is the common case. Synthetic prompts only.
 */
export async function measureSendWrites(provider: 'claude' | 'codex', recorder: DurableWriteRecorder, sends = 3, storeBytes?: number): Promise<SendWrites[]> {
  const heard: number[] = []
  const restore: (() => void)[] = []
  if (provider === 'claude') {
    const write = ClaudeProtocol.prototype.write
    ClaudeProtocol.prototype.write = function (this: ClaudeProtocol, frame) {
      if ((frame as { type?: string }).type === 'user') heard.push(performance.now())
      return write.call(this, frame)
    }
    restore.push(() => { ClaudeProtocol.prototype.write = write })
  } else {
    const write = CodexProcess.prototype.write
    CodexProcess.prototype.write = function (this: CodexProcess, value: unknown) {
      if ((value as { method?: string }).method === 'turn/start') heard.push(performance.now())
      return write.call(this, value)
    }
    restore.push(() => { CodexProcess.prototype.write = write })
  }
  const f = provider === 'claude' ? await claudeFixture(undefined, 15_000) : await codexFixture(undefined, true, 15_000)
  const control = await manualSendCoordinator(f.root, f.host)
  const threadId = randomUUID()
  const results: SendWrites[] = []
  try {
    await f.host.connect()
    await f.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, title: 'Writes', path: f.root })
    await f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId, projectId: f.projectId, title: 'Writes', modelId: f.modelId })
    if (storeBytes !== undefined) {
      await growThreadStore(provider, f.root, 'registry' in f ? f.registry.byThread(threadId)!.sessionId : threadId, storeBytes)
      await f.host.connect()
    }
    await control.start(); await control.command({ type: 'connect' })
    await control.command({ type: 'observe-threads', threadIds: [threadId] })
    const command = (request: AgentCommand): Promise<AgentState | null> => control.command(request)
    const store = new ThreadDraftStore(command)
    for (let index = 0; index < sends; index += 1) {
      store.edit(threadId, { text: `Synthetic prompt ${index}` })
      await until(() => store.snapshot(threadId).save === 'saved', 'the typed draft to be saved')
      // Whatever the last reply set going lands before the press, so each send is measured on its own.
      await recorder.quiet()
      const start = performance.now()
      const already = heard.length
      // As the Threads page sends: main saves the revision the command carries.
      const draft = store.submit(threadId, start, 'send', 'main')!
      const result = await control.command({ type: 'manual-send', threadId, draftId: draft.draftId, text: draft.text })
      store.resolve(threadId, draft.draftId, result.error)
      if (result.error) throw new Error(`The send was refused: ${result.error}`)
      const at = heard[already]
      if (at === undefined) throw new Error('The prompt never reached the client.')
      results.push({ writes: recorder.since(start, at), bytes: recorder.bytesSince(start, at), ms: at - start })
      await f.driver.completeTurn(threadId, `Synthetic reply ${index}`)
      await until(() => control.get().deliveries?.find(item => item.draftId === draft.draftId)?.status === 'accepted'
        && control.get().host.threads.find(thread => thread.id === threadId)?.status === 'idle', 'the turn to finish')
    }
    return results
  } finally {
    control.dispose(); await control.privacyChanged(); await f.cleanup()
    for (const undo of restore) undo()
  }
}
