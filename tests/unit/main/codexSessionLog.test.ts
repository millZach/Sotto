// @vitest-environment node
import { appendFile, mkdir, mkdtemp, open, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CodexSessionLogWatcher, promptDigest, type RolloutPosition, type RolloutPositions } from '../../../src/main/agents/codexSessionLog'
import { browserFeedbackNote, carriesAttachedFiles } from '../../../src/main/agents/attachedFiles'
import { rolloutLine } from '../../fixtures/codexFixture'
import type { AgentMessage } from '../../../src/shared/agents'
import { deferred } from '../../fixtures/deferred'

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

    const { promise: locating, resolve: started } = deferred<void>()
    const { promise: held, resolve: release } = deferred<void>()
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

describe('a Point at something send read back from the rollout (ADR-0154)', () => {
  it('knows the feedback block on a send that carries only a picture is Sotto\'s, and does not show the prompt again', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sotto-codex-log-')); roots.push(root)
    const directory = join(root, 'sessions'); await mkdir(directory)
    const messages: AgentMessage[] = []
    const watcher = new CodexSessionLogWatcher({ codexHome: root, onMessage: (_id, message) => messages.push(message) })
    watchers.push(watcher)
    // The handle as the adapter is sent it: a picture carrying its feedback, with no file beside it.
    const picture = { name: 'button · Sign in', mimeType: 'image/png', browserFeedback: { label: 'button · Sign in', comment: 'Match the header', context: 'Selector: #sign-in' } }
    watcher.sent('thread', 'own-client', 'Look at this', carriesAttachedFiles([picture]))
    // Codex's rollout joins the input's text items, the feedback block among them.
    await writeFile(join(directory, 'rollout-thread.jsonl'), rolloutLine(1, { type: 'user_message', client_id: 'own-client', message: `Look at this\n\n${browserFeedbackNote([picture])}` }))
    await watcher.pollThread('thread')
    expect(messages).toEqual([])
  })
})

// Every saved thread's rollout was read from its first byte at every connect, 394 MB on the owner's machine (#992). A tail
// now saves where it read to, and a later run reads on from there; it must hold then what a read from the first byte holds.
describe('a Codex rollout read on from a saved position (#992)', () => {
  /** Saved positions kept here, each through JSON as the files keep them, so nothing is shared with the watcher. */
  class MemoryPositions implements RolloutPositions {
    readonly kept = new Map<string, string>()
    async list(): Promise<ReadonlySet<string>> { return new Set(this.kept.keys()) }
    async load(threadId: string): Promise<RolloutPosition | undefined> { const text = this.kept.get(threadId); return text === undefined ? undefined : JSON.parse(text) as RolloutPosition }
    async save(threadId: string, position: RolloutPosition): Promise<void> { this.kept.set(threadId, JSON.stringify(position)) }
    async remove(threadId: string): Promise<void> { this.kept.delete(threadId) }
  }
  async function rollout(): Promise<{ root: string; path: string }> {
    const root = await mkdtemp(join(tmpdir(), 'sotto-codex-log-')); roots.push(root)
    const directory = join(root, 'sessions'); await mkdir(directory)
    return { root, path: join(directory, 'rollout-thread.jsonl') }
  }
  /** A turn as Codex writes it, cut where `upTo` says: before the answer's native ID, or whole. */
  const turn = (index: number, upTo: 'answer' | 'whole' = 'whole'): string => {
    const id = `turn-${index}`
    const head = rolloutLine(index * 10, { turn_id: id }, 'turn_context') + rolloutLine(index * 10 + 1, { type: 'task_started', turn_id: id })
      + rolloutLine(index * 10 + 2, { type: 'user_message', id: `user-${index}`, message: `Question ${index}` })
      + rolloutLine(index * 10 + 3, { type: 'agent_message', message: `Answer ${index}` })
    return upTo === 'answer' ? head : head + rest(index)
  }
  const rest = (index: number): string => rolloutLine(index * 10 + 4, { type: 'message', role: 'assistant', id: `native-${index}`, content: [{ type: 'output_text', text: `Answer ${index}` }] }, 'response_item')
    + rolloutLine(index * 10 + 5, { type: 'task_complete', turn_id: `turn-${index}` })
  const watcher = (root: string, messages: AgentMessage[], extra: Partial<ConstructorParameters<typeof CodexSessionLogWatcher>[0]> = {}): CodexSessionLogWatcher => {
    const made = new CodexSessionLogWatcher({ codexHome: root, onMessage: (_id, message) => messages.push(message), ...extra })
    watchers.push(made); made.observe('thread'); return made
  }

  it('holds what a read from the first byte holds, after reading on from where a stopped watcher saved its place', async () => {
    const { root, path } = await rollout()
    const positions = new MemoryPositions()
    // Saved mid-turn, between an answer and its native ID, with half the next line written.
    const half = rest(3).slice(0, 40)
    await writeFile(path, turn(1) + turn(2) + turn(3, 'answer') + half)
    const before: AgentMessage[] = []
    const first = watcher(root, before, { positions })
    await first.pollThread('thread')
    await first.stop()
    expect(JSON.parse(positions.kept.get('thread')!)).toMatchObject({ offset: Buffer.byteLength(turn(1) + turn(2) + turn(3, 'answer')) })
    await appendFile(path, rest(3).slice(40) + turn(4) + turn(5))
    const after: AgentMessage[] = []
    const second = watcher(root, after, { positions })
    await second.pollThread('thread')
    const whole: AgentMessage[] = []
    const reference = watcher(root, whole)
    await reference.pollThread('thread')
    expect([...before, ...after].map(message => message.id)).toEqual(whole.map(message => message.id))
    expect(after.map(message => message.id)).toEqual(['user-4', 'user-5'])
    for (const index of [1, 2, 3, 4, 5]) expect(second.identities('thread', `turn-${index}`)).toEqual(reference.identities('thread', `turn-${index}`))
    expect(second.identities('thread', 'turn-3').find(row => row.role === 'assistant')?.nativeId).toBe('native-3')
  })

  it('reads from the first byte when its saved position names another file, or one shorter than it read', async () => {
    const { root, path } = await rollout()
    const positions = new MemoryPositions()
    await writeFile(path, turn(1) + turn(2))
    const first = watcher(root, [], { positions })
    await first.pollThread('thread')
    await first.stop()
    // Shorter than it read: Codex wrote the file again from its start.
    await writeFile(path, turn(7))
    const shorter: AgentMessage[] = []
    const second = watcher(root, shorter, { positions })
    await second.pollThread('thread')
    expect(shorter.map(message => message.id)).toEqual(['user-7'])
    await second.stop()
    // Another file put in its place, as long as the one read: it is not trusted. Written beside it first, so the two are
    // never one inode.
    await writeFile(`${path}.new`, `${turn(8)}${' '.repeat(Math.max(0, Buffer.byteLength(turn(7)) - Buffer.byteLength(turn(8)) - 1))}\n`)
    await rename(`${path}.new`, path)
    const replaced: AgentMessage[] = []
    const third = watcher(root, replaced, { positions })
    await third.pollThread('thread')
    if (JSON.parse(positions.kept.get('thread')!).ino) expect(replaced.map(message => message.id)).toEqual(['user-8'])
  })

  it('reads on each tick only the tails in use, once more after, a tail with no saved position until it catches up, and a failed read again', async () => {
    const { root, path } = await rollout()
    const positions = new MemoryPositions()
    await writeFile(path, turn(1))
    await writeFile(join(dirname(path), 'rollout-saved.jsonl'), turn(2))
    const first = watcher(root, [], { positions }); first.observe('saved')
    await first.poll()
    await first.stop()
    positions.kept.delete('thread')
    const inUse = new Set<string>()
    const second = watcher(root, [], { positions, inUse: () => inUse }); second.observe('saved')
    const read = vi.spyOn(second, 'pollThread')
    const tick = async (): Promise<string[]> => { read.mockClear(); await second.tick(); return read.mock.calls.map(([id]) => id).sort() }
    // A read for a connect or a snapshot reads only the tails in use, and waits on none catching up.
    read.mockClear(); await second.pollInUse()
    expect(read.mock.calls).toEqual([])
    // The tick reads the tail with no saved position until it catches up; the one with a saved position waits.
    expect(await tick()).toEqual(['thread'])
    expect(await tick()).toEqual([])
    inUse.add('saved')
    expect(await tick()).toEqual(['saved'])
    inUse.delete('saved')
    expect(await tick()).toEqual(['saved'])
    expect(await tick()).toEqual([])
    // A whole read still reads every tail.
    read.mockClear(); await second.poll()
    expect(read.mock.calls.map(([id]) => id).sort()).toEqual(['saved', 'thread'])
    // A read that fails is read again on the next tick, in use or not.
    await rm(join(dirname(path), 'rollout-saved.jsonl'))
    await mkdir(join(dirname(path), 'rollout-saved.jsonl'))
    inUse.add('saved'); await tick(); inUse.delete('saved')
    expect(await tick()).toEqual(['saved'])
  })

  it('saves no position past a line it read after stopping, so input it never reported is read again', async () => {
    const { root, path } = await rollout()
    const positions = new MemoryPositions()
    await writeFile(path, turn(1) + turn(2))
    const messages: AgentMessage[] = []
    const first = watcher(root, messages, { positions })
    // Stopped while a read of the rollout's bytes is on its way: the read is held until the watcher has stopped.
    const probe = await open(path, 'r')
    const handles = Object.getPrototypeOf(probe) as { read(...args: unknown[]): Promise<unknown> }
    await probe.close()
    const { promise: entered, resolve: enter } = deferred<void>()
    const { promise: held, resolve: release } = deferred<void>()
    const native = handles.read
    vi.spyOn(handles, 'read').mockImplementationOnce(async function (this: unknown, ...args: unknown[]) { enter(); await held; return native.apply(this, args) })
    const reading = first.pollThread('thread')
    await entered
    const stopping = first.stop()
    release()
    await reading; await stopping
    const reported = messages.map(message => message.id)
    const again: AgentMessage[] = []
    const second = watcher(root, again, { positions })
    await second.pollThread('thread')
    expect([...reported, ...again.map(message => message.id)]).toEqual(['user-1', 'user-2'])
  })

  it('looks for a rollout moved from where its position was saved, and reads on there when it is the same file', async () => {
    const { root, path } = await rollout()
    const positions = new MemoryPositions()
    await writeFile(path, turn(1))
    const first = watcher(root, [], { positions })
    await first.pollThread('thread')
    await first.stop()
    const moved = join(dirname(path), '2026', 'rollout-thread.jsonl')
    await mkdir(dirname(moved), { recursive: true })
    await rename(path, moved)
    await appendFile(moved, turn(2))
    const messages: AgentMessage[] = []
    const second = watcher(root, messages, { positions })
    await second.pollThread('thread')
    await second.pollThread('thread')
    expect(messages.map(message => message.id)).toEqual(['user-2'])
  })
})
