// @vitest-environment node
import { randomUUID } from 'node:crypto'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { expect, it, vi } from 'vitest'
import { grokFixture } from '../fixtures/fakeGrokThreadFixture'
import type { GrokRpc } from '../../src/main/agents/grokRpc'

async function question(f: Awaited<ReturnType<typeof grokFixture>>, id: string) {
  await f.driver.raiseQuestion(id, 'Which color?')
  const requests = async () => (await f.host.snapshot()).threads.find(thread => thread.id === id)?.requests
  await expect.poll(async () => (await requests())?.length).toBe(1)
  return (await requests())![0]!
}
async function thread(f: Awaited<ReturnType<typeof grokFixture>>) {
  await f.host.connect()
  await f.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, title: 'Project', path: f.root })
  const id = randomUUID()
  await f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: id, projectId: f.projectId, modelId: f.modelId, title: 'Question' })
  return id
}
function answer(threadId: string, requestId: string) {
  return { type: 'answer' as const, commandId: randomUUID(), threadId, requestId, answer: '', questionAnswers: { '0': { optionIds: [], text: 'Blue' } } }
}

it('releases a Grok restart re-offer only after an explicit native Check, without sending an answer', async () => {
  let f = await grokFixture()
  let release: () => void = () => undefined
  try {
    const id = await thread(f), original = await question(f, id)
    expect(await f.host.execute(answer(id, original.id))).toMatchObject({ accepted: true })
    const originalNeighbor = await question(f, id)
    expect(await f.host.execute(answer(id, originalNeighbor.id))).toMatchObject({ accepted: true })
    f = await f.driver.restart()
    await f.host.connect(); await f.host.refreshThread(id)
    const reoffered = await question(f, id)
    expect(reoffered).toMatchObject({ id: original.id, delivery: 'uncertain' })
    await f.driver.raiseQuestion(id, 'Which color?')
    await expect.poll(async () => (await f.host.snapshot()).threads.find(thread => thread.id === id)?.requests.length).toBe(2)
    await f.driver.raiseQuestion(id, 'Another question?')
    await expect.poll(async () => (await f.host.snapshot()).threads.find(thread => thread.id === id)?.requests.length).toBe(3)
    const current = (await f.host.snapshot()).threads.find(thread => thread.id === id)!.requests[2]!
    const rpc = (f.adapter as unknown as { processes: Map<string, { rpc: GrokRpc }> }).processes.get(id)!.rpc
    const stdin = (rpc as unknown as { child: ChildProcessWithoutNullStreams }).child.stdin, write = stdin.write.bind(stdin)
    const delayed = vi.spyOn(stdin, 'write').mockImplementation(((chunk: string, callback?: (error?: Error | null) => void) => {
      if (!callback || !(JSON.parse(chunk) as { result?: unknown }).result) return write(chunk, callback)
      return write(chunk, error => { release = () => callback(error) })
    }) as typeof stdin.write)
    expect(await f.host.execute(answer(id, current.id))).toMatchObject({ accepted: false, uncertain: true })
    delayed.mockRestore()
    const before = await f.driver.requests()
    const ordinary = await f.host.refreshThread(id)
    expect(ordinary.threads.find(thread => thread.id === id)!.requests[0]).toMatchObject({ delivery: 'uncertain' })
    const checked = await f.host.refreshThread(id, { retryUncertainAnswers: true, retryUncertainAnswerId: original.id })
    expect(checked.threads.find(thread => thread.id === id)!.requests[0]).toMatchObject({ id: original.id, answerRetryReady: true })
    expect(checked.threads.find(thread => thread.id === id)!.requests[0]).not.toHaveProperty('delivery')
    expect(checked.threads.find(thread => thread.id === id)!.requests[1]).toMatchObject({ id: originalNeighbor.id, delivery: 'uncertain' })
    expect(checked.threads.find(thread => thread.id === id)!.requests[1]).not.toHaveProperty('answerRetryReady')
    expect(checked.threads.find(thread => thread.id === id)!.requests[2]).toMatchObject({ id: current.id, delivery: 'uncertain' })
    const unresolved = await f.host.refreshThread(id, { retryUncertainAnswers: true, retryUncertainAnswerId: current.id })
    expect(unresolved.threads.find(thread => thread.id === id)!.requests.slice(1)).toMatchObject([
      { id: originalNeighbor.id, delivery: 'uncertain' }, { id: current.id, delivery: 'uncertain' },
    ])
    expect((await f.driver.requests()).filter(record => record.result?.outcome)).toEqual(before.filter(record => record.result?.outcome))
    expect(await f.host.execute(answer(id, original.id))).toMatchObject({ accepted: true })
    expect((await f.host.snapshot()).threads.find(thread => thread.id === id)!.requests).toMatchObject([
      { id: originalNeighbor.id, delivery: 'uncertain' }, { id: current.id, delivery: 'uncertain' },
    ])
  } finally { release(); vi.restoreAllMocks(); await f.cleanup() }
})

it('does not release a Grok answer whose stdin completion is still unresolved after its deadline', async () => {
  const f = await grokFixture()
  let release: () => void = () => undefined
  try {
    const id = await thread(f), pending = await question(f, id)
    const rpc = (f.adapter as unknown as { processes: Map<string, { rpc: GrokRpc }> }).processes.get(id)!.rpc
    const stdin = (rpc as unknown as { child: ChildProcessWithoutNullStreams }).child.stdin
    const write = stdin.write.bind(stdin)
    const delayed = vi.spyOn(stdin, 'write').mockImplementation(((chunk: string, callback?: (error?: Error | null) => void) => {
      if (!callback || !(JSON.parse(chunk) as { result?: unknown }).result) return write(chunk, callback)
      return write(chunk, error => { release = () => callback(error) })
    }) as typeof stdin.write)
    expect(await f.host.execute(answer(id, pending.id))).toMatchObject({ accepted: false, uncertain: true })
    delayed.mockRestore()
    const checked = await f.host.refreshThread(id, { retryUncertainAnswers: true })
    expect(checked.threads.find(thread => thread.id === id)!.requests[0]).toMatchObject({ id: pending.id, delivery: 'uncertain' })
    expect(checked.threads.find(thread => thread.id === id)!.requests[0]).not.toHaveProperty('answerRetryReady')
    expect(await f.host.execute(answer(id, pending.id))).toMatchObject({ accepted: false, uncertain: true })
    expect((await f.driver.requests()).filter(record => record.result?.outcome)).toHaveLength(1)
  } finally { release(); vi.restoreAllMocks(); await f.cleanup() }
})

it('shows a same-ID Grok re-offer after its child restarts inside the connected adapter', async () => {
  const f = await grokFixture()
  try {
    const id = await thread(f), original = await question(f, id)
    expect(await f.host.execute(answer(id, original.id))).toMatchObject({ accepted: true })
    await expect.poll(async () => (await f.driver.requests()).filter(record => record.result?.outcome).length).toBe(1)
    const rpc = (f.adapter as unknown as { processes: Map<string, { rpc: GrokRpc }> }).processes.get(id)!.rpc
    const child = (rpc as unknown as { child: ChildProcessWithoutNullStreams }).child
    child.kill(); await rpc.closed
    expect((await f.host.snapshot()).connected).toBe(true)
    await f.host.refreshThread(id)
    const reoffered = await question(f, id)
    expect(reoffered).toMatchObject({ id: original.id, delivery: 'uncertain' })
    const checked = await f.host.refreshThread(id, { retryUncertainAnswers: true, retryUncertainAnswerId: reoffered.id })
    expect(checked.threads.find(thread => thread.id === id)!.requests[0]).toMatchObject({ id: original.id, answerRetryReady: true })
    expect((await f.driver.requests()).filter(record => record.result?.outcome)).toHaveLength(1)
  } finally { await f.cleanup() }
})
