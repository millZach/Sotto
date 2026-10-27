import { describe, expect, it } from 'vitest'

import type { AgentActivity } from '../../../src/shared/agentActivity'
import { sottoBrowserToolOfTitle } from '../../../src/shared/sottoBrowserTools'
import type { AgentMessage } from '../../../src/shared/agents'
import {
  BrowserLinesStore, browserLineName, browserLinesByTurn, browserRunHost, browserRunWords, browserStep, browserStepWords, foldBrowserRuns, goingRunKey, PLACE,
  plainWords, sentenceWords, turnBrowserLines, type BrowserRun, type BrowserStep,
} from '../../../src/renderer/src/agents/browserLine'
import { nestActivities } from '../../../src/renderer/src/agents/threadActivityView'

// The browser line (ADR-0154; Owl only): a turn's calls to Sotto's own browser fold into one line.
let sequence = 0
const record = (patch: Partial<AgentActivity> & Pick<AgentActivity, 'id'>): AgentActivity =>
  ({ turnId: 'turn-1', sequence: sequence++, kind: 'tool', status: 'completed', title: 'Tool', ...patch })
/** Claude Code names a call `mcp__sotto_browser__<tool>` and reports its input as JSON. */
const claude = (id: string, tool: string, input: unknown, patch: Partial<AgentActivity> = {}): AgentActivity =>
  record({ id, title: `mcp__sotto_browser__${tool}`, text: JSON.stringify(input), ...patch })
const lines = (records: readonly AgentActivity[]) => turnBrowserLines(browserLinesByTurn(records), 'turn-1')
const runs = (records: readonly AgentActivity[]): readonly BrowserRun[] => lines(records).runs
const browserStepSentence = (step: BrowserStep): string => plainWords(sentenceWords(browserStepWords(step)))
const said = (run: BrowserRun, going: boolean): { headline: string; detail: string } => {
  const words = browserRunWords(run, going)
  return { headline: plainWords(words.headline), detail: plainWords(words.detail) }
}

describe('which records are calls to Sotto\'s browser', () => {
  it('knows each client\'s spelling of the eleven tools, and nothing else', () => {
    expect(sottoBrowserToolOfTitle('mcp__sotto_browser__browser_action')).toBe('browser_action')
    expect(sottoBrowserToolOfTitle('sotto_browser__browser_open')).toBe('browser_open')
    expect(sottoBrowserToolOfTitle('sotto_browser / iphone_cloud_tap')).toBeUndefined()
    expect(sottoBrowserToolOfTitle('sotto_browser / iphone_cloud_action')).toBe('iphone_cloud_action')
    expect(sottoBrowserToolOfTitle('sotto_browser_browser_finish')).toBe('browser_finish')
    // Muse names each thread's server with a suffix of its own (museSessionServerName).
    expect(sottoBrowserToolOfTitle('mcp__sotto_browser_3fa9c01b7e__browser_open')).toBe('browser_open')
    expect(sottoBrowserToolOfTitle('sotto_browser_3fa9c01b7e__iphone_cloud_action')).toBe('iphone_cloud_action')
    expect(sottoBrowserToolOfTitle('mcp__sotto_browser_3fa9c01b7e__browser_delete')).toBeUndefined()
    expect(sottoBrowserToolOfTitle('mcp__sotto_delegate_3fa9c01b7e__browser_open')).toBeUndefined()
    // Someone else's server, or a tool Sotto does not own, keeps its row.
    expect(sottoBrowserToolOfTitle('mcp__playwright__browser_click')).toBeUndefined()
    expect(sottoBrowserToolOfTitle('mcp__sotto_browser__browser_delete')).toBeUndefined()
    expect(sottoBrowserToolOfTitle('Bash')).toBeUndefined()
  })

  it('reads a Muse call as Claude Code\'s, by its suffixed server', () => {
    const open = record({ id: 'm', title: 'mcp__sotto_browser_3fa9c01b7e__browser_open', text: JSON.stringify({ url: 'http://localhost:5173/' }) })
    expect(browserStepSentence(browserStep(open)!)).toBe('Opened localhost:5173')
    expect(runs([open])).toHaveLength(1)
  })

  it('reads only tool records', () => {
    expect(browserStep(record({ id: 'c', kind: 'command', title: 'mcp__sotto_browser__browser_open' }))).toBeNull()
  })
})

describe('the steps in plain words, per provider', () => {
  it('reads Claude Code\'s and Grok\'s input', () => {
    const steps = [
      claude('a', 'browser_open', { url: 'http://localhost:5173/', description: 'Check sign-in' }),
      claude('b', 'browser_action', { taskId: 't', action: { type: 'click', x: 1, y: 2 } }),
      claude('c', 'browser_action', { taskId: 't', action: { type: 'type', text: 'zach@example.com' } }),
      claude('d', 'browser_action', { taskId: 't', action: { type: 'key', key: 'Enter' } }),
      claude('e', 'browser_action', { taskId: 't', action: { type: 'inspect' } }),
      claude('f', 'browser_action', { taskId: 't', action: { type: 'screenshot' } }),
      claude('g', 'browser_action', { taskId: 't', action: { type: 'navigate', url: 'http://localhost:5173/notes?x=1' } }),
      record({ id: 'h', title: 'sotto_browser__browser_action', text: JSON.stringify({ action: { type: 'scroll', x: 0, y: 0, deltaX: 0, deltaY: 400 } }) }),
      claude('i', 'iphone_open', { url: 'http://localhost:8081' }),
      claude('j', 'browser_action', { action: { type: 'tap', x: 1, y: 1 } }),
      claude('k', 'browser_action', { action: { type: 'swipe', x: 1, y: 1, toX: 1, toY: 90 } }),
    ].map(item => browserStepSentence(browserStep(item)!))
    expect(steps).toEqual([
      'Opened localhost:5173', 'Clicked in the page', 'Typed into the page', 'Pressed Enter', 'Looked at the page',
      'Took a picture of the page', 'Went to localhost:5173/notes', 'Scrolled the page', 'Opened localhost:8081 on the test iPhone',
      'Tapped in the page', 'Swiped in the page',
    ])
  })

  it('reads Codex\'s calls, which carry no input, from the task Sotto\'s browser answered with', () => {
    const answered = (action: string, url: string): string => JSON.stringify({ task: { id: 't', steps: [
      { id: '1', action: 'navigate', status: 'completed', at: 1, detail: '', url: 'http://localhost:5173/' },
      { id: '2', action, status: 'completed', at: 2, detail: '', url },
    ] }, approvalRequired: false })
    const open = record({ id: 'o', title: 'sotto_browser / browser_open', output: answered('navigate', 'http://localhost:5173/') })
    const click = record({ id: 'c', title: 'sotto_browser / browser_action', output: answered('click', 'http://localhost:5173/sign-in') })
    const status = record({ id: 's', title: 'sotto_browser / browser_status' })
    expect([open, click, status].map(item => browserStepSentence(browserStep(item)!))).toEqual(['Opened localhost:5173', 'Clicked in the page', 'Checked the browser task'])
    // A click names no host: only an open or a navigation does.
    expect(browserStep(click)!.url).toBeUndefined()
    // Output cut short says nothing rather than something wrong.
    expect(browserStepSentence(browserStep(record({ id: 'x', title: 'sotto_browser / browser_action', output: '{"task":{"steps":[{"act' }))!)).toBe('Worked in the page')
  })

  it('says a failed step could not be done', () => {
    const failed = claude('f', 'browser_action', { action: { type: 'scroll', x: 0, y: 0, deltaX: 0, deltaY: 1 } }, { status: 'failed', error: 'The browser action did not finish.' })
    expect(browserStep(failed)!.failed).toBe(true)
    expect(browserStepSentence(browserStep(failed)!)).toBe('Could not scroll the page')
  })

  it('says the cloud iPhone\'s steps in its own words', () => {
    const steps = [
      claude('a', 'iphone_cloud_open', { buildPath: 'build/App.zip' }),
      claude('b', 'iphone_cloud_action', { action: { type: 'tap', x: 1, y: 1 } }),
      claude('c', 'iphone_cloud_action', { action: { type: 'button', button: 'home' } }),
      claude('d', 'iphone_cloud_action', { action: { type: 'screenshot' } }),
      claude('e', 'iphone_cloud_finish', { status: 'completed', summary: '', unchecked: [] }),
    ].map(item => browserStepSentence(browserStep(item)!))
    expect(steps).toEqual(['Started a cloud iPhone', 'Tapped the screen', 'Pressed home', 'Took a picture of the screen', 'Finished the cloud iPhone session'])
  })
})

describe('one line per turn', () => {
  it('folds every call of the turn into one line where the first happened, whatever other work falls between', () => {
    const records = [
      record({ id: 'cmd', kind: 'command', title: 'Command', command: 'npm run dev' }),
      claude('open', 'browser_open', { url: 'http://localhost:5173' }),
      claude('click', 'browser_action', { action: { type: 'click', x: 1, y: 1 } }),
      record({ id: 'edit', kind: 'file-change', title: 'File changes', changes: [{ path: 'src/SignIn.tsx', kind: 'update' }] }),
      claude('look', 'browser_action', { action: { type: 'inspect' } }),
      record({ id: 'other', title: 'mcp__playwright__browser_click' }),
    ]
    const items = foldBrowserRuns(nestActivities(records), lines(records))
    expect(items.map(item => item.run ? `run:${item.run.steps.map(step => step.record.id).join('+')}` : item.node.record.id))
      .toEqual(['cmd', 'run:open+click+look', 'edit', 'other'])
    // A later group of the same turn, after a reply, draws no line and no rows for the calls the line stands for.
    const later = [records[4]!, records[5]!]
    expect(foldBrowserRuns(nestActivities(later), lines(records)).map(item => item.node?.record.id ?? 'line')).toEqual(['other'])
  })

  it('lists the steps in the order they were reported, and keeps one line after the agent finishes and starts again', () => {
    const records = [
      claude('open', 'browser_open', { url: 'http://localhost:5173' }, { sequence: 1 }),
      claude('finish', 'browser_finish', { status: 'completed', summary: '', unchecked: [] }, { sequence: 3 }),
      claude('look', 'browser_action', { action: { type: 'inspect' } }, { sequence: 2 }),
      claude('again', 'browser_start', { pageId: 'p', description: 'Check notes' }, { sequence: 4 }),
    ]
    const [run] = runs(records)
    expect(runs(records)).toHaveLength(1)
    expect(run!.key).toBe('open')
    expect(run!.steps.map(step => step.record.id)).toEqual(['open', 'look', 'finish', 'again'])
    expect(run!.finished).toBe(false)
    expect(runs(records.slice(0, 3))[0]!.finished).toBe(true)
  })

  it('gives the cloud iPhone a line of its own, one per turn too, and each turn its own lines', () => {
    const records = [
      claude('open', 'browser_open', { url: 'http://localhost:5173' }),
      claude('cloud', 'iphone_cloud_open', { buildPath: 'App.zip' }),
      claude('look', 'browser_action', { action: { type: 'inspect' } }),
      claude('tap', 'iphone_cloud_action', { action: { type: 'tap', x: 1, y: 1 } }),
      claude('next', 'browser_open', { url: 'http://localhost:5173' }, { turnId: 'turn-2' }),
    ]
    expect(runs(records).map(run => [run.kind, run.steps.map(step => step.record.id).join('+')])).toEqual([['browser', 'open+look'], ['cloud', 'cloud+tap']])
    expect(browserLinesByTurn(records).get('turn-2')!.runs.map(run => run.key)).toEqual(['next'])
  })

  it('keeps the row of a call that holds other work under it, and of a call under a subagent', () => {
    const parent = claude('open', 'browser_open', { url: 'http://localhost:5173' })
    const child = record({ id: 'child', kind: 'command', title: 'Command', command: 'ls', parentId: 'open' })
    expect(foldBrowserRuns(nestActivities([parent, child]), lines([parent, child])).map(item => item.node?.record.id)).toEqual(['open'])
    // A subagent's own call stays under the subagent, where the working line and the turn's rows show it.
    const agent = record({ id: 'agent', kind: 'subagent', title: 'Task' })
    const nested = claude('nested', 'browser_action', { action: { type: 'click', x: 1, y: 1 } }, { parentId: 'agent' })
    const top = claude('top', 'browser_open', { url: 'http://localhost:5173' })
    const found = lines([agent, nested, top])
    expect(found.folded.has('nested')).toBe(false)
    expect(found.runs.map(run => run.steps.map(step => step.record.id))).toEqual([['top']])
  })
})

describe('the line\'s words', () => {
  const run = (...records: AgentActivity[]): BrowserRun => runs(records)[0]!

  it('names the host of the newest open or navigation, and says the last step while the run goes on', () => {
    const going = run(
      claude('open', 'browser_open', { url: 'http://localhost:5173/' }),
      claude('nav', 'browser_action', { action: { type: 'navigate', url: 'https://example.com/a' } }),
      claude('click', 'browser_action', { action: { type: 'click', x: 1, y: 1 } }),
    )
    expect(browserRunHost(going)).toBe('example.com')
    expect(said(going, true)).toEqual({ headline: 'Browsing example.com', detail: 'clicked in the page' })
    expect(said(going, false)).toEqual({ headline: 'Browsed example.com', detail: '3 steps' })
  })

  it('says the last step did not work, and uses plain words when no address was opened', () => {
    const failed = run(claude('pages', 'browser_pages', {}), claude('look', 'browser_action', { action: { type: 'inspect' } }, { status: 'failed' }))
    expect(browserRunHost(failed)).toBeUndefined()
    expect(said(failed, true)).toEqual({ headline: 'Using the browser', detail: 'could not look at the page' })
    expect(said(failed, false)).toEqual({ headline: 'Used the browser', detail: '2 steps' })
    expect(said(run(claude('cloud', 'iphone_cloud_open', { buildPath: 'App.zip' })), true).headline).toBe('Using the cloud iPhone')
  })

  it('keeps an address or a key name out of the translated words, to stand left to right in its own element', () => {
    const going = run(claude('open', 'browser_open', { url: 'http://localhost:5173/sign-in' }), claude('key', 'browser_action', { action: { type: 'key', key: 'Enter' } }))
    const { headline, detail } = browserRunWords(going, true)
    expect(headline).toEqual({ text: `Browsing ${PLACE}`, place: 'localhost:5173' })
    expect(detail).toEqual({ text: `pressed ${PLACE}`, place: 'Enter' })
    expect(browserStepWords(going.steps[0]!)).toEqual({ text: `opened ${PLACE}`, place: 'localhost:5173/sign-in' })
    // A capital goes on the first word, never on the address.
    expect(sentenceWords({ text: `${PLACE} opened`, place: 'example.com' }).text).toBe(`${PLACE} opened`)
  })

  it('names the press for assistive tech: show or hide the steps, and what the line says', () => {
    const going = run(claude('open', 'browser_open', { url: 'http://localhost:5173/' }))
    expect(browserLineName(going, false, 'Browsing localhost:5173 · opened localhost:5173')).toBe('Show browser steps: Browsing localhost:5173 · opened localhost:5173')
    expect(browserLineName(going, true, 'Browsed localhost:5173 · 1 step')).toBe('Hide browser steps: Browsed localhost:5173 · 1 step')
    expect(browserLineName(run(claude('cloud', 'iphone_cloud_open', { buildPath: 'App.zip' })), false, 'Using the cloud iPhone · started a cloud iPhone'))
      .toBe('Show cloud iPhone steps: Using the cloud iPhone · started a cloud iPhone')
  })
})

describe('the line still going', () => {
  const message = (id: string, role: AgentMessage['role']): AgentMessage => ({ id, role, text: 'words', createdAt: '2026-10-27T09:00:00.000Z' })

  it('is the line whose call is the turn\'s newest step, found whatever order the records are in', () => {
    const records = [
      record({ id: 'turn', kind: 'turn', title: 'Turn', sequence: 99 }),
      claude('look', 'browser_action', { action: { type: 'inspect' } }, { sequence: 7, afterMessageId: 'said' }),
      claude('open', 'browser_open', { url: 'http://localhost:5173' }, { sequence: 3, afterMessageId: 'said' }),
      record({ id: 'other-turn', turnId: 'turn-2', sequence: 50 }),
    ]
    expect(lines(records).newest?.id).toBe('look')
    expect(goingRunKey(lines(records), [message('ask', 'user'), message('said', 'assistant')])).toBe('open')
  })

  it('ends once other work follows, the agent finishes its task, or it writes a reply after the call', () => {
    const open = claude('open', 'browser_open', { url: 'http://localhost:5173' }, { afterMessageId: 'said' })
    const messages = [message('ask', 'user'), message('said', 'assistant')]
    expect(goingRunKey(lines([open, record({ id: 'test', kind: 'command', title: 'Command' })]), messages)).toBeNull()
    expect(goingRunKey(lines([open, claude('done', 'browser_finish', { status: 'completed', summary: '', unchecked: [] }, { afterMessageId: 'said' })]), messages)).toBeNull()
    expect(goingRunKey(lines([open]), [...messages, message('reply', 'assistant')])).toBeNull()
    // The user's own message after it is not the agent moving on.
    expect(goingRunKey(lines([open]), [...messages, message('queued', 'user')])).toBe('open')
  })
})

describe('the transcript\'s store of lines', () => {
  /** The records as a list that counts how often one of them is read. */
  const counted = (records: AgentActivity[]): { list: AgentActivity[]; reads: () => number } => {
    let count = 0
    const list = new Proxy(records, { get: (target, key, receiver) => { if (typeof key === 'string' && /^\d+$/u.test(key)) count++; return Reflect.get(target, key, receiver) } })
    return { list, reads: () => count }
  }
  const message = (id: string, role: AgentMessage['role']): AgentMessage => ({ id, role, text: 'words', createdAt: '2026-10-27T09:00:00.000Z' })

  it('reads the records once for each list of them, and a message only moves the running turn\'s line', () => {
    const records = counted([
      claude('old', 'browser_open', { url: 'http://localhost:5173' }, { turnId: 'turn-0', afterMessageId: 'said' }),
      claude('open', 'browser_open', { url: 'http://localhost:5173' }, { afterMessageId: 'said' }),
    ])
    const store = new BrowserLinesStore()
    let told = 0
    store.subscriberFor('turn-1')(() => { told++ })
    store.update(records.list, 'turn-1', [message('said', 'assistant')])
    const read = records.reads()
    const older = store.view('turn-0')
    expect(store.view('turn-1').goingKey).toBe('open')
    // Words streaming into a reply: the records are not read again, and only the running turn's view moves.
    store.update(records.list, 'turn-1', [message('said', 'assistant'), message('reply', 'assistant')])
    store.update(records.list, 'turn-1', [message('said', 'assistant'), { ...message('reply', 'assistant'), text: 'more words' }])
    expect(records.reads()).toBe(read)
    expect(store.view('turn-1').goingKey).toBeNull()
    expect(store.view('turn-0')).toBe(older)
    expect(told).toBe(2)
  })

  it('keeps a turn\'s view while its own records stay the same, as another turn\'s change', () => {
    const old = claude('old', 'browser_open', { url: 'http://localhost:5173' }, { turnId: 'turn-0' })
    const open = claude('open', 'browser_open', { url: 'http://localhost:5173' }, { status: 'running' })
    const store = new BrowserLinesStore()
    store.update([old, open], 'turn-1', [])
    const older = store.view('turn-0'), newer = store.view('turn-1')
    store.update([old, { ...open, status: 'completed' }], 'turn-1', [])
    expect(store.view('turn-0')).toBe(older)
    expect(store.view('turn-1')).not.toBe(newer)
  })

  it('tells only who draws the turn that changed, however many finished turns are drawn', () => {
    const finished = Array.from({ length: 100 }, (_, index) => claude(`old-${index}`, 'browser_open', { url: 'http://localhost:5173' }, { turnId: `turn-old-${index}` }))
    const open = claude('open', 'browser_open', { url: 'http://localhost:5173' }, { status: 'running' })
    const store = new BrowserLinesStore()
    store.update([...finished, open], 'turn-1', [])
    let historical = 0, running = 0
    for (let index = 0; index < 100; index++) store.subscriberFor(`turn-old-${index}`)(() => { historical++ })
    store.subscriberFor('turn-1')(() => { running++ })
    store.update([...finished, { ...open, status: 'completed' }], 'turn-1', [])
    expect(running).toBe(1)
    expect(historical).toBe(0)
    // The same turn's subscriber is one function, so a view subscribing again does not churn.
    expect(store.subscriberFor('turn-1')).toBe(store.subscriberFor('turn-1'))
  })
})
