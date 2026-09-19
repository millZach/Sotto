// @vitest-environment node
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CodexSessionLogWatcher } from '../../../src/main/agents/codexSessionLog'
import { rolloutLine } from '../../fixtures/codexFixture'
import type { AgentMessage } from '../../../src/shared/agents'

const roots: string[] = []
const watchers: CodexSessionLogWatcher[] = []
afterEach(async () => {
  for (const watcher of watchers.splice(0)) await watcher.stop()
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes('sotto-codex-log-')) throw new Error('Unexpected temporary test directory')
    await rm(root, { recursive: true, force: true })
  }
})
describe('Codex session log', () => {
  it('observes native image-only input while suppressing only an explicit own client receipt', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sotto-codex-log-')); roots.push(root)
    const directory = join(root, 'sessions'); await mkdir(directory)
    const messages: AgentMessage[] = []
    const watcher = new CodexSessionLogWatcher({ codexHome: root, onMessage: (_id, message) => messages.push(message) })
    watchers.push(watcher); watcher.sent('thread', 'own-client', '')
    await writeFile(join(directory, 'rollout-thread.jsonl'),
      rolloutLine(1, { type: 'user_message', message: '', images: ['synthetic'], client_id: 'own-client' }) +
      rolloutLine(2, { type: 'user_message', message: '', images: ['synthetic'.repeat(300_000)], client_id: 'foreign-client' }) +
      rolloutLine(3, { type: 'user_message', message: '', local_images: ['synthetic.png'] }) +
      rolloutLine(4, { type: 'item_completed', item: { type: 'UserMessage', id: 'native-image', content: [{ type: 'image', url: 'synthetic' }] } }) +
      rolloutLine(5, { type: 'user_message', message: '', images: [] }))
    await watcher.pollThread('thread')
    expect(messages).toHaveLength(3)
    expect(messages.every(message => message.text === '' && message.commandId === undefined)).toBe(true)
    await watcher.pollThread('thread')
    expect(messages).toHaveLength(3)
  })

  it('uses explicit client identity and never suppresses distinct native-authored repetitions as own input', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sotto-codex-log-')); roots.push(root)
    const directory = join(root, 'sessions'); await mkdir(directory)
    const path = join(directory, 'rollout-thread.jsonl')
    const messages: AgentMessage[] = []
    const watcher = new CodexSessionLogWatcher({ codexHome: root, onMessage: (_id, message) => messages.push(message) })
    watchers.push(watcher); watcher.sent('thread', 'own-client', 'same')
    await writeFile(path, rolloutLine(1, { type: 'user_message', message: 'same' }) +
      rolloutLine(2, { type: 'user_message', client_id: 'own-client', message: 'same' }) +
      rolloutLine(3, { type: 'user_message', client_id: 'native-client', message: 'same' }) +
      rolloutLine(4, { type: 'user_message', message: 'same' }))
    await watcher.pollThread('thread')
    expect(messages).toHaveLength(3)
    expect(new Set(messages.map(m => m.id)).size).toBe(3)
    expect(messages.every(m => m.commandId === undefined)).toBe(true)
  })
  it.each([false, true])('keeps legacy no-client spellings unowned until authoritative history corroborates identity, repeat=%s', async repeat => {
    const root = await mkdtemp(join(tmpdir(), 'sotto-codex-log-')); roots.push(root)
    const directory = join(root, 'sessions', '2026', '09', '10'); await mkdir(directory, { recursive: true })
    const path = join(directory, 'rollout-2026-09-10-thread.jsonl')
    const messages: AgentMessage[] = []
    const watcher = new CodexSessionLogWatcher({ codexHome: root, onMessage: (_id, message) => messages.push(message) })
    watchers.push(watcher); watcher.sent('thread', 'own', 'A')
    await writeFile(path, rolloutLine(1, { type: 'item_completed', item: { type: 'UserMessage', id: 'own-item', content: [{ type: 'text', text: 'A' }] } }) +
      rolloutLine(2, { type: 'user_message', message: 'A' }) + rolloutLine(3, { type: 'user_message', message: 'B' }))
    await watcher.poll()
    expect(messages.map(m => m.text)).toEqual(['A', 'A', 'B'])
    if (repeat) {
      messages.length = 0
      await appendFile(path, rolloutLine(4, { type: 'user_message', message: 'A' }))
      await watcher.poll()
      expect(messages.map(m => m.text)).toEqual(['A'])
    }
    expect(messages[0]!.commandId).toBeUndefined()
  })
  it('tails bytes across partial Unicode lines and ignores injected instructions without text-only suppression', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sotto-codex-log-')); roots.push(root)
    const directory = join(root, 'sessions', '2026', '09', '10'); await mkdir(directory, { recursive: true })
    const path = join(directory, 'rollout-2026-09-10-thread.jsonl')
    const messages: AgentMessage[] = []
    const watcher = new CodexSessionLogWatcher({ codexHome: root, pollIntervalMs: 10, onMessage: (_id, message) => messages.push(message) })
    watchers.push(watcher); watcher.observe('thread'); watcher.sent('thread', 'own', 'Hello 🌲')
    await writeFile(path, rolloutLine(1, { id: 'thread', cwd: root }, 'session_meta') + 'broken\n' +
      rolloutLine(2, { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'AGENTS instructions' }] }, 'response_item') +
      rolloutLine(3, { type: 'item_completed', item: { type: 'UserMessage', id: 'own-item', content: [{ type: 'text', text: 'Hello 🌲' }] } }) +
      rolloutLine(4, { type: 'message', role: 'assistant', content: [] }, 'response_item'))
    await watcher.poll()
    expect(messages).toHaveLength(1)
    const line = Buffer.from(rolloutLine(5, { type: 'user_message', message: 'Hello 🌲' }))
    const cut = line.indexOf(Buffer.from('🌲')) + 1
    await appendFile(path, line.subarray(0, cut)); await watcher.poll(); expect(messages).toHaveLength(1)
    await appendFile(path, line.subarray(cut)); await watcher.poll()
    expect(messages).toHaveLength(2)
    await watcher.poll(); expect(messages).toHaveLength(2)
    await appendFile(path, rolloutLine(6, { type: 'item_completed', item: { type: 'user_message', id: 'foreign', content: [{ type: 'text', text: 'CLI prompt' }] } }))
    await watcher.poll(); expect(messages.at(-1)).toMatchObject({ id: 'foreign', text: 'CLI prompt' }); expect(messages.every(m => m.commandId === undefined)).toBe(true)
  })
})
