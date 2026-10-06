// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { CodexAppServerHost } from '../../src/main/agents/codex'
import { CodexProcess, type RpcFrame } from '../../src/main/agents/codexProcess'
import type { ThreadHostEvent } from '../../src/main/agents/host'
import { codexFixture } from '../fixtures/codexFixture'
import { recordDurableWrites, type DurableWriteRecorder } from '../fixtures/durableWrites'
import { measureSendWrites } from '../fixtures/sendWritesWorkload'

// Issue #767. Every durable write between Send and the provider hearing the prompt is one the user waits on.
// What is left is what the guarantees need: the coordinator's outbox entry, so a prompt is never sent twice after
// a crash, and the adapter's origin, so no prompt the provider took is left without Sotto's record of sending it.
let recorder: DurableWriteRecorder
beforeAll(() => { recorder = recordDurableWrites() })
afterAll(() => { recorder.restore() })

it('makes one write of agents.json and one synced origin line between Send and Claude Code hearing the prompt', async () => {
  const sends = await measureSendWrites('claude', recorder)
  // Before #767: three writes of agents.json (the window's save of the draft, admission and the outbox entry), a
  // fourth when the send outlasted the window's 250 ms save of the emptied composer, and a rewrite of the whole
  // claude-threads.json for the origin. docs/perf/2026-10-06-send-writes.md has the figures.
  for (const send of sends) expect(send.writes).toEqual({ 'agents.json': 1, 'claude-origins.jsonl': 1 })
})

it('makes one write of agents.json and one of codex-threads.json between Send and turn/start on a running session', async () => {
  const sends = await measureSendWrites('codex', recorder)
  // The first send also starts the thread's session, which records it; every send after it is the common case.
  // Before #767 the coordinator wrote agents.json three times here too.
  for (const send of sends.slice(1)) expect(send.writes).toEqual({ 'agents.json': 1, 'codex-threads.json': 1 })
})

it('shows a Codex reply’s words while a save of the thread store is held open', async () => {
  const f = await codexFixture(undefined, false, 15_000)
  const threadId = randomUUID()
  try {
    await f.host.connect()
    await f.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, title: 'Held', path: f.root })
    await f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId, projectId: f.projectId, title: 'Held', modelId: f.modelId })
    expect(await f.host.execute({ type: 'send', threadId, commandId: randomUUID(), messageId: randomUUID(), text: 'Synthetic prompt' })).toMatchObject({ accepted: true })
    const words = 'Synthetic words while the store is held'
    const seen: ThreadHostEvent[] = []
    const unsubscribe = f.adapter.subscribeEvents(event => { if (JSON.stringify(event).includes(words)) seen.push(event) })
    const heldFrom = performance.now()
    const release = recorder.hold('codex-threads.json')
    try {
      await f.driver.completeTurn(threadId, words)
      await expect.poll(() => seen.length, { timeout: 15_000 }).toBeGreaterThan(0)
      // A save of the thread store had started and was still held when the words arrived.
      expect(recorder.since(heldFrom)['codex-threads.json']).toBeGreaterThan(0)
    } finally { release(); unsubscribe() }
  } finally { await f.cleanup() }
})

it('applies the frames behind a turn/start response while that response’s save of the thread store is held', async () => {
  const f = await codexFixture(undefined, false, 15_000)
  const threadId = randomUUID()
  const write = CodexProcess.prototype.write
  type Frames = { frame(this: CodexAppServerHost, from: CodexProcess, frame: RpcFrame): Promise<void> }
  const prototype = CodexAppServerHost.prototype as unknown as Frames
  const frame = prototype.frame
  let release: (() => void) | undefined
  try {
    await f.host.connect()
    await f.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, title: 'Held', path: f.root })
    await f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId, projectId: f.projectId, title: 'Held', modelId: f.modelId })
    const applied: string[] = []
    prototype.frame = function (this: CodexAppServerHost, from: CodexProcess, value: RpcFrame) {
      if (value.method) applied.push(value.method)
      return frame.call(this, from, value)
    }
    // Every save of the thread store from the moment the prompt is written is held: the response's save among them.
    CodexProcess.prototype.write = function (this: CodexProcess, value: unknown) {
      if ((value as { method?: string }).method === 'turn/start') release ??= recorder.hold('codex-threads.json')
      return write.call(this, value)
    }
    let settled = false
    const sending = f.host.execute({ type: 'send', threadId, commandId: randomUUID(), messageId: randomUUID(), text: 'Synthetic prompt' }).finally(() => { settled = true })
    // The fake took the prompt and answered it; the reply it streams now comes in behind that answer.
    await expect.poll(async () => (await f.driver.requests()).some(record => record.method === 'turn/start'), { timeout: 15_000 }).toBe(true)
    await f.driver.completeTurn(threadId, 'Synthetic reply')
    await expect.poll(() => applied, { timeout: 15_000 }).toContain('turn/completed')
    // The send itself still waits for the save; the frames behind its response did not.
    expect(settled).toBe(false)
    release?.()
    expect(await sending).toMatchObject({ accepted: true })
  } finally { prototype.frame = frame; CodexProcess.prototype.write = write; release?.(); await f.cleanup() }
})
