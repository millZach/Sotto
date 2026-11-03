import React, { useState } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentActivity } from '../../../src/shared/agentActivity'
import type { AgentAttachmentHandle, AgentAttachmentStageRequest } from '../../../src/shared/agents'
import type { ActivityGroup } from '../../../src/renderer/src/agents/threadActivityView'
import { handleOf } from '../../fixtures/stagedImages'

const app = vi.hoisted(() => ({ current: null as unknown }))
vi.mock('../../../src/renderer/src/state/AppContext', async original => ({ ...await original<typeof import('../../../src/renderer/src/state/AppContext')>(), useOptionalApp: () => app.current }))

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
import { madeMark, markAt, markBounds, markedCopy, markedName, markUnder, moveMarks, movingWith, nextNoteScale, NOTE_SCALES, arrowGeometry, noteEdge, resizeMark, settleNote, type MarkupShape, type NoteShape } from '../../../src/renderer/src/agents/markup'
import { contrastRatio } from '../../../src/shared/themes/color'

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
    // Taking one off can be undone too, and each mark goes back in its place.
    await userEvent.keyboard('{Control>}z{/Control}')
    expect(marksList()).toEqual(['Arrow'])
    await userEvent.keyboard('{Control>}z{/Control}')
    expect(marksList()).toEqual(['Arrow', 'Pen line'])
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }))
    expect(marksList()).toEqual(['Arrow', 'Box', 'Pen line'])
    // One more undoes the pen line that Redo put back.
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }))
    expect(marksList()).toEqual(['Arrow', 'Box'])
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

  it('keeps Tab inside the viewer from a note, the first mark included, when nothing comes after it', async () => {
    await openViewer(reply())
    // Another pane beside this one, which the focus must not reach while the viewer is open.
    const beside = document.body.appendChild(document.createElement('button'))
    beside.textContent = 'Another pane'
    await userEvent.click(screen.getByRole('button', { name: 'Mark up' }))
    await userEvent.keyboard('t')
    const viewer = document.querySelector('.attachment-viewer')!
    for (const shift of [false, true]) {
      // With no mark listed yet, the note box is the last thing in the viewer that takes the focus.
      expect(viewer.querySelectorAll('button[aria-label^="Remove "]')).toHaveLength(0)
      drag(surface(), [400, 400], [400, 400])
      expect(document.activeElement).toBe(await screen.findByRole('textbox', { name: 'Note' }))
      for (let step = 0; step < 30; step++) {
        await userEvent.tab({ shift })
        expect(viewer.contains(document.activeElement)).toBe(true)
      }
    }
    beside.remove()
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
    expect(madeMark({ id: 1, ink: 'red', tool: 'note', x0: 0, y0: 0, text: '  ', scale: 1, on: null }, size)).toBe(false)
  })
  it('edges a note\'s words in black or white, at 4.5:1 on any ink', () => {
    expect(noteEdge({ r: 240, g: 240, b: 240 })).toEqual({ r: 0, g: 0, b: 0 })
    expect(noteEdge({ r: 20, g: 20, b: 40 })).toEqual({ r: 255, g: 255, b: 255 })
    // Reds and greys between the two, where the theme's own colours fell short.
    for (const ink of [{ r: 222, g: 64, b: 64 }, { r: 128, g: 128, b: 128 }, { r: 119, g: 119, b: 119 }, { r: 240, g: 180, b: 40 }]) {
      expect(contrastRatio(ink, noteEdge(ink))).toBeGreaterThanOrEqual(4.5)
    }
  })
  it('puts an arrow\'s head at its end, pointing along it', () => {
    const { head, shaft } = arrowGeometry({ id: 1, ink: 'red', tool: 'arrow', x0: 0, y0: 0, x1: 100, y1: 0 }, { width: 200, height: 100 })
    expect(head[0]).toEqual([100, 0])
    expect(shaft[0]).toBeLessThan(100)
    expect(head[1]![0]).toBeLessThan(100)
    expect(head[1]![1]).toBeCloseTo(-head[2]![1])
  })
})

describe('moving marks (ADR-0170, part 5)', () => {
  const size = { width: 1000, height: 500 }
  const box: MarkupShape = { id: 1, ink: 'red', tool: 'box', x0: 100, y0: 100, x1: 400, y1: 300 }
  const arrow: MarkupShape = { id: 2, ink: 'red', tool: 'arrow', x0: 500, y0: 50, x1: 700, y1: 250 }
  const pen: MarkupShape = { id: 3, ink: 'amber', tool: 'pen', pressure: false, points: [[600, 400, 0.5], [650, 420, 0.5], [700, 410, 0.5]] }
  const onBox: NoteShape = { id: 4, ink: 'red', tool: 'note', x0: 150, y0: 200, text: 'On the box', scale: 1, on: 1 }
  const free: NoteShape = { id: 5, ink: 'plain', tool: 'note', x0: 800, y0: 50, text: 'Free', scale: 1, on: null }
  const marks = [box, arrow, pen, onBox, free]

  it('picks up a note\'s words first, then a line, then the smallest shape around the place', () => {
    expect(markAt(marks, 160, 200, 9, size)?.id).toBe(4)
    expect(markAt(marks, 600, 150, 9, size)?.id).toBe(2)
    expect(markAt(marks, 650, 421, 9, size)?.id).toBe(3)
    expect(markAt(marks, 300, 150, 9, size)?.id).toBe(1)
    expect(markAt(marks, 900, 450, 9, size)).toBeNull()
    const inner: MarkupShape = { id: 6, ink: 'red', tool: 'ellipse', x0: 200, y0: 120, x1: 380, y1: 180 }
    expect(markAt([...marks, inner], 290, 150, 9, size)?.id).toBe(6)
  })

  it('moves a shape with the notes on it, keeps a note alone, and leaves the other marks the same objects', () => {
    expect([...movingWith(marks, 1)]).toEqual([1, 4])
    expect([...movingWith(marks, 4)]).toEqual([4])
    const after = moveMarks(marks, movingWith(marks, 1), 50, 20, size)
    expect(after[0]).toMatchObject({ x0: 150, y0: 120, x1: 450, y1: 320 })
    expect(after[3]).toMatchObject({ x0: 200, y0: 220, on: 1 })
    expect(after[1]).toBe(arrow)
    expect(after[2]).toBe(pen)
    expect(after[4]).toBe(free)
  })

  it('stops a move at the picture\'s edge, for the shape and the note on it together', () => {
    const after = moveMarks(marks, movingWith(marks, 1), -5000, -5000, size)
    expect(after[0]).toMatchObject({ x0: 0, y0: 0, x1: 300, y1: 200 })
    expect(after[3]).toMatchObject({ x0: 50, y0: 100 })
    const low = moveMarks(marks, movingWith(marks, 3), 0, 5000, size)[2] as Extract<MarkupShape, { tool: 'pen' }>
    expect(Math.max(...low.points.map(point => point[1]))).toBe(500)
  })

  it('moves every point of a pen line, with its pressure', () => {
    const after = moveMarks(marks, new Set([3]), 10, -10, size)[2] as Extract<MarkupShape, { tool: 'pen' }>
    expect(after.points[1]).toEqual([660, 410, 0.5])
  })

  it('attaches a note let go on a mark and frees one let go off every mark', () => {
    const dropped = moveMarks(marks, new Set([5]), -600, 150, size)
    expect((settleNote(dropped, 5, 9, size).find(mark => mark.id === 5) as NoteShape).on).toBe(1)
    const away = moveMarks(marks, new Set([4]), 0, 250, size)
    expect((settleNote(away, 4, 9, size).find(mark => mark.id === 4) as NoteShape).on).toBeNull()
    // Staying on the same mark changes nothing, and a note is never on another note.
    expect(settleNote(marks, 4, 9, size)).toBe(marks)
    expect(markUnder([free], 810, 50, 9, size)).toBeNull()
  })

  it('resizes by a corner or an arrow\'s end, taking the notes on it along, and refuses to lose the mark', () => {
    const wider = resizeMark(marks, 1, 'bottom-right', 700, 300, size)!
    expect(wider[0]).toMatchObject({ x0: 100, y0: 100, x1: 700, y1: 300 })
    // The note on it keeps its share of the box: a sixth of the way across before, a sixth of the wider box after.
    expect((wider[3] as NoteShape).x0).toBeCloseTo(200)
    expect(resizeMark(marks, 2, 'end', 900, 450, size)![1]).toMatchObject({ x0: 500, y0: 50, x1: 900, y1: 450 })
    const pens = resizeMark(marks, 3, 'bottom-right', 800, 420, size)![2]!
    expect(markBounds(pens, size)).toMatchObject({ x: 600, y: 400, width: 200, height: 20 })
    expect(resizeMark(marks, 1, 'bottom-right', 101, 101, size)).toBeNull()
    expect(resizeMark(marks, 4, 'bottom-right', 700, 300, size)).toBeNull()
  })

  it('turns a note with an arrow it sits on, and keeps a resized mark\'s notes on the picture', () => {
    const along: MarkupShape = { id: 1, ink: 'red', tool: 'arrow', x0: 100, y0: 100, x1: 300, y1: 100 }
    const words: NoteShape = { id: 2, ink: 'red', tool: 'note', x0: 200, y0: 100, text: 'Mid', scale: 1, on: 1 }
    const turned = resizeMark([along, words], 1, 'end', 100, 300, size)!
    expect((turned[1] as NoteShape).x0).toBeCloseTo(100)
    expect((turned[1] as NoteShape).y0).toBeCloseTo(200)
    const long: NoteShape = { id: 4, ink: 'red', tool: 'note', x0: 380, y0: 200, text: 'A note too long to fit', scale: 2.6, on: 1 }
    const wider = resizeMark([box, long], 1, 'bottom-right', 990, 490, size)!
    const words2 = markBounds(wider[1]!, size)
    expect(words2.x + words2.width).toBeLessThanOrEqual(size.width)
  })

  it('treats a circle drawn or resized flat as the line it is', () => {
    const flat: MarkupShape = { id: 1, ink: 'red', tool: 'ellipse', x0: 100, y0: 100, x1: 300, y1: 100 }
    expect(markAt([flat], 800, 400, 9, size)).toBeNull()
    expect(markUnder([flat], 800, 400, 9, size)).toBeNull()
    expect(markAt([flat], 200, 104, 9, size)?.id).toBe(1)
  })

  it('keeps a long note on the mark it was placed on, whichever part of it is over the mark', () => {
    const long: NoteShape = { id: 2, ink: 'red', tool: 'note', x0: 380, y0: 200, text: 'A note long enough to run past the box', scale: 1, on: null }
    expect((settleNote([box, long], 2, 9, size)[1] as NoteShape).on).toBe(1)
    const moved = moveMarks([box, { ...long, on: 1 }], new Set([2]), 3, 0, size)
    expect((settleNote(moved, 2, 9, size)[1] as NoteShape).on).toBe(1)
  })

  it('steps text through its sizes and stays at either end', () => {
    expect(nextNoteScale(1, 1)).toBe(1.4)
    expect(nextNoteScale(1, -1)).toBe(0.7)
    expect(nextNoteScale(NOTE_SCALES[0]!, -1)).toBe(NOTE_SCALES[0])
    expect(nextNoteScale(NOTE_SCALES.at(-1)!, 1)).toBe(NOTE_SCALES.at(-1))
  })
})

describe('the Move tool in the editor (ADR-0170, part 5)', () => {
  const real = globalThis.IntersectionObserver
  const threadMedia = vi.fn(async (request: { size: string }) => ({ dataUrl: request.size === 'tile' ? TILE : WHOLE }))
  beforeAll(() => { globalThis.IntersectionObserver = NearObserver as unknown as typeof IntersectionObserver })
  beforeEach(() => { vi.stubGlobal('sotto', { agents: { threadMedia } }) })
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.mocked(markedCopy).mockClear() })
  afterAll(() => { globalThis.IntersectionObserver = real })

  /** The editor with a box from 100,100 to 300,200. */
  async function withABox(): Promise<HTMLElement> {
    await openViewer(reply())
    await userEvent.click(screen.getByRole('button', { name: 'Mark up' }))
    await userEvent.click(screen.getByRole('button', { name: 'Box' }))
    const picture = surface()
    drag(picture, [100, 100], [300, 200])
    return picture
  }
  const shapes = (picture: HTMLElement) => [...picture.querySelectorAll<SVGElement>('[data-markup-shape]')]
  const place = (shape: SVGElement, ...names: string[]) => names.map(name => Number(shape.getAttribute(name)))
  async function addNote(picture: HTMLElement, at: readonly [number, number], words: string): Promise<void> {
    drag(picture, at, at)
    await userEvent.type(await screen.findByRole('textbox', { name: 'Note' }), `${words}{Enter}`)
  }

  it('leaves a drawing tool drawing, so a stroke across a mark stays a stroke', async () => {
    const picture = await withABox()
    await userEvent.click(screen.getByRole('button', { name: 'Arrow' }))
    drag(picture, [100, 150], [400, 400])
    expect(marksList()).toEqual(['Box', 'Arrow'])
    expect(place(shapes(picture)[0]!, 'x', 'y')).toEqual([100, 100])
  })

  it('drags a mark with Move, and Undo and Redo step through the move', async () => {
    const picture = await withABox()
    await userEvent.keyboard('v')
    expect(screen.getByRole('button', { name: 'Move' })).toHaveAttribute('aria-pressed', 'true')
    drag(picture, [200, 100], [300, 250])
    expect(place(shapes(picture)[0]!, 'x', 'y', 'width', 'height')).toEqual([200, 250, 200, 100])
    expect(marksList()).toEqual(['Box'])
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }))
    expect(place(shapes(picture)[0]!, 'x', 'y')).toEqual([100, 100])
    await userEvent.click(screen.getByRole('button', { name: 'Redo' }))
    expect(place(shapes(picture)[0]!, 'x', 'y')).toEqual([200, 250])
  })

  it('selects with a press and draws nothing, and a press on the empty picture lets go', async () => {
    const picture = await withABox()
    await userEvent.click(screen.getByRole('button', { name: 'Move' }))
    drag(picture, [150, 150], [150, 150])
    expect(picture.querySelector('.markup-editor__selected')).toBeTruthy()
    expect(picture.querySelectorAll('.markup-editor__handle')).toHaveLength(4)
    expect(screen.getByRole('button', { name: 'Select Box' })).toHaveAttribute('aria-pressed', 'true')
    // A press and no move is not a step of Undo.
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }))
    expect(marksList()).toEqual([])
    await userEvent.click(screen.getByRole('button', { name: 'Redo' }))
    drag(picture, [700, 400], [700, 400])
    expect(picture.querySelector('.markup-editor__selected')).toBeNull()
    expect(marksList()).toEqual(['Box'])
  })

  it('resizes a selected mark by its handle', async () => {
    const picture = await withABox()
    await userEvent.click(screen.getByRole('button', { name: 'Move' }))
    drag(picture, [150, 100], [150, 100])
    drag(picture, [300, 200], [500, 400])
    expect(place(shapes(picture)[0]!, 'x', 'y', 'width', 'height')).toEqual([100, 100, 400, 300])
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }))
    expect(place(shapes(picture)[0]!, 'width')).toEqual([200])
  })

  it('writes a note on a shape, which goes with it, and frees it when dragged off', async () => {
    const picture = await withABox()
    await userEvent.keyboard('t')
    await addNote(picture, [150, 150], 'Too low')
    expect(marksList()).toEqual(['Box', 'Note on the box: Too low'])
    await userEvent.keyboard('v')
    drag(picture, [200, 100], [300, 200])
    expect(place(shapes(picture)[1]!, 'x')).toEqual([250])
    // Dragged off, it is free, and says so.
    drag(picture, [260, 250], [800, 450])
    expect(marksList()).toEqual(['Box', 'Note: Too low'])
    expect(screen.getByRole('status')).toHaveTextContent('The note is free now. It stays where you put it.')
    drag(picture, [300, 100], [300, 20])
    expect(place(shapes(picture)[1]!, 'x')).not.toEqual([250])
    expect(marksList()).toEqual(['Box', 'Note: Too low'])
  })

  it('attaches a free note let go on a shape', async () => {
    const picture = await withABox()
    await userEvent.keyboard('t')
    await addNote(picture, [700, 400], 'Here')
    expect(marksList()).toEqual(['Box', 'Note: Here'])
    await userEvent.keyboard('v')
    drag(picture, [705, 400], [155, 150])
    expect(marksList()).toEqual(['Box', 'Note on the box: Here'])
    expect(screen.getByRole('status')).toHaveTextContent('The note now moves with the box.')
  })

  it('takes a note off with its shape, and Undo brings both back', async () => {
    const picture = await withABox()
    await userEvent.keyboard('t')
    await addNote(picture, [150, 150], 'Too low')
    await userEvent.click(screen.getByRole('button', { name: 'Remove Box' }))
    expect(marksList()).toEqual([])
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }))
    expect(marksList()).toEqual(['Box', 'Note on the box: Too low'])
  })

  it('draws the words alone, in the ink, with an edge and no label behind them', async () => {
    const picture = await withABox()
    await userEvent.keyboard('t')
    await addNote(picture, [600, 300], 'No label')
    const words = picture.querySelector('text')!
    expect(words.closest('g')).toBeNull()
    expect(picture.querySelectorAll('rect')).toHaveLength(1)
    expect(words.getAttribute('paint-order')).toBe('stroke')
    expect(words.getAttribute('stroke')).toMatch(/^rgb\(/u)
  })

  it('sizes the selected text and the next note, and keeps A− and A+ off until there is text to size', async () => {
    const picture = await withABox()
    const larger = screen.getByRole('button', { name: 'Make the text larger' }), smaller = screen.getByRole('button', { name: 'Make the text smaller' })
    expect(larger).toHaveAttribute('aria-disabled', 'true')
    await userEvent.keyboard('t')
    expect(larger).toHaveAttribute('aria-disabled', 'false')
    await userEvent.click(larger)
    await addNote(picture, [600, 300], 'Big')
    const font = () => picture.querySelector('text')!.style.font
    expect(font()).toContain(`${1000 / 48 * 1.4}px`)
    await userEvent.keyboard('v')
    drag(picture, [605, 300], [605, 300])
    await userEvent.click(smaller)
    await userEvent.click(smaller)
    expect(font()).toContain(`${1000 / 48 * 0.7}px`)
    expect(smaller).toHaveAttribute('aria-disabled', 'true')
    await userEvent.click(smaller)
    expect(font()).toContain(`${1000 / 48 * 0.7}px`)
    // Each step is a step of Undo.
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }))
    expect(font()).toContain(`${1000 / 48 * 1}px`)
    act(() => picture.focus())
    drag(picture, [605, 300], [605, 300])
    await userEvent.keyboard('=')
    expect(font()).toContain(`${1000 / 48 * 1.4}px`)
    await userEvent.keyboard('-')
    expect(font()).toContain(`${1000 / 48 * 1}px`)
  })

  it('works from the keyboard: Enter steps through the marks, the arrow keys move and resize, Delete takes it off, Escape lets go', async () => {
    const picture = await withABox()
    await userEvent.click(screen.getByRole('button', { name: 'Arrow' }))
    drag(picture, [500, 100], [700, 200])
    await userEvent.keyboard('v')
    act(() => picture.focus())
    // No cross with Move, since nothing is drawn at one.
    expect(picture.querySelector('.markup-editor__cross')).toBeNull()
    await userEvent.keyboard('{Enter}')
    expect(screen.getByRole('status')).toHaveTextContent('Selected Box.')
    await userEvent.keyboard('{ArrowRight}{ArrowRight}{ArrowDown}')
    expect(place(shapes(picture)[0]!, 'x', 'y')).toEqual([120, 110])
    // A run of presses is one step of Undo.
    await userEvent.keyboard('{Control>}z{/Control}')
    expect(place(shapes(picture)[0]!, 'x', 'y')).toEqual([100, 100])
    await userEvent.keyboard('{Control>}{Shift>}z{/Shift}{/Control}')
    expect(place(shapes(picture)[0]!, 'x', 'y')).toEqual([120, 110])
    await userEvent.keyboard('{Alt>}{ArrowRight}{/Alt}')
    expect(place(shapes(picture)[0]!, 'width')).toEqual([210])
    await userEvent.keyboard('{Enter}')
    expect(screen.getByRole('status')).toHaveTextContent('Selected Arrow.')
    await userEvent.keyboard('{Delete}')
    expect(marksList()).toEqual(['Box'])
    expect(document.activeElement).toBe(picture)
    // Escape lets the selection go first, and only then cancels.
    await userEvent.keyboard('{Enter}')
    expect(picture.querySelector('.markup-editor__selected')).toBeTruthy()
    await userEvent.keyboard('{Escape}')
    expect(picture.querySelector('.markup-editor__selected')).toBeNull()
    expect(screen.getByRole('application')).toBeTruthy()
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('application')).toBeNull()
  })

  it('frees a note moved off its shape with the arrow keys, so taking the shape off leaves it', async () => {
    const picture = await withABox()
    await userEvent.keyboard('t')
    await addNote(picture, [150, 150], 'Too low')
    await userEvent.click(screen.getByRole('button', { name: /^Select Note on the box/u }))
    await userEvent.keyboard('{Shift>}{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}{/Shift}')
    expect(marksList()).toEqual(['Box', 'Note: Too low'])
    expect(screen.getByRole('status')).toHaveTextContent('The note is free now.')
    await userEvent.click(screen.getByRole('button', { name: 'Remove Box' }))
    expect(marksList()).toEqual(['Note: Too low'])
  })

  it('never folds a move into whatever was done after an Undo', async () => {
    const picture = await withABox()
    await userEvent.keyboard('v')
    await userEvent.click(screen.getByRole('button', { name: 'Select Box' }))
    await userEvent.keyboard('{ArrowRight}')
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }))
    await userEvent.keyboard('t')
    await addNote(picture, [700, 400], 'Here')
    await userEvent.click(screen.getByRole('button', { name: 'Select Box' }))
    await userEvent.keyboard('{ArrowRight}')
    await userEvent.keyboard('{Control>}z{/Control}')
    // Undo took back only the move; the note is still there.
    expect(marksList()).toEqual(['Box', 'Note: Here'])
    expect(place(shapes(picture)[0]!, 'x')).toEqual([100])
  })

  it('leaves Alt and an arrow key to the dictation hotkey when it holds them', async () => {
    app.current = { platform: 'win32', settings: { hotkey: 'Alt+Right' } }
    try {
      const picture = await withABox()
      await userEvent.click(screen.getByRole('button', { name: 'Select Box' }))
      await userEvent.keyboard('{Alt>}{ArrowRight}{/Alt}')
      expect(place(shapes(picture)[0]!, 'width')).toEqual([200])
      // Only that chord is the hotkey's: the other direction still resizes.
      await userEvent.keyboard('{Alt>}{ArrowLeft}{/Alt}')
      expect(place(shapes(picture)[0]!, 'width')).toEqual([190])
    } finally { app.current = null }
  })

  it('selects from the list of marks, with the focus on the picture for the arrow keys', async () => {
    const picture = await withABox()
    await userEvent.click(screen.getByRole('button', { name: 'Select Box' }))
    expect(screen.getByRole('button', { name: 'Move' })).toHaveAttribute('aria-pressed', 'true')
    expect(document.activeElement).toBe(picture)
    await userEvent.keyboard('{ArrowLeft}')
    expect(place(shapes(picture)[0]!, 'x')).toEqual([90])
  })

  it('stops a drag at Escape and keeps the mark where it was', async () => {
    const picture = await withABox()
    await userEvent.click(screen.getByRole('button', { name: 'Move' }))
    fireEvent.pointerDown(picture, { pointerId: 1, button: 0, clientX: 200, clientY: 100, pointerType: 'mouse' })
    fireEvent.pointerMove(picture, { pointerId: 1, clientX: 400, clientY: 300, pointerType: 'mouse' })
    expect(place(shapes(picture)[0]!, 'x')).toEqual([300])
    fireEvent.keyDown(picture, { key: 'Escape' })
    expect(place(shapes(picture)[0]!, 'x')).toEqual([100])
    expect(screen.getByRole('application')).toBeTruthy()
    fireEvent.pointerUp(picture, { pointerId: 1, clientX: 400, clientY: 300, pointerType: 'mouse' })
    expect(place(shapes(picture)[0]!, 'x')).toEqual([100])
  })

  it('hands the copy the marks as they stand after moving, with the note\'s size and without the outline', async () => {
    const picture = await withABox()
    await userEvent.keyboard('t')
    await addNote(picture, [150, 150], 'Too low')
    await userEvent.keyboard('v')
    drag(picture, [200, 100], [300, 200])
    await userEvent.click(screen.getByRole('button', { name: 'Add to reply' }))
    await waitFor(() => expect(vi.mocked(markedCopy)).toHaveBeenCalled())
    const marks = vi.mocked(markedCopy).mock.calls[0]![2]
    expect(marks[0]).toMatchObject({ tool: 'box', x0: 200, y0: 200, x1: 400, y1: 300 })
    expect(marks[1]).toMatchObject({ tool: 'note', x0: 250, y0: 250, text: 'Too low', scale: 1, on: marks[0]!.id })
  })
})
