// @vitest-environment node
import { appendFile, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CodexSessionLogWatcher, promptDigest } from '../../../src/main/agents/codexSessionLog'
import { rolloutLine } from '../../fixtures/codexFixture'
import type { AgentMessage } from '../../../src/shared/agents'

vi.mock('node:fs/promises', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs/promises')>()
  return { ...fs, readdir: vi.fn(fs.readdir) }
})

const roots: string[] = []
const watchers: CodexSessionLogWatcher[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  vi.clearAllMocks()
  for (const watcher of watchers.splice(0)) await watcher.stop()
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes('sotto-codex-log-')) throw new Error('Unexpected temporary test directory')
    await rm(root, { recursive: true, force: true })
  }
})
describe('Codex session log', () => {
  it.each(['sent', 'sentDigest'] as const)('keeps a %s reset made during a missing-file search', async method => {
    const root = await mkdtemp(join(tmpdir(), 'sotto-codex-log-')); roots.push(root)
    const messages: AgentMessage[] = []
    const watcher = new CodexSessionLogWatcher({ codexHome: root, onMessage: (_id, message) => messages.push(message) })
    watchers.push(watcher); watcher.observe('thread')
    vi.spyOn(Date, 'now').mockReturnValue(0)
    let started!: () => void, release!: () => void
    const locating = new Promise<void>(resolve => { started = resolve })
    const held = new Promise<void>(resolve => { release = resolve })
    vi.mocked(readdir).mockImplementationOnce(async () => { started(); await held; return [] })
    const polling = watcher.poll()
    await locating
    watcher[method]('thread', 'own-client', method === 'sent' ? 'Own input' : promptDigest('Own input'))
    release()
    await polling
    const directory = join(root, 'sessions'); await mkdir(directory)
    await writeFile(join(directory, 'rollout-thread.jsonl'), rolloutLine(1, { type: 'user_message', id: 'new', message: 'Native input' }))
    await watcher.poll()
    expect(messages.map(message => message.id)).toEqual(['new'])
  })

  it.each(['sent', 'sentDigest'] as const)('resets missing-rollout discovery after %s', async method => {
    const root = await mkdtemp(join(tmpdir(), 'sotto-codex-log-')); roots.push(root)
    const messages: AgentMessage[] = []
    const watcher = new CodexSessionLogWatcher({ codexHome: root, onMessage: (_id, message) => messages.push(message) })
    watchers.push(watcher); watcher.observe('thread')
    const clock = vi.spyOn(Date, 'now').mockReturnValue(0)
    const reads = vi.mocked(readdir)
    for (const now of [0, 2000, 6000, 14000, 30000, 62000]) {
      clock.mockReturnValue(now)
      await watcher.poll()
    }
    clock.mockReturnValue(63000)
    watcher[method]('thread', 'own-client', method === 'sent' ? 'Own input' : promptDigest('Own input'))
    reads.mockClear()
    await watcher.poll()
    expect(reads).toHaveBeenCalledTimes(1)
    // A miss after sending starts again at two seconds, not one minute.
    const directory = join(root, 'sessions'); await mkdir(directory)
    await writeFile(join(directory, 'rollout-thread.jsonl'),
      rolloutLine(1, { type: 'user_message', id: 'own', client_id: 'own-client', message: 'Own input' }) +
      rolloutLine(2, { type: 'user_message', id: 'native', message: 'Native input' }))
    clock.mockReturnValue(64999)
    await watcher.poll()
    expect(messages).toHaveLength(0)
    clock.mockReturnValue(65000)
    await watcher.poll()
    expect(messages.map(message => message.id)).toEqual(['native'])
  })

  it('does not let repeated guarded misses postpone background discovery', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sotto-codex-log-')); roots.push(root)
    const messages: AgentMessage[] = []
    const watcher = new CodexSessionLogWatcher({ codexHome: root, onMessage: (_id, message) => messages.push(message) })
    watchers.push(watcher); watcher.observe('thread')
    const clock = vi.spyOn(Date, 'now').mockReturnValue(0)
    await watcher.poll()
    clock.mockReturnValue(1000)
    for (let i = 0; i < 10; i++) await watcher.pollThread('thread')
    const directory = join(root, 'sessions'); await mkdir(directory)
    await writeFile(join(directory, 'rollout-thread.jsonl'), rolloutLine(1, { type: 'user_message', id: 'new', message: 'Native input' }))
    clock.mockReturnValue(2000)
    await watcher.poll()
    expect(messages.map(message => message.id)).toEqual(['new'])
  })

  it('increases missing-file backoff up to one minute without making misses permanent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sotto-codex-log-')); roots.push(root)
    const watcher = new CodexSessionLogWatcher({ codexHome: root, onMessage: () => undefined })
    watchers.push(watcher); watcher.observe('thread')
    const clock = vi.spyOn(Date, 'now').mockReturnValue(0)
    const reads = vi.mocked(readdir)
    // The sessions directory itself is initially absent.
    await watcher.poll()
    let attempts = 1
    for (const due of [2000, 6000, 14000, 30000, 62000, 122000, 182000]) {
      clock.mockReturnValue(due - 1)
      await watcher.poll()
      expect(reads).toHaveBeenCalledTimes(attempts)
      clock.mockReturnValue(due)
      await watcher.poll()
      expect(reads).toHaveBeenCalledTimes(++attempts)
    }
    await mkdir(join(root, 'sessions'))
    await writeFile(join(root, 'sessions', 'rollout-thread.jsonl'), rolloutLine(1, { type: 'user_message', id: 'late', message: 'Late input' }))
    clock.mockReturnValue(242000)
    await watcher.poll()
    expect(reads).toHaveBeenCalledTimes(++attempts)
    await watcher.poll()
    expect(reads).toHaveBeenCalledTimes(attempts)
  })

  it('backs off missing rollouts, eventually discovers them, and keeps guarded reads fresh', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sotto-codex-log-')); roots.push(root)
    const directory = join(root, 'sessions', '2026', '09', '10'); await mkdir(directory, { recursive: true })
    const messages: AgentMessage[] = []
    const watcher = new CodexSessionLogWatcher({ codexHome: root, onMessage: (_id, message) => messages.push(message) })
    watchers.push(watcher); watcher.observe('missing'); watcher.observe('thread')
    vi.spyOn(Date, 'now').mockReturnValue(0)
    const reads = vi.mocked(readdir)
    await watcher.poll()
    expect(reads).toHaveBeenCalledTimes(8)
    for (let i = 0; i < 20; i++) await watcher.poll()
    expect(reads).toHaveBeenCalledTimes(8)

    const path = join(directory, 'rollout-thread.jsonl')
    await writeFile(path, rolloutLine(1, { type: 'user_message', id: 'first', message: 'Native input' }))
    vi.mocked(Date.now).mockReturnValue(1000)
    await watcher.poll()
    expect(messages).toHaveLength(0)
    vi.mocked(Date.now).mockReturnValue(2000)
    await watcher.poll()
    expect(messages.map(message => message.id)).toEqual(['first'])
    reads.mockClear()
    await appendFile(path, rolloutLine(2, { type: 'user_message', id: 'second', message: 'More input' }))
    await watcher.pollThread('thread')
    expect(reads).not.toHaveBeenCalled()
    expect(messages.map(message => message.id)).toEqual(['first', 'second'])

    // A guarded dispatch must see new evidence even while background discovery is backed off.
    await writeFile(join(directory, 'rollout-missing.jsonl'), rolloutLine(3, { type: 'user_message', id: 'guarded', message: 'External input' }))
    await watcher.pollThread('missing')
    expect(messages.at(-1)?.id).toBe('guarded')
  })

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
  it('recognizes nested native client receipts without hiding conflicting or foreign input', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sotto-codex-log-')); roots.push(root)
    const directory = join(root, 'sessions'); await mkdir(directory)
    const messages: AgentMessage[] = []
    const watcher = new CodexSessionLogWatcher({ codexHome: root, onMessage: (_id, message) => messages.push(message) })
    watchers.push(watcher); watcher.sent('thread', 'own-client', 'same')
    const receipt = (id: string, clientId: string, text = 'same', envelope?: string) => rolloutLine(1, {
      type: 'item_completed', ...(envelope ? { client_id: envelope } : {}),
      item: { type: 'UserMessage', id, client_id: clientId, content: [{ type: 'text', text }] },
    })
    await writeFile(join(directory, 'rollout-thread.jsonl'), receipt('own', 'own-client') + receipt('foreign', 'foreign-client')
      + receipt('changed', 'own-client', 'different') + receipt('conflict', 'own-client', 'same', 'foreign-client'))
    await watcher.pollThread('thread')
    expect(messages.map(message => message.id)).toEqual(['foreign', 'changed', 'conflict'])
    expect(messages.every(message => message.commandId === undefined)).toBe(true)
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
