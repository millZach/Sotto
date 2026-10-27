import { describe, expect, it } from 'vitest'

import type { AgentActivity } from '../../../src/shared/agentActivity'
import { sottoBrowserToolOfTitle } from '../../../src/shared/sottoBrowserTools'
import {
  browserRunHost, browserRunWords, browserStep, browserStepSentence, foldBrowserRuns, newestStepId, type BrowserRun,
} from '../../../src/renderer/src/agents/browserLine'
import { nestActivities } from '../../../src/renderer/src/agents/threadActivityView'

// The browser line (ADR-0154; Owl only): a turn's calls to Sotto's own browser fold into one line.
let sequence = 0
const record = (patch: Partial<AgentActivity> & Pick<AgentActivity, 'id'>): AgentActivity =>
  ({ turnId: 'turn-1', sequence: sequence++, kind: 'tool', status: 'completed', title: 'Tool', ...patch })
/** Claude Code names a call `mcp__sotto_browser__<tool>` and reports its input as JSON. */
const claude = (id: string, tool: string, input: unknown, patch: Partial<AgentActivity> = {}): AgentActivity =>
  record({ id, title: `mcp__sotto_browser__${tool}`, text: JSON.stringify(input), ...patch })
const runs = (records: readonly AgentActivity[]): BrowserRun[] => foldBrowserRuns(nestActivities(records)).flatMap(item => item.run ? [item.run] : [])

describe('which records are calls to Sotto\'s browser', () => {
  it('knows each client\'s spelling of the eleven tools, and nothing else', () => {
    expect(sottoBrowserToolOfTitle('mcp__sotto_browser__browser_action')).toBe('browser_action')
    expect(sottoBrowserToolOfTitle('sotto_browser__browser_open')).toBe('browser_open')
    expect(sottoBrowserToolOfTitle('sotto_browser / iphone_cloud_tap')).toBeUndefined()
    expect(sottoBrowserToolOfTitle('sotto_browser / iphone_cloud_action')).toBe('iphone_cloud_action')
    expect(sottoBrowserToolOfTitle('sotto_browser_browser_finish')).toBe('browser_finish')
    // Someone else's server, or a tool Sotto does not own, keeps its row.
    expect(sottoBrowserToolOfTitle('mcp__playwright__browser_click')).toBeUndefined()
    expect(sottoBrowserToolOfTitle('mcp__sotto_browser__browser_delete')).toBeUndefined()
    expect(sottoBrowserToolOfTitle('Bash')).toBeUndefined()
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

describe('folding a group\'s rows', () => {
  it('folds consecutive calls into one run, and any other row splits the run', () => {
    const records = [
      record({ id: 'cmd', kind: 'command', title: 'Command', command: 'npm run dev' }),
      claude('open', 'browser_open', { url: 'http://localhost:5173' }),
      claude('click', 'browser_action', { action: { type: 'click', x: 1, y: 1 } }),
      record({ id: 'edit', kind: 'file-change', title: 'File changes', changes: [{ path: 'src/SignIn.tsx', kind: 'update' }] }),
      claude('look', 'browser_action', { action: { type: 'inspect' } }),
      record({ id: 'other', title: 'mcp__playwright__browser_click' }),
    ]
    const items = foldBrowserRuns(nestActivities(records))
    expect(items.map(item => item.run ? `run:${item.run.steps.map(step => step.record.id).join('+')}` : item.node.record.id))
      .toEqual(['cmd', 'run:open+click', 'edit', 'run:look', 'other'])
  })

  it('ends a run when the agent finishes its task, and gives the cloud iPhone a run of its own', () => {
    const records = [
      claude('open', 'browser_open', { url: 'http://localhost:5173' }),
      claude('finish', 'browser_finish', { status: 'completed', summary: '', unchecked: [] }),
      claude('again', 'browser_start', { pageId: 'p', description: 'Check notes' }),
      claude('cloud', 'iphone_cloud_open', { buildPath: 'App.zip' }),
      claude('tap', 'iphone_cloud_action', { action: { type: 'tap', x: 1, y: 1 } }),
    ]
    const found = runs(records)
    expect(found.map(run => [run.kind, run.finished, run.steps.length])).toEqual([['browser', true, 2], ['browser', false, 1], ['cloud', false, 2]])
  })

  it('keeps the row of a call that holds other work under it', () => {
    const parent = claude('open', 'browser_open', { url: 'http://localhost:5173' })
    const child = record({ id: 'child', kind: 'command', title: 'Command', command: 'ls', parentId: 'open' })
    expect(foldBrowserRuns(nestActivities([parent, child])).map(item => item.node?.record.id)).toEqual(['open'])
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
    expect(browserRunWords(going, true)).toEqual({ headline: 'Browsing example.com', detail: 'clicked in the page' })
    expect(browserRunWords(going, false)).toEqual({ headline: 'Browsed example.com', detail: '3 steps' })
  })

  it('says the last step did not work, and uses plain words when no address was opened', () => {
    const failed = run(claude('pages', 'browser_pages', {}), claude('look', 'browser_action', { action: { type: 'inspect' } }, { status: 'failed' }))
    expect(browserRunHost(failed)).toBeUndefined()
    expect(browserRunWords(failed, true)).toEqual({ headline: 'Using the browser', detail: 'could not look at the page' })
    expect(browserRunWords(failed, false)).toEqual({ headline: 'Used the browser', detail: '2 steps' })
    expect(browserRunWords(run(claude('cloud', 'iphone_cloud_open', { buildPath: 'App.zip' })), true).headline).toBe('Using the cloud iPhone')
  })
})

describe('the running turn\'s newest step', () => {
  it('is the step of that turn reported last, whatever order the list holds', () => {
    const records = [
      record({ id: 'turn', kind: 'turn', title: 'Turn', sequence: 99 }),
      record({ id: 'late', sequence: 7 }), record({ id: 'early', sequence: 3 }),
      record({ id: 'other-turn', turnId: 'turn-2', sequence: 50 }),
    ]
    expect(newestStepId(records, 'turn-1')).toBe('late')
    expect(newestStepId(records, null)).toBeNull()
    expect(newestStepId(undefined, 'turn-1')).toBeNull()
  })
})
