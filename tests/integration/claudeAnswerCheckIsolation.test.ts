// @vitest-environment node
import { randomUUID } from 'node:crypto'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { expect, it, vi } from 'vitest'
import { claudeFixture } from '../fixtures/claudeFixture'
import type { ClaudeProtocol } from '../../src/main/agents/claudeProtocol'

it('checks only the selected Claude re-offer while preserving its neighboring re-offer and unresolved stdin write', async () => {
  let f = await claudeFixture()
  let release: () => void = () => undefined
  const id = randomUUID()
  const requests = async () => (await f.host.snapshot()).threads.find(thread => thread.id === id)!.requests
  const ask = async (requestId: string) => {
    await f.action(id, { type: 'question', requestId, text: 'Which color?' })
    await expect.poll(async () => (await requests()).some(request => request.id === requestId)).toBe(true)
  }
  const answer = (requestId: string) => ({ type: 'answer' as const, commandId: randomUUID(), threadId: id, requestId, answer: '',
    questionAnswers: { '0': { optionIds: ['Blue'] } } })
  try {
    await f.host.connect()
    await f.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, title: 'Project', path: f.root })
    await f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: id, projectId: f.projectId, modelId: f.modelId, title: 'Question' })
    for (const requestId of ['old-selected', 'old-neighbor']) {
      await ask(requestId); expect(await f.host.execute(answer(requestId))).toMatchObject({ accepted: true })
    }
    f = await f.driver.restart() as Awaited<ReturnType<typeof claudeFixture>>
    await f.host.connect(); await f.host.refreshThread!(id)
    await ask('old-selected'); await ask('old-neighbor'); await ask('unresolved')
    const runtime = (f.adapter as unknown as { runtimes: Map<string, { protocol: ClaudeProtocol }> }).runtimes.get(id)!
    const stdin = (runtime.protocol as unknown as { child: ChildProcessWithoutNullStreams }).child.stdin, write = stdin.write.bind(stdin)
    const delayed = vi.spyOn(stdin, 'write').mockImplementation(((chunk: string, callback?: (error?: Error | null) => void) => {
      if (!callback || (JSON.parse(chunk) as { type?: string }).type !== 'control_response') return write(chunk, callback)
      return write(chunk, error => { release = () => callback(error) })
    }) as typeof stdin.write)
    expect(await f.host.execute(answer('unresolved'))).toMatchObject({ accepted: false, uncertain: true })
    delayed.mockRestore()
    const checked = await f.host.refreshThread!(id, { retryUncertainAnswers: true, retryUncertainAnswerId: 'old-selected' })
    expect(checked.threads.find(thread => thread.id === id)!.requests).toMatchObject([
      { id: 'old-selected', answerRetryReady: true }, { id: 'old-neighbor', delivery: 'uncertain' }, { id: 'unresolved', delivery: 'uncertain' },
    ])
    expect((await requests())[0]).not.toHaveProperty('delivery')
    expect((await requests())[1]).not.toHaveProperty('answerRetryReady')
    const held = await f.host.refreshThread!(id, { retryUncertainAnswers: true, retryUncertainAnswerId: 'unresolved' })
    expect(held.threads.find(thread => thread.id === id)!.requests.slice(1)).toMatchObject([
      { id: 'old-neighbor', delivery: 'uncertain' }, { id: 'unresolved', delivery: 'uncertain' },
    ])
    expect((await f.driver.requests()).filter(record => record.method === 'control_response')).toHaveLength(3)
  } finally { release(); vi.restoreAllMocks(); await f.cleanup() }
})
