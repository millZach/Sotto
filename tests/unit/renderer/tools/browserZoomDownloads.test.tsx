// ADR-0222's pane pieces: the page's zoom beside the address and in the More menu, a download asking at the page's foot
// and listed in the empty pane, drawing on a frozen picture of the page with a comment, and an action that asks every
// time offering only Allow once.
import React from 'react'
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { BrowserBridge, BrowserDownload, BrowserEvent, BrowserTask } from '../../../../src/shared/browser'
import type { ToolsResult } from '../../../../src/shared/tools'

vi.mock('../../../../src/renderer/src/state/owlFeature', () => ({ useOwlFeature: () => false }))
vi.mock('../../../../src/renderer/src/agents/markup', async original => {
  const real = await original<typeof import('../../../../src/renderer/src/agents/markup')>()
  // jsdom has no canvas: the copy is a stand-in named as the real one is.
  return { ...real, markedCopy: vi.fn(async (_source: string, name: string) => new File([new Uint8Array([137, 80, 78, 71])], real.markedName(name), { type: 'image/png' })) }
})
import { zoomMenuGroup, zoomPercent, ZoomChip } from '../../../../src/renderer/src/tools/BrowserParity'
import { DownloadStrip, DownloadsList, useBrowserDownloads } from '../../../../src/renderer/src/tools/BrowserDownloads'
import { BrowserDraw } from '../../../../src/renderer/src/tools/BrowserDraw'
import { BrowserTaskDetails } from '../../../../src/renderer/src/tools/BrowserTaskDetails'
import { BrowserStore } from '../../../../src/renderer/src/tools/browserStore'
import { asksEveryTime } from '../../../../src/shared/browser'
import { browserPage, browserTask } from '../../../fixtures/renderer/browserBridge'
import { TOKEN_A } from '../../../fixtures/renderer/fakeFilesBridge'

afterEach(() => { cleanup(); vi.restoreAllMocks() })
const workspace = { threadId: 'workshop', projectId: 'p', workingDirectory: 'D:\\work', workspaceId: TOKEN_A }
const ok = <T,>(value: T): ToolsResult<T> => ({ ok: true, value })
const page = browserPage(workspace)
const download = (patch: Partial<BrowserDownload> = {}): BrowserDownload => ({ id: crypto.randomUUID(), threadId: 'workshop', workspaceId: TOKEN_A, pageId: page.id, file: 'report.pdf', host: 'files.example',
  state: 'asking', receivedBytes: 0, totalBytes: 2048, byAgent: false, folder: null, opens: true, startedAt: Date.now(), ...patch })

describe('the page\'s zoom', () => {
  const words = { in: 'Zoom in', out: 'Zoom out', reset: (percent: string) => `Actual size (now ${percent})` }

  it('says a zoom as a percentage', () => {
    expect(zoomPercent(1)).toBe('100%')
    expect(zoomPercent(1.75)).toBe('175%')
    expect(zoomPercent(0.333)).toBe('33%')
  })

  it('offers Zoom in, Zoom out and Actual size with Chrome\'s keys, each off where it cannot go', () => {
    const run = vi.fn()
    const items = zoomMenuGroup({ ...page, zoom: 1.75 }, words, false, run, false)
    expect(items.map(item => [item.label, item.shortcut?.plain, item.disabled])).toEqual([['Zoom in', 'Ctrl+=', false], ['Zoom out', 'Ctrl+-', false], ['Actual size (now 175%)', 'Ctrl+0', false]])
    items[2]!.run()
    expect(run).toHaveBeenCalledWith('reset')
    expect(zoomMenuGroup({ ...page, zoom: 1 }, words, true, run, false).map(item => [item.shortcut?.plain, item.disabled])).toEqual([['⌘=', false], ['⌘-', false], ['⌘0', true]])
    expect(zoomMenuGroup({ ...page, zoom: 5 }, words, false, run, false)[0]!.disabled).toBe(true)
    expect(zoomMenuGroup({ ...page, zoom: 0.25 }, words, false, run, false)[1]!.disabled).toBe(true)
    expect(zoomMenuGroup({ ...page, zoom: 1.5 }, words, false, run, true).every(item => item.disabled)).toBe(true)
  })

  it('shows the percentage beside the address and puts the page back at 100% when pressed', async () => {
    const onReset = vi.fn()
    render(<ZoomChip zoom={1.5} busy={false} onReset={onReset} />)
    const chip = screen.getByRole('button', { name: 'Zoom 150%. Back to 100%' })
    expect(chip.textContent).toBe('150%')
    await userEvent.click(chip)
    expect(onReset).toHaveBeenCalledOnce()
  })
})

describe('a download asking at the page\'s foot', () => {
  it('asks where a page\'s download goes, saying which site, and answers with Save to Downloads', async () => {
    const onAct = vi.fn(async () => null)
    const asking = download()
    render(<DownloadStrip page={page} downloads={[asking]} onAct={onAct} />)
    expect(screen.getByRole('status').textContent).toBe('files.example wants to download a file. Where should it go?')
    expect(screen.getByRole('group').textContent).toContain('report.pdf')
    await userEvent.click(screen.getByRole('button', { name: 'Save to Downloads' }))
    expect(onAct).toHaveBeenCalledWith(asking, 'save')
    await userEvent.click(screen.getByRole('button', { name: 'Save as…' }))
    expect(onAct).toHaveBeenCalledWith(asking, 'save-as')
  })

  it('says when an agent\'s action started it, and how many more wait', () => {
    render(<DownloadStrip page={page} downloads={[download({ byAgent: true }), download({ file: 'b.zip' }), download({ file: 'c.zip' })]} onAct={vi.fn(async () => null)} />)
    expect(screen.getByRole('status').textContent).toBe('The agent\'s action started a download from files.example. Where should it go?')
    expect(screen.getByRole('group').textContent).toContain('2 more waiting')
  })

  it('offers Open and Show in folder once saved, and only Show in folder for a program', async () => {
    const onAct = vi.fn(async () => null)
    const { rerender } = render(<DownloadStrip page={page} downloads={[download({ state: 'saved', folder: 'C:\\Users\\me\\Downloads' })]} onAct={onAct} />)
    expect(screen.getByRole('status').textContent).toBe('Saved report.pdf')
    expect(screen.getByRole('group').textContent).toContain('in Downloads')
    expect(screen.getByRole('button', { name: 'Open' })).toBeTruthy()
    rerender(<DownloadStrip page={page} downloads={[download({ file: 'setup.exe', state: 'saved', opens: false, folder: 'C:\\Users\\me\\Downloads' })]} onAct={onAct} />)
    expect(screen.queryByRole('button', { name: 'Open' })).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Show in folder' }))
    expect(onAct).toHaveBeenLastCalledWith(expect.objectContaining({ file: 'setup.exe' }), 'show')
  })

  it('hides a finished download from the page, says a refusal, and shows nothing for another page\'s', async () => {
    const onAct = vi.fn(async () => 'Sotto does not open programs or scripts.')
    const { container, rerender } = render(<DownloadStrip page={page} downloads={[download({ state: 'saved', folder: 'D:\\out' })]} onAct={onAct} />)
    await userEvent.click(screen.getByRole('button', { name: 'Open' }))
    expect((await screen.findByRole('alert')).textContent).toContain('does not open programs')
    await userEvent.click(screen.getByRole('button', { name: 'Hide report.pdf' }))
    expect(container.textContent).toBe('')
    rerender(<DownloadStrip page={page} downloads={[download({ pageId: '99999999-9999-4999-8999-999999999999' })]} onAct={onAct} />)
    expect(container.textContent).toBe('')
  })

  it('keeps a download whose Cancel came too late and was saved, and takes one off once it is cancelled (the third review)', async () => {
    const onAct = vi.fn(async () => null)
    const saving = download({ state: 'saving', receivedBytes: 1024 })
    const { container, rerender } = render(<DownloadStrip page={page} downloads={[saving]} onAct={onAct} />)
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onAct).toHaveBeenCalledWith(saving, 'cancel')
    // Placing had already begun, so the download was saved all the same: the strip says where.
    rerender(<DownloadStrip page={page} downloads={[{ ...saving, state: 'saved', folder: 'C:\\Users\\me\\Downloads' }]} onAct={onAct} />)
    expect(screen.getByRole('status').textContent).toBe('Saved report.pdf')
    // One the Cancel did stop leaves the page.
    const asking = download({ file: 'other.zip' })
    rerender(<DownloadStrip page={page} downloads={[asking]} onAct={onAct} />)
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    rerender(<DownloadStrip page={page} downloads={[{ ...asking, state: 'cancelled' }]} onAct={onAct} />)
    expect(container.textContent).toBe('')
  })
})

describe('the downloads in the empty pane', () => {
  it('lists this session\'s downloads, and Remove from the list moves the focus to the heading', async () => {
    const onAct = vi.fn(async () => null)
    const saved = download({ state: 'saved', folder: 'D:\\out' })
    render(<DownloadsList downloads={[download({ file: 'waiting.zip' }), saved]} onAct={onAct} />)
    expect(screen.getByRole('heading', { name: 'Downloads this session' })).toBeTruthy()
    expect(screen.getByText('From files.example, waiting for you')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: 'Remove report.pdf from the list' }))
    expect(onAct).toHaveBeenCalledWith(saved, 'dismiss')
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Downloads this session' })))
  })

  it('shows nothing with no downloads', () => {
    const { container } = render(<DownloadsList downloads={[]} onAct={vi.fn(async () => null)} />)
    expect(container.textContent).toBe('')
  })
})

describe('the thread\'s downloads as the pane keeps them', () => {
  it('reads the list, follows its events and drops one taken off the list', async () => {
    let listener: ((event: BrowserEvent) => void) | null = null
    const first = download()
    const bridge = {
      downloads: vi.fn(async () => ok([first])), download: vi.fn(async () => ok({ ...first, state: 'cancelled' as const })),
      onEvent: (next: (event: BrowserEvent) => void) => { listener = next; return () => { listener = null } },
    } as unknown as BrowserBridge
    const { result } = renderHook(() => useBrowserDownloads(bridge, 'workshop', TOKEN_A, true))
    await waitFor(() => expect(result.current.downloads.map(item => item.id)).toEqual([first.id]))
    const second = download({ file: 'b.zip', startedAt: Date.now() + 1 })
    act(() => listener!({ type: 'download', download: second }))
    act(() => listener!({ type: 'download', download: { ...second, threadId: 'other' } }))
    expect(result.current.downloads.map(item => item.file)).toEqual(['b.zip', 'report.pdf'])
    act(() => listener!({ type: 'download', download: second, gone: true }))
    expect(result.current.downloads.map(item => item.file)).toEqual(['report.pdf'])
    expect(await act(() => result.current.act(first, 'cancel'))).toBeNull()
    expect(result.current.downloads[0]?.state).toBe('cancelled')
  })

  it('asks nothing when off or with no workspace', () => {
    const bridge = { downloads: vi.fn(), onEvent: vi.fn(() => () => undefined) } as unknown as BrowserBridge
    renderHook(() => useBrowserDownloads(bridge, 'workshop', TOKEN_A, false))
    renderHook(() => useBrowserDownloads(bridge, 'workshop', null, true))
    expect(bridge.downloads).not.toHaveBeenCalled()
  })
})

describe('drawing on a picture of the page', () => {
  beforeAll(() => { HTMLImageElement.prototype.decode = async () => undefined })
  const capture = { image: 'data:image/png;base64,iVBORw0KGgo=', url: 'http://localhost:5173/', width: 1000, height: 500, element: null }

  it('puts the focus in the comment, says dictation types there, and adds the marked copy with the comment', async () => {
    const onAdd = vi.fn(async () => null), onAdded = vi.fn()
    render(<BrowserDraw capture={capture} name="Vite App" onAdd={onAdd} onCancel={vi.fn()} onAdded={onAdded} />)
    const field = await screen.findByRole('textbox', { name: 'Comment' })
    await waitFor(() => expect(document.activeElement).toBe(field))
    expect(screen.getByText('Dictation types here while this field has the focus.')).toBeTruthy()
    expect(field.getAttribute('aria-describedby')).toBe('browser-draw-dictation')
    // Typing in the comment does not reach the editor's own keys.
    await userEvent.type(field, 'The button is cut off b')
    expect((field as HTMLTextAreaElement).value).toBe('The button is cut off b')
    await userEvent.click(screen.getByRole('button', { name: 'Box' }))
    const picture = screen.getByRole('application', { name: /Picture to mark up/u })
    picture.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: 1000, bottom: 500, width: 1000, height: 500, toJSON: () => ({}) })
    fireEvent.pointerDown(picture, { pointerId: 1, button: 0, clientX: 100, clientY: 100, pointerType: 'mouse' })
    for (let step = 1; step <= 4; step++) fireEvent.pointerMove(picture, { pointerId: 1, clientX: 100 + 50 * step, clientY: 100 + 30 * step, pointerType: 'mouse' })
    fireEvent.pointerUp(picture, { pointerId: 1, clientX: 300, clientY: 220, pointerType: 'mouse' })
    expect(screen.getByText('The marked picture and your comment go into the message. The page stays as it was.')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: 'Add to message' }))
    await waitFor(() => expect(onAdd).toHaveBeenCalledWith(expect.any(File), 'The button is cut off b'))
    expect(onAdded).toHaveBeenCalledOnce()
    expect(document.querySelector('.browser-draw')?.hasAttribute('data-covers-native-view')).toBe(true)
  })

  it('says why nothing was added and keeps the marks', async () => {
    const onAdd = vi.fn(async () => 'The draft for this thread is not available.'), onAdded = vi.fn()
    render(<BrowserDraw capture={capture} name="Vite App" onAdd={onAdd} onCancel={vi.fn()} onAdded={onAdded} />)
    await screen.findByRole('textbox', { name: 'Comment' })
    await userEvent.click(screen.getByRole('button', { name: 'Box' }))
    const picture = screen.getByRole('application', { name: /Picture to mark up/u })
    picture.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: 1000, bottom: 500, width: 1000, height: 500, toJSON: () => ({}) })
    fireEvent.pointerDown(picture, { pointerId: 1, button: 0, clientX: 100, clientY: 100, pointerType: 'mouse' })
    fireEvent.pointerMove(picture, { pointerId: 1, clientX: 300, clientY: 220, pointerType: 'mouse' })
    fireEvent.pointerUp(picture, { pointerId: 1, clientX: 300, clientY: 220, pointerType: 'mouse' })
    await userEvent.click(screen.getByRole('button', { name: 'Add to message' }))
    expect(await screen.findByText('The draft for this thread is not available.')).toBeTruthy()
    expect(onAdded).not.toHaveBeenCalled()
  })

  it('cancels with Escape, even from the comment, and puts the page back', async () => {
    const onCancel = vi.fn()
    render(<BrowserDraw capture={capture} name="Vite App" onAdd={vi.fn(async () => null)} onCancel={onCancel} onAdded={vi.fn()} />)
    const field = await screen.findByRole('textbox', { name: 'Comment' })
    await waitFor(() => expect(document.activeElement).toBe(field))
    await userEvent.keyboard('{Escape}')
    expect(onCancel).toHaveBeenCalled()
  })
})

describe('an action that asks every time', () => {
  const pending = (action: BrowserTask['pendingAction']): BrowserTask => browserTask({ threadId: 'workshop', workspaceId: TOKEN_A, pendingAction: action })
  const bridge = { answerAction: vi.fn(async () => ok(browserTask())) } as unknown as BrowserBridge

  it('offers only Allow once for an upload and for a profile page taken to another site', () => {
    const upload = pending({ id: '33333333-3333-4333-8333-333333333333', action: { type: 'upload', selector: '#file', paths: ['a.pdf'] }, description: 'Give a copy', expiresAt: Date.now() + 10000 })
    const away = pending({ id: '33333333-3333-4333-8333-333333333333', action: { type: 'navigate', url: 'https://other.example/' }, description: 'Take this page, signed in with your Work profile, to another site', expiresAt: Date.now() + 10000, everyTime: true })
    for (const task of [upload, away]) {
      expect(asksEveryTime(task.pendingAction!)).toBe(true)
      const { unmount } = render(<BrowserTaskDetails task={task} store={new BrowserStore()} bridge={bridge} />)
      expect(screen.getByRole('button', { name: 'Allow once' })).toBeTruthy()
      expect(screen.queryByRole('button', { name: 'Allow this thread to use the browser' })).toBeNull()
      unmount()
    }
  })

  it('still offers the thread-wide answer for a plain click', () => {
    const click = pending({ id: '33333333-3333-4333-8333-333333333333', action: { type: 'click', x: 1, y: 2 }, description: 'Click', expiresAt: Date.now() + 10000 })
    expect(asksEveryTime(click.pendingAction!)).toBe(false)
    render(<BrowserTaskDetails task={click} store={new BrowserStore()} bridge={bridge} />)
    expect(screen.getByRole('button', { name: 'Allow this thread to use the browser' })).toBeTruthy()
  })
})
