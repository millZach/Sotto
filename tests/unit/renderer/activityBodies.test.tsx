import React from 'react'
import { act, cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentActivity } from '../../../src/shared/agentActivity'
import { cutActivityBodies } from '../../../src/shared/activityBodies'
import { ActivityGroupView, TurnChangedFiles } from '../../../src/renderer/src/agents/ThreadActivity'
import { ActivityBodyCache, ActivityBodyContext, activityBodies, type ActivityBodyHost } from '../../../src/renderer/src/agents/activityBodies'
import { CUT_BODY_WAIT_MS } from '../../../src/renderer/src/agents/ActivityBody'
import { turnChanges, type ActivityGroup } from '../../../src/renderer/src/agents/threadActivityView'

const lines = (count: number, word: string): string => Array.from({ length: count }, (_, index) => `${word} ${index}`.padEnd(40, '.')).join('\n')
const wholeTest: AgentActivity = { id: 'test', turnId: 't1', sequence: 1, kind: 'command', status: 'completed', title: 'Bash', command: 'npm test', output: lines(300, 'passed'), exitCode: 0, durationMs: 48_000 }
const sentTest = cutActivityBodies(wholeTest)
const wholeEdit: AgentActivity = { id: 'edit', turnId: 't1', sequence: 2, kind: 'file-change', status: 'completed', title: 'Edit',
  changes: [{ path: 'src/main/hosts/hostRouter.ts', kind: 'edit', diff: lines(200, '+ const') }] }
const sentEdit = cutActivityBodies(wholeEdit)

const fetchBody = vi.fn<(request: { threadId: string; activityId: string }) => Promise<AgentActivity | null>>()
const host = (connected = true): ActivityBodyHost => ({ threadId: 'remote:thread', hostName: 'forge', connected })
const group = (records: AgentActivity[]): ActivityGroup => ({ key: 'g', turnId: 't1', anchorMessageId: 'm1', records })
function rows(records: AgentActivity[], connected = true) {
  const draw = (items: AgentActivity[], online: boolean) => <ActivityBodyContext.Provider value={host(online)}>
    <ActivityGroupView group={group(items)} live threadRunning={false} connected provider="Claude Code" />
  </ActivityBodyContext.Provider>
  const view = render(draw(records, connected))
  return { ...view, redraw: (items: AgentActivity[], online = true) => view.rerender(draw(items, online)) }
}
const answers = (records: Record<string, AgentActivity>) => fetchBody.mockImplementation(async ({ activityId }) => records[activityId] ?? null)

beforeEach(() => {
  activityBodies.clear(); fetchBody.mockReset()
  Object.assign(window, { sotto: { agents: { activityBody: fetchBody } } })
})
afterEach(() => { cleanup(); vi.useRealTimers(); Reflect.deleteProperty(window, 'sotto') })

describe('cut activity bodies on a remote thread (ADR-0025, October 18 amendment)', () => {
  it('opens at once on the part the host sent, says the rest is coming, and holds Copy until it arrives', async () => {
    const user = userEvent.setup()
    let release!: (record: AgentActivity) => void
    fetchBody.mockImplementation(() => new Promise(resolve => { release = resolve }))
    rows([sentTest])
    const header = screen.getByRole('button', { name: /npm test|Bash/u })
    header.focus(); await user.keyboard('{Enter}')
    expect(header).toHaveFocus()
    expect(header).toHaveAttribute('aria-expanded', 'true')
    expect(fetchBody).toHaveBeenCalledExactlyOnceWith({ threadId: 'remote:thread', activityId: 'test' })
    expect(screen.getByText('Getting earlier lines from forge…')).toBeInTheDocument()
    expect(screen.getByText('⋯ earlier lines are on forge')).toBeInTheDocument()
    const copy = screen.getByRole('button', { name: 'Copy output code, once the rest arrives' })
    expect(copy).toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByText(/passed 299/u)).toBeInTheDocument()
    expect(screen.queryByText(/passed 0\./u)).toBeNull()

    await act(async () => { release(wholeTest) })
    expect(screen.getByText(/passed 0\./u)).toBeInTheDocument()
    expect(screen.queryByText('Getting earlier lines from forge…')).toBeNull()
    expect(screen.queryByText('⋯ earlier lines are on forge')).toBeNull()
    expect(screen.getByRole('button', { name: 'Copy output code' })).not.toHaveAttribute('aria-disabled')
  })

  it('opens held output at its end, before and after the rest arrives', async () => {
    const user = userEvent.setup()
    const height = vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(1_000)
    const client = vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(320)
    try {
      answers({ test: wholeTest })
      rows([sentTest])
      await user.click(screen.getByRole('button', { name: /npm test|Bash/u }))
      const block = screen.getByLabelText('output code block')
      expect(block.scrollTop).toBe(680)
      await screen.findByText(/passed 0\./u)
      expect(screen.getByLabelText('output code block').scrollTop).toBe(680)
    } finally { height.mockRestore(); client.mockRestore() }
  })

  it('keeps the part and offers Try again when the read fails, in the normal text colour', async () => {
    const user = userEvent.setup()
    fetchBody.mockRejectedValueOnce(new Error('timed out'))
    rows([sentTest])
    await user.click(screen.getByRole('button', { name: /npm test|Bash/u }))
    expect(await screen.findByText('Couldn’t get the rest of this output from forge. Nothing is lost: it is still there.')).toBeInTheDocument()
    expect(screen.getByText('End of the output only')).toBeInTheDocument()
    expect(screen.getByText(/passed 299/u)).toBeInTheDocument()
    expect(screen.getByText('Couldn’t get the rest of this output from forge. Nothing is lost: it is still there.').closest('.thread-activity__error')).toBeNull()
    answers({ test: wholeTest })
    const retry = screen.getByRole('button', { name: 'Try again to get this output from forge' })
    // Try again is reached with Tab from the block above it.
    screen.getByLabelText('output code block').focus(); await user.tab()
    expect(retry).toHaveFocus()
    await user.keyboard('{Enter}')
    expect(await screen.findByText(/passed 0\./u)).toBeInTheDocument()
    expect(fetchBody).toHaveBeenCalledTimes(2)
  })

  it('says the host is not connected, and asks by itself once it is back while the row is open', async () => {
    const user = userEvent.setup()
    answers({ test: wholeTest })
    const view = rows([sentTest], false)
    await user.click(screen.getByRole('button', { name: /npm test|Bash/u }))
    expect(fetchBody).not.toHaveBeenCalled()
    expect(screen.getByText('forge is not connected. The rest shows here when it reconnects.')).toBeInTheDocument()
    expect(screen.getByText(/passed 299/u)).toBeInTheDocument()
    view.redraw([sentTest], true)
    expect(fetchBody).toHaveBeenCalledTimes(1)
    expect(await screen.findByText(/passed 0\./u)).toBeInTheDocument()
  })

  it('asks again after a read that failed when the host drops and comes back', async () => {
    const user = userEvent.setup()
    fetchBody.mockRejectedValueOnce(new Error('closed'))
    const view = rows([sentTest])
    await user.click(screen.getByRole('button', { name: /npm test|Bash/u }))
    await screen.findByText(/Couldn’t get the rest/u)
    view.redraw([sentTest], false)
    expect(screen.getByText('forge is not connected. The rest shows here when it reconnects.')).toBeInTheDocument()
    answers({ test: wholeTest })
    view.redraw([sentTest], true)
    expect(await screen.findByText(/passed 0\./u)).toBeInTheDocument()
    expect(fetchBody).toHaveBeenCalledTimes(2)
  })

  it('fetches only when a row opens, and opens again at once from the body it kept', async () => {
    const user = userEvent.setup()
    answers({ test: wholeTest })
    rows([sentTest])
    expect(fetchBody).not.toHaveBeenCalled()
    const header = screen.getByRole('button', { name: /npm test|Bash/u })
    await user.click(header)
    await screen.findByText(/passed 0\./u)
    await user.click(header)
    expect(screen.queryByText(/passed 0\./u)).toBeNull()
    await user.click(header)
    // No flash: the whole body is there on the first frame, and nothing was asked of the host.
    expect(screen.getByText(/passed 0\./u)).toBeInTheDocument()
    expect(screen.queryByText('Getting earlier lines from forge…')).toBeNull()
    expect(fetchBody).toHaveBeenCalledTimes(1)
  })

  it('keeps a fetched body across a delta that replaces the record, and drops it when the record changed', async () => {
    const user = userEvent.setup()
    answers({ test: wholeTest })
    const view = rows([sentTest])
    await user.click(screen.getByRole('button', { name: /npm test|Bash/u }))
    await screen.findByText(/passed 0\./u)
    // The next delta carries the same record as a new object: the body stays.
    view.redraw([structuredClone(sentTest)])
    expect(screen.getByText(/passed 0\./u)).toBeInTheDocument()
    expect(fetchBody).toHaveBeenCalledTimes(1)
    // The command's output grew: the new cut shows, and the open row asks for the new whole.
    const grown: AgentActivity = { ...wholeTest, output: wholeTest.output + '\n' + lines(5, 'linked') }
    let release!: (record: AgentActivity) => void
    fetchBody.mockImplementation(() => new Promise(resolve => { release = resolve }))
    view.redraw([cutActivityBodies(grown)])
    expect(screen.queryByText(/passed 0\./u)).toBeNull()
    expect(screen.getByText(/linked 4/u)).toBeInTheDocument()
    expect(screen.getByText('Getting earlier lines from forge…')).toBeInTheDocument()
    expect(fetchBody).toHaveBeenCalledTimes(2)
    await act(async () => { release(grown) })
    expect(screen.getByText(/passed 0\./u)).toBeInTheDocument()
  })

  it('shares one read between an Edit row and the turn’s changed files', async () => {
    const user = userEvent.setup()
    let release!: (record: AgentActivity) => void
    fetchBody.mockImplementation(() => new Promise(resolve => { release = resolve }))
    render(<ActivityBodyContext.Provider value={host()}>
      <TurnChangedFiles changes={turnChanges([group([sentEdit])])} />
      <ActivityGroupView group={group([sentEdit])} live threadRunning={false} connected provider="Claude Code" />
    </ActivityBodyContext.Provider>)
    await user.click(screen.getByRole('button', { name: /Edited src\/main\/hosts\/hostRouter.ts/u }))
    expect(screen.getByText('Getting the rest from forge…')).toBeInTheDocument()
    expect(screen.getByText('⋯ the rest is on forge')).toBeInTheDocument()
    await act(async () => { release(wholeEdit) })
    await screen.findAllByText(/\+ const 199/u)
    await user.click(screen.getByRole('button', { name: 'Changed 1 file' }))
    const list = screen.getByRole('list', { name: 'Changed 1 file' })
    expect(within(list).getByText(/\+ const 199/u)).toBeInTheDocument()
    expect(within(list).queryByText('⋯ the rest is on forge')).toBeNull()
    expect(fetchBody).toHaveBeenCalledTimes(1)
  })

  it('says in one line, after a moment, that a body cut to nothing is on its way', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    fetchBody.mockImplementation(() => new Promise(() => undefined))
    const oneLine: AgentActivity = { ...wholeTest, output: 'x'.repeat(5_000) }
    const sent = cutActivityBodies(oneLine)
    expect(sent.output).toBe('')
    rows([sent])
    await user.click(screen.getByRole('button', { name: /npm test|Bash/u }))
    const wait = screen.getByText('Getting output from forge…').closest('p')!
    expect(wait).not.toHaveAttribute('data-shown')
    await act(async () => { vi.advanceTimersByTime(CUT_BODY_WAIT_MS) })
    expect(wait).toHaveAttribute('data-shown')
  })

  it('does not say an agent left no result when its output is on the host', async () => {
    const user = userEvent.setup()
    fetchBody.mockImplementation(() => new Promise(() => undefined))
    const agent: AgentActivity = { id: 'agent', turnId: 't1', sequence: 3, kind: 'subagent', status: 'completed', title: 'Task', output: '', cut: { output: 9_000 } }
    rows([agent])
    await user.click(screen.getByRole('button', { name: /Task/u }))
    expect(screen.queryByText(/did not report this agent’s result/u)).toBeNull()
    expect(screen.getByText('Getting output from forge…')).toBeInTheDocument()
  })

  it('leaves this computer’s rows as they always were', async () => {
    const user = userEvent.setup()
    render(<ActivityGroupView group={group([wholeTest])} live threadRunning={false} connected provider="Claude Code" />)
    await user.click(screen.getByRole('button', { name: /npm test|Bash/u }))
    expect(screen.getByRole('button', { name: 'Copy output code' })).not.toHaveAttribute('aria-disabled')
    expect(document.querySelector('[data-cut]')).toBeNull()
    expect(fetchBody).not.toHaveBeenCalled()
  })

  it('keeps the cache bounded, newest kept', async () => {
    const fetch = vi.fn(async ({ activityId }: { activityId: string }) => ({ ...wholeTest, id: activityId }))
    const cache = new ActivityBodyCache(() => fetch, { entries: 3, bytes: Number.MAX_SAFE_INTEGER })
    for (const id of ['a', 'b', 'c', 'd', 'e']) { cache.request('remote:thread', { ...sentTest, id }); await Promise.resolve(); await Promise.resolve() }
    const kept = ['a', 'b', 'c', 'd', 'e'].filter(id => cache.get(ActivityBodyCache.key('remote:thread', { ...sentTest, id }))?.status === 'loaded')
    expect(kept).toEqual(['c', 'd', 'e'])
  })
})
