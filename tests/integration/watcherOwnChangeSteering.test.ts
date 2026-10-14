// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { watcherOwnChanges } from '../../src/main/agents/watcherOwnChanges'
import { claudeFixture } from '../fixtures/claudeFixture'

const fixtures: Awaited<ReturnType<typeof claudeFixture>>[] = []
afterEach(async () => { for (const fixture of fixtures.splice(0).reverse()) await fixture.cleanup() })

it('keeps Watcher edits before and after a folded Claude steer on the original turn reply', async () => {
  const f = await claudeFixture(undefined, 15_000)
  fixtures.push(f)
  await writeFile(join(f.root, 'script.json'), JSON.stringify({ steering: true }))
  f.host.useLaunchProfiles!({ profileFor: async () => ({ kind: 'watcher',
    server: { name: 'sotto_threads', type: 'http', url: 'http://127.0.0.1:12345/mcp', headers: [] },
    toolNames: ['list_threads'], revoke: () => undefined }) })
  await f.host.connect()
  await f.host.execute({ type: 'create-project', commandId: 'project', projectId: f.projectId, title: 'Watcher steering', path: f.root })
  await f.host.execute({ type: 'create-thread', commandId: 'create', threadId: 'watcher', projectId: f.projectId, title: 'Watcher', modelId: f.modelId })
  await f.host.execute({ type: 'send', commandId: 'send', messageId: 'original', threadId: 'watcher', text: 'Coordinate' })
  const thread = async () => (await f.host.snapshot()).threads.find(thread => thread.id === 'watcher')!
  const edit = async (id: string, path: string) => f.action('watcher', { type: 'raw', persist: true,
    frame: { type: 'assistant', uuid: randomUUID(), parent_tool_use_id: null,
      message: { id: randomUUID(), role: 'assistant', content: [{ type: 'tool_use', id, name: 'Edit', input: { file_path: path, old_string: 'before', new_string: 'after' } }] } } })
  const finishEdit = async (id: string) => f.action('watcher', { type: 'raw', persist: true,
    frame: { type: 'user', uuid: randomUUID(), parent_tool_use_id: null,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'Changed' }] } } })
  const before = join(f.root, 'before-steer.ts'), after = join(f.root, 'after-steer.ts')
  await edit('before', before)
  await expect.poll(async () => (await thread()).activities?.find(activity => activity.id === 'claude-tool-before')?.status).toBe('running')
  expect(await f.host.execute({ type: 'steer', commandId: 'steer', messageId: 'steer', threadId: 'watcher', text: 'Also this' })).toEqual({ accepted: true })
  await finishEdit('before')
  await expect.poll(async () => (await thread()).activities?.find(activity => activity.id === 'claude-tool-before')?.status).toBe('completed')
  await f.action('watcher', { type: 'say', text: 'Continuing the same turn.' })
  await edit('after', after); await finishEdit('after')
  await f.driver.completeTurn('watcher', 'Watcher change reason: Needed for coordination.')
  await expect.poll(async () => { const current = await thread(); return { status: current.status, lastTurn: current.lastTurn, notice: current.requestNotice,
    historyError: current.historyError, turns: current.activities?.filter(activity => activity.kind === 'turn').map(({ turnId, status, error }) => ({ turnId, status, error })) } })
    .toEqual({ status: 'idle', lastTurn: { id: expect.any(String), messageId: 'original', status: 'completed' }, notice: undefined, historyError: undefined,
      turns: [{ turnId: 'original', status: 'completed', error: undefined }] })
  const completed = await thread()
  expect(completed.messages.filter(message => message.role === 'user').map(message => message.id)).toEqual(['original', 'steer'])
  expect(completed.activities?.filter(activity => activity.kind === 'turn').map(activity => [activity.turnId, activity.status])).toEqual([['original', 'completed']])
  expect(completed.lastTurn).toMatchObject({ messageId: 'original', status: 'completed' })
  expect(watcherOwnChanges(completed)).toEqual([{ replyMessageId: completed.messages.findLast(message => message.role === 'assistant')!.id,
    turnId: 'original', files: [before, after], fileCount: 2, reason: 'Needed for coordination.', source: 'provider-file-change' }])
})
