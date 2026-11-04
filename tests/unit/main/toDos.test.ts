import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { ToDoStore, ToDoRefused, type ToDoStoreOptions } from '../../../src/main/agents/toDos'
import { ToDoToolServer } from '../../../src/main/agents/toDoTools'
import { FollowupStore } from '../../../src/main/agents/followups'
import { foldWakeUpNews, isBabysitNews, isToDoNews, queuedWakeUpText, type WakeUpNews } from '../../../src/main/agents/wakeUp'
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
  test('a thread the host does not admit gets no server and adds nothing', async () => {
    const { store, tools } = await server(false)
    expect(await tools.mcpServer('t1')).toBeUndefined()
    expect((await tools.call('t1', 'add_to_do', { title: 'x' })).isError).toBe(true)
    expect(store.view()).toEqual([])
    await tools.close()
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
