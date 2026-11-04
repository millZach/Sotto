import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { ToDoStore, ToDoRefused, type ToDoStoreOptions } from '../../../src/main/agents/toDos'
import { ToDoAdder, ToDoToolServer, toDoWatcherDefinition } from '../../../src/main/agents/toDoTools'
import { WATCHER_SYSTEM_PROMPT, WATCHER_TO_DO_LINES, watcherSystemPrompt } from '../../../src/main/agents/watcherPrompt'
import { WatcherToolServer } from '../../../src/main/agents/watcherTools'
import type { WatcherService } from '../../../src/main/agents/watcher'
import { FollowupStore } from '../../../src/main/agents/followups'
import { foldWakeUpNews, isBabysitNews, isToDoNews, queuedWakeUpText, type WakeUpNews } from '../../../src/main/agents/wakeUp'
import { AtomicJsonStore } from '../../../src/main/storage/atomicJsonStore'
import { AGENT_TEXT_MAX } from '../../../src/shared/agents'
import { TO_DO_LIMIT, TO_DO_NOTE_MAX, TO_DOS_MAX, toDoAddSchema, type ToDo } from '../../../src/shared/toDos'
import { isOwlFeatureEnabled } from '../../../src/shared/owlFeatures'

const folders: string[] = []
afterEach(async () => { await Promise.all(folders.splice(0).map(folder => rm(folder, { recursive: true, force: true }))) })
const setup = async (history = true) => {
  const directory = await mkdtemp(join(tmpdir(), 'sotto-to-dos-'))
  folders.push(directory)
  const told = vi.fn<ToDoStoreOptions['told']>(async () => undefined)
  const on = { history }
  const make = () => new ToDoStore({ directory, historyEnabled: () => on.history, told })
  return { directory, told, on, make, store: make() }
}

describe('A computer keeps its own to-dos', () => {
  test('a thread adds one that names it, unread, and the same words again change nothing', async () => {
    const { store } = await setup()
    const first = await store.add({ title: 'Hand test links', steps: ['One', 'Two'], waits: true }, 'thread', 't1')
    const again = await store.add({ title: 'Hand test links', waits: true }, 'thread', 't1')
    expect(again.id).toBe(first.id)
    expect(store.view()).toHaveLength(1)
    expect(store.view()[0]).toMatchObject({ threadId: 't1', by: 'thread', waits: true, seen: false, steps: ['One', 'Two'] })
  })
  test('the same words from another thread are another to-do', async () => {
    const { store } = await setup()
    await store.add({ title: 'Listen' }, 'thread', 't1')
    await store.add({ title: 'Listen' }, 'thread', 't2')
    expect(store.view()).toHaveLength(2)
  })
  test('the user\'s own is seen already, so it lights no badge, and waits on nothing', async () => {
    const { store } = await setup()
    await store.request({ kind: 'add', title: 'Call the supplier' })
    expect(store.view()[0]).toMatchObject({ by: 'user', seen: true, waits: false })
    expect(store.view()[0]?.threadId).toBeUndefined()
  })
  test('opening the list marks everything seen once, whichever client opened it', async () => {
    const { store } = await setup()
    await store.add({ title: 'A' }, 'thread', 't1')
    await store.add({ title: 'B' }, 'thread', 't1')
    const heard = vi.fn()
    store.subscribe(heard)
    await store.request({ kind: 'seen' })
    expect(store.view().every(item => item.seen)).toBe(true)
    expect(heard).toHaveBeenCalledTimes(1)
    await store.request({ kind: 'seen' })
    expect(heard).toHaveBeenCalledTimes(1)
  })
  test('a full list refuses another and keeps what it holds', async () => {
    const { store } = await setup(false)
    for (let index = 0; index < TO_DOS_MAX; index++) await store.add({ title: `Item ${index}` }, 'thread', 't1')
    await expect(store.add({ title: 'One more' }, 'thread', 't1')).rejects.toBeInstanceOf(ToDoRefused)
    expect(store.view()).toHaveLength(TO_DOS_MAX)
  })
  test('a restart reads the list back while Keep local history is on', async () => {
    const { store, make } = await setup()
    await store.add({ title: 'Send Drake the notes', why: 'Ready to paste' }, 'thread', 't1')
    await store.drain()
    const again = make()
    await again.drain()
    expect(again.view()[0]).toMatchObject({ title: 'Send Drake the notes', why: 'Ready to paste', threadId: 't1' })
  })
  test('with Keep local history off nothing reaches the disk, and turning it off removes what was saved', async () => {
    const { store, directory, on } = await setup()
    await store.add({ title: 'Saved' }, 'thread', 't1')
    await store.drain()
    expect((await readdir(directory))).toContain('to-dos.json')
    on.history = false
    await store.privacyChanged()
    expect((await readdir(directory))).not.toContain('to-dos.json')
    await store.add({ title: 'Held only' }, 'thread', 't1')
    await store.drain()
    expect(await readdir(directory)).not.toContain('to-dos.json')
    expect(store.view()).toHaveLength(2)
  })
})

describe('A saved list that could not be read', () => {
  test('stands for nothing until it is read again by itself, and tells everyone when it is', async () => {
    const { directory, make } = await setup()
    const first = make()
    await first.add({ title: 'Saved' }, 'watcher')
    await first.drain()
    const read = vi.spyOn(AtomicJsonStore.prototype, 'read').mockRejectedValueOnce(new Error('The disk is busy.'))
    const store = new ToDoStore({ directory, historyEnabled: () => true, told: async () => undefined, readAgainMs: 5 })
    const heard = vi.fn()
    store.subscribe(heard)
    await store.drain()
    expect(store.notRead).toBe(true)
    expect(store.view()).toEqual([])
    await vi.waitFor(() => { expect(store.notRead).toBe(false) })
    read.mockRestore()
    expect(heard).toHaveBeenCalled()
    expect(store.view().map(item => item.title)).toEqual(['Saved'])
  })
  test('is not read at all with Keep local history off, so it stands for what is held', async () => {
    const { store } = await setup(false)
    expect(store.notRead).toBe(false)
    await store.drain()
    expect(store.notRead).toBe(false)
  })
})

describe('A list that holds to-dos Sotto made', () => {
  test('saves which were seen by ID alone, and reads them back after a restart', async () => {
    const { directory } = await setup()
    const seen = ['prototype-abc']
    const store = new ToDoStore({ directory, historyEnabled: () => true, told: async () => undefined, madeItemsSeen: () => true, madeSeenIds: () => seen })
    await store.request({ kind: 'seen' })
    const saved = JSON.parse(await readFile(join(directory, 'to-dos.json'), 'utf8')) as { items: unknown[]; madeSeen: string[] }
    expect(saved).toEqual({ items: [], madeSeen: ['prototype-abc'] })
    const restored = vi.fn()
    const again = new ToDoStore({ directory, historyEnabled: () => true, told: async () => undefined, restoreMadeSeen: restored })
    await again.drain()
    expect(restored).toHaveBeenCalledExactlyOnceWith(['prototype-abc'])
  })
  test('reads a list saved before there was anything to say of them', async () => {
    const { directory } = await setup()
    await writeFile(join(directory, 'to-dos.json'), JSON.stringify({ items: [] }))
    const store = new ToDoStore({ directory, historyEnabled: () => true, told: async () => undefined })
    await store.drain()
    expect(store.notRead).toBe(false)
  })
})

describe('Checking one off', () => {
  test('takes it off and tells only a thread that said it waits', async () => {
    const { store, told } = await setup()
    const waits = await store.add({ title: 'Hand test', waits: true }, 'thread', 't1')
    const not = await store.add({ title: 'Listen' }, 'thread', 't2')
    await store.request({ kind: 'check', id: not.id })
    expect(told).not.toHaveBeenCalled()
    await store.request({ kind: 'check', id: waits.id })
    expect(told).toHaveBeenCalledExactlyOnceWith('t1', 'Hand test', undefined)
    expect(store.view()).toEqual([])
  })
  test('carries the user\'s words when it did not work', async () => {
    const { store, told } = await setup()
    const item = await store.add({ title: 'Hand test', waits: true }, 'thread', 't1')
    await store.request({ kind: 'check', id: item.id, didNotWork: 'Opened in Sotto both times' })
    expect(told).toHaveBeenCalledExactlyOnceWith('t1', 'Hand test', 'Opened in Sotto both times')
  })
  test('a second press tells nobody twice', async () => {
    const { store, told } = await setup()
    const item = await store.add({ title: 'Hand test', waits: true }, 'thread', 't1')
    await store.request({ kind: 'check', id: item.id })
    await store.request({ kind: 'check', id: item.id })
    expect(told).toHaveBeenCalledTimes(1)
  })
  test('news that could not be kept leaves the item standing, and the press says so', async () => {
    const { store, told } = await setup()
    told.mockRejectedValueOnce(new Error('Could not save the follow-up queue.'))
    const item = await store.add({ title: 'Hand test', waits: true }, 'thread', 't1')
    await expect(store.request({ kind: 'check', id: item.id })).rejects.toThrow('Could not save')
    expect(store.view().map(entry => entry.id)).toEqual([item.id])
    await expect(store.request({ kind: 'check', id: item.id })).resolves.toBeUndefined()
    expect(store.view()).toEqual([])
  })
  test('a save that fails after the thread was told leaves the item standing, and the next press only saves', async () => {
    const { store, told } = await setup()
    const item = await store.add({ title: 'Hand test', waits: true }, 'thread', 't1')
    const save = vi.spyOn(AtomicJsonStore.prototype, 'write').mockRejectedValueOnce(new Error('The disk is full.'))
    await expect(store.request({ kind: 'check', id: item.id })).rejects.toThrow('The disk is full')
    expect(store.view().map(entry => entry.id)).toEqual([item.id])
    await store.request({ kind: 'check', id: item.id })
    save.mockRestore()
    expect(store.view()).toEqual([])
    expect(told).toHaveBeenCalledExactlyOnceWith('t1', 'Hand test', undefined)
  })
  test('words the user writes after a failed save still reach the thread', async () => {
    const { store, told } = await setup()
    const item = await store.add({ title: 'Hand test', waits: true }, 'thread', 't1')
    const save = vi.spyOn(AtomicJsonStore.prototype, 'write').mockRejectedValueOnce(new Error('The disk is full.'))
    await expect(store.request({ kind: 'check', id: item.id })).rejects.toThrow('The disk is full')
    await store.request({ kind: 'check', id: item.id, didNotWork: 'It opened twice' })
    save.mockRestore()
    expect(told.mock.calls).toEqual([['t1', 'Hand test', undefined], ['t1', 'Hand test', 'It opened twice']])
    expect(store.view()).toEqual([])
  })
  test('two presses at once tell the thread once', async () => {
    const { store, told } = await setup()
    const item = await store.add({ title: 'Hand test', waits: true }, 'thread', 't1')
    await Promise.all([store.request({ kind: 'check', id: item.id }), store.request({ kind: 'check', id: item.id })])
    expect(told).toHaveBeenCalledTimes(1)
  })
  test('a to-do with no thread never waits, whatever it says', async () => {
    const { store } = await setup()
    expect((await store.add({ title: 'Watcher\'s', waits: true }, 'watcher')).waits).toBe(false)
  })
  test('a prototype\'s to-do is made, not saved, and checking it lets the mark go', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sotto-to-dos-'))
    folders.push(directory)
    const made: ToDo[] = [{ id: 'prototype:t1:reply', title: 'Review the prototype', by: 'prototype', threadId: 't1', waits: false, seen: false, addedAt: '2026-11-03T00:00:00.000Z' }]
    const checked = vi.fn(() => { made.length = 0; return true })
    const store = new ToDoStore({ directory, historyEnabled: () => true, told: async () => undefined, madeItems: () => [...made], madeItemChecked: checked })
    await store.add({ title: 'Saved one' }, 'thread', 't2')
    expect(store.view().map(item => item.by)).toEqual(['thread', 'prototype'])
    await store.request({ kind: 'check', id: 'prototype:t1:reply' })
    expect(checked).toHaveBeenCalledWith('prototype:t1:reply')
    expect(store.view().map(item => item.by)).toEqual(['thread'])
    await store.drain()
    expect(await readFile(join(directory, 'to-dos.json'), 'utf8')).not.toContain('Review the prototype')
  })
})

describe('add_to_do', () => {
  const server = async (admits = true) => {
    const { store } = await setup(false)
    return { store, tools: new ToDoToolServer(store, { admits: () => admits }) }
  }
  test('adds for the calling thread and tells it not to repeat it', async () => {
    const { store, tools } = await server()
    const result = await tools.call('t1', 'add_to_do', { title: 'Run the walkthrough', link: { label: 'Open on YouTube', url: 'https://youtu.be/abc' } })
    expect(result.isError).toBeUndefined()
    expect(JSON.stringify(result.content)).toContain('Do not list it in your reply')
    expect(store.view()[0]).toMatchObject({ threadId: 't1', link: { label: 'Open on YouTube' }, waits: false })
    await tools.close()
  })
  test('refuses a link that is not a web address, and adds nothing', async () => {
    const { store, tools } = await server()
    expect(toDoAddSchema.safeParse({ title: 'x', link: { label: 'Run', url: 'javascript:alert(1)' } }).success).toBe(false)
    const result = await tools.call('t1', 'add_to_do', { title: 'x', link: { label: 'Open', url: 'file:///etc/passwd' } })
    expect(result.isError).toBe(true)
    expect(store.view()).toEqual([])
    await tools.close()
  })
  test('holds one thread to its limit, and another thread is still heard', async () => {
    const { store, tools } = await server()
    for (let index = 0; index < TO_DO_LIMIT; index++) await tools.call('t1', 'add_to_do', { title: `Item ${index}` })
    expect((await tools.call('t1', 'add_to_do', { title: 'Past it' })).isError).toBe(true)
    expect((await tools.call('t2', 'add_to_do', { title: 'Other thread' })).isError).toBeUndefined()
    expect(store.view()).toHaveLength(TO_DO_LIMIT + 1)
    await tools.close()
  })
  test('a retry of words it has open costs nothing against the limit', async () => {
    const { store, tools } = await server()
    for (let index = 0; index < TO_DO_LIMIT + 5; index++) expect((await tools.call('t1', 'add_to_do', { title: 'Same words' })).isError).toBeUndefined()
    expect((await tools.call('t1', 'add_to_do', { title: 'Different words' })).isError).toBeUndefined()
    expect(store.view()).toHaveLength(2)
    await tools.close()
  })
  test('a refused add costs nothing against the limit, so a thread is heard once the list has room', async () => {
    const { store, tools } = await server()
    await Promise.all(Array.from({ length: TO_DOS_MAX }, (_, index) => store.add({ title: `Filler ${index}` }, 'watcher')))
    for (let index = 0; index < TO_DO_LIMIT + 2; index++) {
      const refused = await tools.call('t1', 'add_to_do', { title: `Retry ${index}` })
      expect(refused.isError).toBe(true)
      expect(JSON.stringify(refused.content)).toContain(`already holds ${TO_DOS_MAX}`)
    }
    await store.request({ kind: 'check', id: store.view()[0]!.id })
    expect((await tools.call('t1', 'add_to_do', { title: 'There is room now' })).isError).toBeUndefined()
    await tools.close()
  })
  test('a refused add gives back its own slot, not one another call\'s add was kept on', async () => {
    let now = 1_000
    const waiting: { resolve: () => void; reject: (error: Error) => void }[] = []
    const added: string[] = []
    const store = { open: () => undefined, add: vi.fn((input: { title: string }) => new Promise((resolve, reject) => {
      waiting.push({ resolve: () => { added.push(input.title); resolve({}) }, reject })
    })) } as unknown as Pick<ToDoStore, 'add' | 'open'>
    const tools = new ToDoToolServer(store, { admits: () => true }, () => now)
    const first = tools.call('t1', 'add_to_do', { title: 'First' })
    now += 60_000
    const second = tools.call('t1', 'add_to_do', { title: 'Second' })
    await vi.waitFor(() => { expect(waiting).toHaveLength(2) })
    waiting[1]!.resolve()
    await second
    waiting[0]!.reject(new ToDoRefused('The list is full.'))
    expect((await first).isError).toBe(true)
    // The second's slot stands for its whole window: nine more fit in it, and the tenth is refused.
    now += 9.5 * 60_000
    for (let index = 0; index < TO_DO_LIMIT - 1; index++) {
      const call = tools.call('t1', 'add_to_do', { title: `More ${index}` })
      await vi.waitFor(() => { expect(waiting).toHaveLength(3 + index) })
      waiting[2 + index]!.resolve()
      expect((await call).isError).toBeUndefined()
    }
    expect((await tools.call('t1', 'add_to_do', { title: 'Past it' })).isError).toBe(true)
    await tools.close()
  })
  test('a thread the host does not admit gets no server and adds nothing', async () => {
    const { store, tools } = await server(false)
    expect(await tools.mcpServer('t1')).toBeUndefined()
    expect((await tools.call('t1', 'add_to_do', { title: 'x' })).isError).toBe(true)
    expect(store.view()).toEqual([])
    await tools.close()
  })
})

describe('add_to_do as Watcher has it', () => {
  const adder = async () => { const { store } = await setup(false); return { store, adder: new ToDoAdder(store) } }
  test('adds in Watcher\'s name, with no thread and no wait, and a retry changes nothing', async () => {
    const { store, adder: add } = await adder()
    const first = await add.forWatcher({ title: 'Send the invoice', steps: ['Open it', 'Send it'] })
    expect(first.isError).toBeUndefined()
    await add.forWatcher({ title: 'Send the invoice' })
    expect(store.view()).toEqual([expect.objectContaining({ title: 'Send the invoice', by: 'watcher', waits: false })])
    expect(store.view()[0]!.threadId).toBeUndefined()
  })
  test('refuses a wait, since Watcher has no thread to wait', async () => {
    const { store, adder: add } = await adder()
    expect((await add.forWatcher({ title: 'Send it', waits: true })).isError).toBe(true)
    expect(store.view()).toEqual([])
    expect(toDoWatcherDefinition.inputSchema).not.toHaveProperty('properties.waits')
  })
  test('holds Watcher to the same limit as a thread', async () => {
    const { store, adder: add } = await adder()
    for (let index = 0; index < TO_DO_LIMIT; index++) await add.forWatcher({ title: `Item ${index}` })
    const past = await add.forWatcher({ title: 'Past it' })
    expect(past.isError).toBe(true)
    expect(JSON.stringify(past.content)).toContain('You have added')
    expect(store.view()).toHaveLength(TO_DO_LIMIT)
  })
})

describe('What Watcher is offered (ADR-0188)', () => {
  const service = { isCurrent: () => true } as unknown as WatcherService
  const readState = (server: WatcherToolServer) => server.definitions.find(item => item.name === 'read_state') as { description: string; outputSchema: unknown }
  test('stable offers no to-do tool, and read_state says nothing of them', () => {
    const server = new WatcherToolServer(service)
    expect(server.definitions.map(item => item.name)).not.toContain('add_to_do')
    expect(JSON.stringify(readState(server))).not.toContain('toDos')
    expect(server.instructions).toBeUndefined()
  })
  test('with the list on it offers add_to_do, and read_state says it lists them', () => {
    const server = new WatcherToolServer(service, { toDos: { forWatcher: async () => ({ content: [] }) } })
    expect(server.definitions.map(item => item.name)).toContain('add_to_do')
    expect(JSON.stringify(readState(server).outputSchema)).toContain('toDos')
    expect(readState(server).description).toContain('Only what it and toDos list wait on the user')
    expect(readState(server).description).not.toContain('carry those separately')
    expect(server.instructions).toContain(WATCHER_TO_DO_LINES)
  })
})

describe('What Watcher is told (ADR-0188, decision 9)', () => {
  test('stable keeps its Needs you lines, whole and untouched', () => {
    expect(watcherSystemPrompt(false)).toBe(WATCHER_SYSTEM_PROMPT)
    expect(WATCHER_SYSTEM_PROMPT).toContain('Every reply you give the user names, under Needs you, each thing waitingOnUser lists, every time, until the user answers it.')
    expect(WATCHER_SYSTEM_PROMPT).not.toContain('add_to_do')
  })
  test('with the to-do list on, nothing tells Watcher to repeat what waits on the user', () => {
    const told = watcherSystemPrompt(false, false, false, false, false, true)
    expect(told).toContain(WATCHER_TO_DO_LINES)
    expect(told).not.toContain('Every reply you give the user names')
    expect(told).not.toContain('Never write Needs you: nothing')
    expect(told).not.toContain('carry the ask in your replies until the card is up')
    expect(told).toContain('call read_state: only what it lists waits on them')
    expect(told).toContain('You decide when a watched thread is finished')
  })
})

describe('The wake-up that tells a waiting thread', () => {
  test('says it in Sotto\'s voice, approves nothing, and labels the user\'s words as theirs', () => {
    expect(queuedWakeUpText([{ source: 'to-do', items: [{ title: 'Hand test' }] }], { tool: false })).toBe('Sotto: the user checked off your to-do "Hand test".\nThis approves nothing.')
    const note = queuedWakeUpText([{ source: 'to-do', items: [{ title: 'Hand test', didNotWork: 'Opened in "Sotto"' }] }], { tool: false })
    expect(note).toContain('Their words: "Opened in \\"Sotto\\""')
    expect(note).toContain('This approves nothing.')
  })
  test('folds into one piece of news, so a long list loses nothing to the queue\'s limit', () => {
    let news: WakeUpNews[] = [{ source: 'to-do', items: [{ title: 'Item 0' }] }]
    for (let index = 1; index < TO_DOS_MAX; index++) news = foldWakeUpNews(news, { source: 'to-do', items: [{ title: `Item ${index}` }] })
    expect(news).toHaveLength(1)
    expect(news.some(isBabysitNews)).toBe(false)
    const text = queuedWakeUpText(news, { tool: false })
    expect(text).toContain('"Item 0"')
    expect(text).toContain(`"Item ${TO_DOS_MAX - 1}"`)
  })
  test('counts what does not fit rather than cutting a line, and stays within a message', () => {
    const items = Array.from({ length: TO_DOS_MAX }, (_, index) => ({ title: `Item ${index}`, didNotWork: 'x'.repeat(TO_DO_NOTE_MAX) }))
    const text = queuedWakeUpText([{ source: 'to-do', items }], { tool: false })
    expect(text.length).toBeLessThan(AGENT_TEXT_MAX)
    expect(text).toMatch(/They also checked off \d+ more\./u)
    expect(text.endsWith('This approves nothing.')).toBe(true)
  })
})

describe('A waiting wake-up in the queue', () => {
  const queue = async (history: boolean) => {
    const directory = await mkdtemp(join(tmpdir(), 'sotto-to-do-queue-'))
    folders.push(directory)
    const store = new FollowupStore(directory, () => history)
    await store.load?.()
    return { directory, store }
  }
  const word = (news: readonly WakeUpNews[]) => queuedWakeUpText(news, { tool: false })
  const apart = (news: WakeUpNews) => isToDoNews(news) ? 'to-do' : 'other'
  test('never reaches the disk with Keep local history off', async () => {
    const { directory, store } = await queue(false)
    await store.queueWakeUp('t1', { source: 'to-do', items: [{ title: 'Secret title', didNotWork: 'Secret words' }] }, word, 'turn-1', apart)
    expect(store.peek().items).toHaveLength(1)
    expect(await readFile(join(directory, 'followups.json'), 'utf8').catch(() => '')).not.toContain('Secret')
  })
  test('is saved while Keep local history is on', async () => {
    const { directory, store } = await queue(true)
    await store.queueWakeUp('t1', { source: 'to-do', items: [{ title: 'Kept title' }] }, word, 'turn-1', apart)
    expect(await readFile(join(directory, 'followups.json'), 'utf8')).toContain('Kept title')
  })
  test('waits apart, so other news is not lost with it and two check-offs share one', async () => {
    const { store } = await queue(true)
    await store.queueWakeUp('t1', { pullRequest: { url: 'https://github.com/o/r/pull/1', number: 1, title: 'One' }, startedBy: 'agent', head: 'h', changes: [], ended: null }, word, 'turn-1', apart)
    await store.queueWakeUp('t1', { source: 'to-do', items: [{ title: 'A' }] }, word, 'turn-1', apart)
    await store.queueWakeUp('t1', { source: 'to-do', items: [{ title: 'B' }] }, word, 'turn-1', apart)
    const toDoItems = store.peek().items.filter(item => item.news?.some(isToDoNews))
    expect(store.peek().items).toHaveLength(2)
    expect(toDoItems).toHaveLength(1)
    expect(toDoItems[0]!.text).toContain('"B"')
  })
})

test('it is an Owl feature that stable keeps off until Zach sends it', () => {
  expect(isOwlFeatureEnabled('to-do-list', 'owl')).toBe(true)
  expect(isOwlFeatureEnabled('to-do-list', 'stable')).toBe(false)
})
