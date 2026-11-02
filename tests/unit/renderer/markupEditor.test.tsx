import React, { useState } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentActivity } from '../../../src/shared/agentActivity'
import type { AgentAttachmentHandle, AgentAttachmentStageRequest } from '../../../src/shared/agents'
import type { ActivityGroup } from '../../../src/renderer/src/agents/threadActivityView'
import { handleOf } from '../../fixtures/stagedImages'

const owl = { inlineMedia: true }
vi.mock('../../../src/renderer/src/state/owlFeature', () => ({ useOwlFeature: (id: string) => id === 'inline-media' && owl.inlineMedia }))
vi.mock('../../../src/renderer/src/agents/markup', async original => {
  const real = await original<typeof import('../../../src/renderer/src/agents/markup')>()
  // jsdom has no canvas: the copy is a stand-in named as the real one is.
  return { ...real, markedCopy: vi.fn(async (_source: string, name: string) => new File([new Uint8Array([137, 80, 78, 71])], real.markedName(name), { type: 'image/png' })) }
})
import { ThreadMediaTiles } from '../../../src/renderer/src/agents/ThreadMediaTiles'
import { ReplyAttachContext, type ReplyAttach, type ReplyAttachSlot } from '../../../src/renderer/src/agents/replyAttach'
import { ScreenshotInput } from '../../../src/renderer/src/agents/ScreenshotInput'
import { madeMark, markedCopy, markedName, arrowGeometry } from '../../../src/renderer/src/agents/markup'

const TILE = 'data:image/jpeg;base64,/9j/4AAQ'
const WHOLE = 'data:image/png;base64,iVBORw0KGgo='
const record: AgentActivity = { id: 'claude-tool-shot', turnId: 'turn', sequence: 0, kind: 'tool', status: 'completed', title: 'sotto_browser / screenshot',
  media: [{ id: 'm0', digest: '0'.repeat(64), kind: 'image', mimeType: 'image/png', sizeBytes: 40, width: 1000, height: 500, name: 'checkout.png', source: 'tool' }] }
const groups = [{ key: 'g', turnId: 'turn', anchorMessageId: null, records: [record] }] as unknown as ActivityGroup[]

class NearObserver {
  constructor(private readonly callback: IntersectionObserverCallback) {}
  observe(target: Element): void { this.callback([{ target, isIntersecting: true } as unknown as IntersectionObserverEntry], this as unknown as IntersectionObserver) }
  unobserve(): void { /* nothing held */ }
  disconnect(): void { /* nothing held */ }
}

function reply(overrides: Partial<ReplyAttach> = {}): ReplyAttach & { readonly added: File[][] } {
  const added: File[][] = []
  return { added, refusal: () => null, add: async files => { added.push([...files]); return null }, focus: vi.fn(), ...overrides }
}

/** Opens the picture in the viewer inside a pane whose reply box is `box` (none outside a pane), and says it loaded at 1000 by 500. */
async function openViewer(box: ReplyAttach | null): Promise<void> {
  const tiles = <ThreadMediaTiles groups={groups} threadId="thread" />
  render(box ? <ReplyAttachContext.Provider value={{ current: box }}>{tiles}</ReplyAttachContext.Provider> : tiles)
  await waitFor(() => expect(document.querySelectorAll('.thread-media img[src]')).toHaveLength(1))
  fireEvent.click(screen.getByRole('button', { name: /^Open picture 1 of 1/u }))
  await waitFor(() => expect(document.querySelector('.attachment-viewer img[src]')).toBeTruthy())
  const image = document.querySelector<HTMLImageElement>('.attachment-viewer img[src]')!
  Object.defineProperty(image, 'naturalWidth', { value: 1000, configurable: true })
  Object.defineProperty(image, 'naturalHeight', { value: 500, configurable: true })
  fireEvent.load(image)
}

/** The editor's picture, laid out at its own size at 0,0, so a pointer's place is the picture's pixel. */
function surface(): HTMLElement {
  const element = screen.getByRole('application', { name: 'Picture to mark up: Picture 1' })
  element.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: 1000, bottom: 500, width: 1000, height: 500, toJSON: () => ({}) })
  return element
}
function drag(element: HTMLElement, from: readonly [number, number], to: readonly [number, number], pointerType = 'mouse'): void {
  fireEvent.pointerDown(element, { pointerId: 1, button: 0, clientX: from[0], clientY: from[1], pointerType })
  for (let step = 1; step <= 4; step++) fireEvent.pointerMove(element, { pointerId: 1, clientX: from[0] + (to[0] - from[0]) * step / 4, clientY: from[1] + (to[1] - from[1]) * step / 4, pointerType })
  fireEvent.pointerUp(element, { pointerId: 1, clientX: to[0], clientY: to[1], pointerType })
}
const marksList = () => [...document.querySelectorAll('.markup-editor__mark-name')].map(item => item.textContent)

describe('marking a picture up (ADR-0170, part 5)', () => {
  const real = globalThis.IntersectionObserver
  const threadMedia = vi.fn(async (request: { size: string }) => ({ dataUrl: request.size === 'tile' ? TILE : WHOLE }))
  beforeAll(() => { globalThis.IntersectionObserver = NearObserver as unknown as typeof IntersectionObserver })
  beforeEach(() => { vi.stubGlobal('sotto', { agents: { threadMedia } }) })
  afterEach(() => { cleanup(); owl.inlineMedia = true; vi.unstubAllGlobals(); vi.mocked(markedCopy).mockClear() })
  afterAll(() => { globalThis.IntersectionObserver = real })

  it('offers Mark up in a thread pane, and nowhere a marked copy has no reply to go to', async () => {
    await openViewer(reply())
    expect(screen.getByRole('button', { name: 'Mark up' })).toBeTruthy()
    cleanup()
    await openViewer(null)
    expect(screen.queryByRole('button', { name: 'Mark up' })).toBeNull()
  })

  it('draws a box, an arrow and a pen line, lists them, and undoes, redoes and removes them', async () => {
    await openViewer(reply())
    await userEvent.click(screen.getByRole('button', { name: 'Mark up' }))
    // The editor opens on the arrow, with focus on it, and reads nothing more.
    expect(screen.getByRole('button', { name: 'Arrow' })).toHaveAttribute('aria-pressed', 'true')
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Arrow' }))
    expect(threadMedia.mock.calls.filter(([request]) => request.size === 'full')).toHaveLength(1)
    expect(screen.getByText('None yet. Draw on the picture.')).toBeTruthy()
    const picture = surface()
    drag(picture, [100, 100], [300, 200])
    await userEvent.click(screen.getByRole('button', { name: 'Box' }))
    drag(picture, [400, 100], [600, 300])
    await userEvent.click(screen.getByRole('button', { name: 'Pen' }))
    drag(picture, [50, 400], [250, 450], 'pen')
    // A box from a press that slipped is not a mark.
    await userEvent.click(screen.getByRole('button', { name: 'Box' }))
    drag(picture, [10, 10], [11, 11])
    expect(marksList()).toEqual(['Arrow', 'Box', 'Pen line'])
    expect(picture.querySelectorAll('[data-markup-shape]')).toHaveLength(3)
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }))
    expect(marksList()).toEqual(['Arrow', 'Box'])
    await userEvent.click(screen.getByRole('button', { name: 'Redo' }))
    expect(marksList()).toEqual(['Arrow', 'Box', 'Pen line'])
    await userEvent.click(screen.getByRole('button', { name: 'Remove Box' }))
    expect(marksList()).toEqual(['Arrow', 'Pen line'])
    // The focus goes to the next mark's Remove button, not the page.
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Remove Pen line' }))
    await userEvent.click(screen.getByRole('button', { name: 'Remove Pen line' }))
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Remove Arrow' }))
    await userEvent.click(screen.getByRole('button', { name: 'Remove Arrow' }))
    expect(document.activeElement).toBe(picture)
    await userEvent.keyboard('{Control>}z{/Control}{Control>}z{/Control}{Control>}z{/Control}')
    // Taking one off can be undone too.
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }))
    expect(marksList()).toEqual(['Arrow', 'Box', 'Pen line'])
  })

  it('places a note where it is pressed, kept by Enter and dropped by Escape', async () => {
    await openViewer(reply())
    await userEvent.click(screen.getByRole('button', { name: 'Mark up' }))
    await userEvent.keyboard('t')
    expect(screen.getByRole('button', { name: 'Note' })).toHaveAttribute('aria-pressed', 'true')
    const picture = surface()
    drag(picture, [200, 200], [200, 200])
    const input = await screen.findByRole('textbox', { name: 'Note' })
    expect(document.activeElement).toBe(input)
    await userEvent.type(input, 'The total is wrong{Enter}')
    expect(marksList()).toEqual(['Note: The total is wrong'])
    drag(picture, [300, 300], [300, 300])
    await userEvent.type(await screen.findByRole('textbox', { name: 'Note' }), 'never mind{Escape}')
    expect(marksList()).toEqual(['Note: The total is wrong'])
    // Escape in the note dropped only the note; the editor is still open.
    expect(screen.getByRole('application')).toBeTruthy()
  })

  it('marks up from the keyboard: Enter starts at the cross, the arrow keys move it, Enter ends it, and Escape goes back to the viewer', async () => {
    await openViewer(reply())
    const markUp = screen.getByRole('button', { name: 'Mark up' })
    await userEvent.click(markUp)
    await userEvent.keyboard('b')
    const picture = surface()
    act(() => picture.focus())
    await userEvent.keyboard('{Enter}{Shift>}{ArrowRight}{ArrowDown}{/Shift}{Enter}')
    expect(marksList()).toEqual(['Box'])
    // Escape while a mark is being drawn drops only that mark.
    await userEvent.keyboard('{Enter}{Shift>}{ArrowLeft}{/Shift}{Escape}')
    expect(marksList()).toEqual(['Box'])
    expect(screen.getByRole('application')).toBeTruthy()
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('application')).toBeNull()
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Mark up' })))
  })

  it('adds the marked copy to the pane\'s reply, closes, and leaves the picture in the thread as it was', async () => {
    const box = reply()
    await openViewer(box)
    await userEvent.click(screen.getByRole('button', { name: 'Mark up' }))
    // Nothing is added until something is drawn.
    await userEvent.click(screen.getByRole('button', { name: 'Add to reply' }))
    expect(screen.getByRole('status')).toHaveTextContent('Draw on the picture first. Nothing was added.')
    expect(box.added).toHaveLength(0)
    drag(surface(), [100, 100], [300, 200])
    await userEvent.click(screen.getByRole('button', { name: 'Add to reply' }))
    await waitFor(() => expect(box.added).toHaveLength(1))
    expect(box.added[0]!.map(file => [file.name, file.type])).toEqual([['Picture 1 marked up.png', 'image/png']])
    expect(vi.mocked(markedCopy)).toHaveBeenCalledWith(WHOLE, 'Picture 1', [expect.objectContaining({ tool: 'arrow', x0: 100, y0: 100, x1: 300, y1: 200 })], expect.anything())
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await waitFor(() => expect(box.focus).toHaveBeenCalled())
    expect(screen.getByRole('button', { name: /^Open picture 1 of 1/u })).toBeTruthy()
  })

  it('says why a reply can\'t take the copy, before drawing and after, and keeps the marks', async () => {
    const closed = reply({ refusal: () => 'This thread waits for your answer, so a marked copy can\'t go into its reply yet. Answer it first.' })
    await openViewer(closed)
    await userEvent.click(screen.getByRole('button', { name: 'Mark up' }))
    expect(screen.getByRole('alert')).toHaveTextContent('This thread waits for your answer')
    expect(screen.queryByRole('application')).toBeNull()
    cleanup()
    const full = reply({ add: async () => 'This screenshot does not fit in the draft. Remove an attachment.' })
    await openViewer(full)
    await userEvent.click(screen.getByRole('button', { name: 'Mark up' }))
    drag(surface(), [100, 100], [300, 200])
    await userEvent.click(screen.getByRole('button', { name: 'Add to reply' }))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('This screenshot does not fit in the draft.'))
    expect(marksList()).toEqual(['Arrow'])
  })
})

describe('a reply box takes a marked copy the way it takes a paste (ADR-0170, part 5)', () => {
  let staged: AgentAttachmentStageRequest[] = []
  beforeEach(() => {
    staged = []
    vi.stubGlobal('sotto', { agents: { stageAttachment: vi.fn(async (request: AgentAttachmentStageRequest) => { staged.push(request); return handleOf(request.bytes, crypto.randomUUID(), request.name, request.mimeType) }) } })
  })
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })
  function Box({ slot, supported = true, answering = false, disabled = false }: { readonly slot: ReplyAttachSlot; readonly supported?: boolean; readonly answering?: boolean; readonly disabled?: boolean }) {
    const [images, setImages] = useState<AgentAttachmentHandle[]>([])
    return <ReplyAttachContext.Provider value={slot}>
      <ScreenshotInput target="workshop" attachments={images} onChange={setImages} disabled={disabled} supported={supported} answering={answering}><textarea aria-label="Prompt" /></ScreenshotInput>
    </ReplyAttachContext.Provider>
  }

  it('stages the copy and puts the focus in the box', async () => {
    const slot: ReplyAttachSlot = { current: null }
    render(<Box slot={slot} />)
    expect(slot.current?.refusal()).toBeNull()
    const copy = new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], 'checkout marked up.png', { type: 'image/png' })
    let refused: string | null = 'not yet'
    await act(async () => { refused = await slot.current!.add([copy]) })
    expect(refused).toBeNull()
    expect(staged.map(request => request.name)).toEqual(['checkout marked up.png'])
    await waitFor(() => expect(screen.getByRole('img', { name: 'checkout marked up.png' })).toBeTruthy())
    act(() => slot.current!.focus())
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Prompt' }))
    cleanup()
    expect(slot.current).toBeNull()
  })

  it('says why it can\'t: an archived thread, an answer, a model that reads no images, a full draft', () => {
    const slot: ReplyAttachSlot = { current: null }
    const { rerender } = render(<Box slot={slot} disabled />)
    expect(slot.current?.refusal()).toBe('This thread is archived, so its reply box takes no pictures. Nothing was added. Restore the thread to reply.')
    rerender(<Box slot={slot} answering supported={false} />)
    expect(slot.current?.refusal()).toBe('This thread waits for your answer, so a marked copy can\'t go into its reply yet. Answer it first.')
    rerender(<Box slot={slot} supported={false} />)
    expect(slot.current?.refusal()).toBe('This thread\'s model does not read images, so a marked copy can\'t go into its reply. Choose a model with image support.')
    cleanup()
    function Full() {
      const [images, setImages] = useState<AgentAttachmentHandle[]>(Array.from({ length: 8 }, (_, index) => ({ id: `a${index}`, name: `a${index}.png`, mimeType: 'image/png', sizeBytes: 10, digest: 'a'.repeat(64) })))
      return <ReplyAttachContext.Provider value={slot}><ScreenshotInput target="workshop" attachments={images} onChange={setImages} disabled={false} supported><textarea aria-label="Prompt" /></ScreenshotInput></ReplyAttachContext.Provider>
    }
    render(<Full />)
    expect(slot.current?.refusal()).toBe('Attach up to 8 screenshots at a time.')
  })
})

describe('marks', () => {
  it('names the copy after the picture', () => {
    expect(markedName('checkout.png')).toBe('checkout marked up.png')
    expect(markedName('flow.final.jpeg')).toBe('flow.final marked up.png')
    expect(markedName('.png')).toBe('Picture marked up.png')
  })
  it('counts a drag as a mark only once it is more than a slip', () => {
    const size = { width: 800, height: 400 }
    expect(madeMark({ id: 1, ink: 'red', tool: 'box', x0: 0, y0: 0, x1: 5, y1: 5 }, size)).toBe(false)
    expect(madeMark({ id: 1, ink: 'red', tool: 'box', x0: 0, y0: 0, x1: 20, y1: 0 }, size)).toBe(true)
    expect(madeMark({ id: 1, ink: 'red', tool: 'pen', points: [[0, 0, 0.5], [1, 1, 0.5]], pressure: false }, size)).toBe(false)
    expect(madeMark({ id: 1, ink: 'red', tool: 'note', x0: 0, y0: 0, text: '  ' }, size)).toBe(false)
  })
  it('puts an arrow\'s head at its end, pointing along it', () => {
    const { head, shaft } = arrowGeometry({ id: 1, ink: 'red', tool: 'arrow', x0: 0, y0: 0, x1: 100, y1: 0 }, { width: 200, height: 100 })
    expect(head[0]).toEqual([100, 0])
    expect(shaft[0]).toBeLessThan(100)
    expect(head[1]![0]).toBeLessThan(100)
    expect(head[1]![1]).toBeCloseTo(-head[2]![1])
  })
})
