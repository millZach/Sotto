import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentActivity, AgentMediaCallout } from '../../../src/shared/agentActivity'
import type { ActivityGroup } from '../../../src/renderer/src/agents/threadActivityView'

const owl = { inlineMedia: true }
vi.mock('../../../src/renderer/src/state/owlFeature', () => ({ useOwlFeature: (id: string) => id === 'inline-media' && owl.inlineMedia }))
vi.mock('../../../src/renderer/src/agents/markup', async original => {
  const real = await original<typeof import('../../../src/renderer/src/agents/markup')>()
  // jsdom has no canvas: the copy is a stand-in named as the real one is.
  return { ...real, markedCopy: vi.fn(async (_source: string, name: string) => new File([new Uint8Array([137, 80, 78, 71])], real.markedName(name), { type: 'image/png' })) }
})
import { ThreadMediaTiles } from '../../../src/renderer/src/agents/ThreadMediaTiles'
import { ReplyAttachContext, type ReplyAttach } from '../../../src/renderer/src/agents/replyAttach'
import { markedCopy } from '../../../src/renderer/src/agents/markup'
import { calloutGeometry, drawCallouts } from '../../../src/renderer/src/agents/callouts'

const TILE = 'data:image/jpeg;base64,/9j/4AAQ'
const WHOLE = 'data:image/png;base64,iVBORw0KGgo='
const callouts: AgentMediaCallout[] = [
  { n: 1, x: 0.6, y: 0.48, w: 0.335, h: 0.115, note: 'The Pay button sits on top of the total.' },
  { n: 2, x: 0.055, y: 0.365, w: 0.453, h: 0.083, note: 'The card number field has no label.' },
]
const picture = (id: string, marked?: AgentMediaCallout[]) => ({ id, digest: '0'.repeat(64), kind: 'image' as const, mimeType: 'image/png' as const, sizeBytes: 40,
  width: 1280, height: 800, name: `${id}.png`, source: 'file' as const, ...marked ? { callouts: marked } : {} })
const record: AgentActivity = { id: 'sotto-shown-1', turnId: 'turn', sequence: 0, kind: 'tool', status: 'completed', title: 'The checkout page',
  media: [picture('m0', callouts), picture('m1')] }
const groups = [{ key: 'g', turnId: 'turn', anchorMessageId: null, records: [record] }] as unknown as ActivityGroup[]

class NearObserver {
  constructor(private readonly callback: IntersectionObserverCallback) {}
  observe(target: Element): void { this.callback([{ target, isIntersecting: true } as unknown as IntersectionObserverEntry], this as unknown as IntersectionObserver) }
  unobserve(): void { /* nothing held */ }
  disconnect(): void { /* nothing held */ }
}
function reply(): ReplyAttach & { readonly added: File[][] } {
  const added: File[][] = []
  return { added, refusal: () => null, add: async files => { added.push([...files]); return null }, focus: vi.fn() }
}
/** Opens picture `number` in the viewer, inside a pane whose reply box is `box`, and says it loaded at 1280 by 800. */
async function openViewer(box: ReplyAttach | null, number = 1): Promise<void> {
  const tiles = <ThreadMediaTiles groups={groups} threadId="thread" who="Codex" />
  render(box ? <ReplyAttachContext.Provider value={{ current: box }}>{tiles}</ReplyAttachContext.Provider> : tiles)
  await waitFor(() => expect(document.querySelectorAll('.thread-media img[src]')).toHaveLength(2))
  fireEvent.click(screen.getByRole('button', { name: new RegExp(`^Open picture ${number} of 2`, 'u') }))
  await waitFor(() => expect(document.querySelector('.attachment-viewer img[src]')).toBeTruthy())
  const image = document.querySelector<HTMLImageElement>('.attachment-viewer img[src]')!
  Object.defineProperty(image, 'naturalWidth', { value: 1280, configurable: true })
  Object.defineProperty(image, 'naturalHeight', { value: 800, configurable: true })
  fireEvent.load(image)
}
const pins = (root: ParentNode) => [...root.querySelectorAll('[data-callout]')].map(item => item.getAttribute('data-callout'))
const notes = (root: ParentNode) => [...root.querySelectorAll('.callout-notes__note')].map(item => item.textContent)

describe('callouts an agent placed on a picture it showed (ADR-0170, part 6)', () => {
  const real = globalThis.IntersectionObserver
  const threadMedia = vi.fn(async (request: { size: string }) => ({ dataUrl: request.size === 'tile' ? TILE : WHOLE }))
  beforeAll(() => { globalThis.IntersectionObserver = NearObserver as unknown as typeof IntersectionObserver })
  beforeEach(() => { vi.stubGlobal('sotto', { agents: { threadMedia } }) })
  afterEach(() => { cleanup(); owl.inlineMedia = true; vi.unstubAllGlobals(); vi.mocked(markedCopy).mockClear() })
  afterAll(() => { globalThis.IntersectionObserver = real })

  it('draws the boxes, pins and count on the picture\'s tile, and says how many in its name', async () => {
    render(<ThreadMediaTiles groups={groups} threadId="thread" who="Codex" />)
    await waitFor(() => expect(document.querySelectorAll('.thread-media img[src]')).toHaveLength(2))
    const marked = screen.getByRole('button', { name: 'Open picture 1 of 2, from The checkout page, with 2 callouts' })
    expect(pins(marked)).toEqual(['1', '2'])
    expect(marked.querySelector('.thread-media__callout-count')?.textContent).toBe('2')
    // The layer sits over the picture at its own shape, as the picture sits in the tile, and keeps its pins a fixed size.
    const layer = marked.querySelector('svg.thread-media__callouts')!
    expect(layer.getAttribute('viewBox')).toBe('0 0 1280 800')
    expect(layer.getAttribute('preserveAspectRatio')).toBe('xMidYMid meet')
    expect(Number(marked.querySelector('circle')!.getAttribute('r'))).toBeCloseTo(8 * Math.max(1280 / 206, 800 / 138))
    // The other picture has none.
    const plain = screen.getByRole('button', { name: 'Open picture 2 of 2, from The checkout page' })
    expect(plain.querySelector('svg, .thread-media__callout-count')).toBeNull()
  })

  it('draws them over the picture in the viewer, moving with it, and lists their notes beside it as whose they are', async () => {
    await openViewer(null)
    const list = screen.getByRole('complementary', { name: 'Callouts from Codex' })
    expect(within(list).getByRole('heading', { name: 'Callouts from Codex' })).toBeTruthy()
    expect(notes(list)).toEqual(['The Pay button sits on top of the total.', 'The card number field has no label.'])
    // Long notes scroll, so the list is in Tab's path after the picture.
    expect(list.tabIndex).toBe(0)
    screen.getByRole('group', { name: 'Image view' }).focus()
    await userEvent.tab()
    expect(document.activeElement).toBe(list)
    const layer = document.querySelector<SVGElement>('.attachment-viewer__callout-layer')!
    expect(pins(layer)).toEqual(['1', '2'])
    // It takes the picture's own size and place, so zooming and moving the picture carry it along.
    const image = document.querySelector<HTMLImageElement>('.attachment-viewer img[src]')!
    expect(layer.getAttribute('width')).toBe(image.getAttribute('width'))
    expect(layer.getAttribute('style')).toBe(image.getAttribute('style'))
    // A picture with none has no list.
    await userEvent.keyboard('{ArrowRight}')
    expect(screen.queryByRole('complementary', { name: 'Callouts from Codex' })).toBeNull()
    expect(document.querySelector('.attachment-viewer__callout-layer')).toBeNull()
  })

  it('lists them in the editor, shows them while marking, and keeps them in the copy unless asked not to', async () => {
    const box = reply()
    await openViewer(box)
    await userEvent.click(screen.getByRole('button', { name: 'Mark up' }))
    const side = screen.getByRole('complementary', { name: 'Callouts and your marks' })
    expect(within(side).getByRole('heading', { name: 'Callouts from Codex' })).toBeTruthy()
    expect(notes(side)).toEqual(['The Pay button sits on top of the total.', 'The card number field has no label.'])
    const show = within(side).getByRole('checkbox', { name: 'Show' }) as HTMLInputElement
    const keep = within(side).getByRole('checkbox', { name: 'Keep the callouts in the copy' }) as HTMLInputElement
    expect([show.checked, keep.checked]).toEqual([true, true])
    expect(pins(document.querySelector('.markup-editor__surface')!)).toEqual(['1', '2'])
    // With the callouts kept, the copy is worth adding without a mark of the user's own, and it draws them under the marks.
    const add = screen.getByRole('button', { name: 'Add to reply' })
    expect(add.getAttribute('aria-disabled')).toBe('false')
    await userEvent.click(add)
    await waitFor(() => expect(box.added).toHaveLength(1))
    const under = vi.mocked(markedCopy).mock.calls[0]![4]
    expect(under).toBeTypeOf('function')
  })

  it('leaves them off the copy, and off the picture, when Show or Keep is unticked', async () => {
    await openViewer(reply())
    await userEvent.click(screen.getByRole('button', { name: 'Mark up' }))
    const keep = screen.getByRole('checkbox', { name: 'Keep the callouts in the copy' }) as HTMLInputElement
    await userEvent.click(keep)
    // Unkept, they no longer make the copy worth adding on their own.
    expect(screen.getByRole('button', { name: 'Add to reply' }).getAttribute('aria-disabled')).toBe('true')
    await userEvent.click(screen.getByRole('checkbox', { name: 'Show' }))
    expect(pins(document.querySelector('.markup-editor__surface')!)).toEqual([])
    expect(keep.disabled).toBe(true)
    expect(keep.checked).toBe(false)
  })

  it('puts no callout section in the editor for a picture without them', async () => {
    await openViewer(reply(), 2)
    await userEvent.click(screen.getByRole('button', { name: 'Mark up' }))
    expect(screen.getByRole('complementary', { name: 'Your marks' })).toBeTruthy()
    expect(screen.queryByRole('checkbox')).toBeNull()
  })
})

describe('a callout\'s shape', () => {
  it('is a share of the picture on a copy, and a fixed size on screen given how many of its pixels make one', () => {
    const shape = calloutGeometry(callouts[0]!, { width: 1280, height: 800 })
    expect(shape).toMatchObject({ x: 768, y: 384, width: 428.8, height: 92 })
    expect(shape.radius).toBeCloseTo(1280 / 55)
    expect(shape.line).toBeCloseTo(1280 / 260)
    const tile = calloutGeometry(callouts[0]!, { width: 1280, height: 800 }, 6)
    expect([tile.radius, tile.line]).toEqual([48, 9])
  })

  it('draws a dashed box, a pin and its number on a canvas, and leaves the canvas as it found it', () => {
    const calls: string[] = []
    const context = new Proxy({} as Record<string, unknown>, {
      get: (target, key: string) => key in target ? target[key] : (...args: unknown[]) => { calls.push(`${key}(${args.join(',')})`) },
      set: (target, key: string, value) => { target[key] = value; calls.push(`${key}=${String(value)}`); return true },
    }) as unknown as CanvasRenderingContext2D
    drawCallouts(context, [callouts[0]!], { width: 1280, height: 800 }, { accent: 'rgb(1, 2, 3)', onAccent: 'rgb(4, 5, 6)' })
    expect(calls[0]).toBe('save()')
    expect(calls.at(-1)).toBe('restore()')
    expect(calls).toContain('strokeStyle=rgb(1, 2, 3)')
    expect(calls).toContain('fillText(1,768,384)')
    expect(calls.find(call => call.startsWith('setLineDash('))).toBe(`setLineDash(${[1280 / 260 * 3, 1280 / 260 * 2].join(',')})`)
  })
})
