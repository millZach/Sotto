import { deferred } from '../../fixtures/deferred'
import React, { useState } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AGENT_MAX_ATTACHMENT_BYTES, SCREENSHOT_NOT_ITS_TYPE, SCREENSHOT_WRONG_TYPE, SCREENSHOT_TOO_LARGE, SCREENSHOTS_TOO_LARGE_IN_TOTAL, type AgentAttachmentHandle, type AgentAttachmentStageRequest } from '../../../src/shared/agents'
import { ScreenshotInput } from '../../../src/renderer/src/agents/ScreenshotInput'
import type { ScreenshotReadPort } from '../../../src/renderer/src/agents/threadDraftStore'
import { handleOf } from '../../fixtures/stagedImages'

/** Every staging the window asks main for, answered with the handle main would give. */
let staged: AgentAttachmentStageRequest[] = []
beforeEach(() => {
  staged = []
  vi.stubGlobal('sotto', { agents: { stageAttachment: vi.fn(async (request: AgentAttachmentStageRequest) => {
    staged.push(request); return { ...handleOf(request.bytes, crypto.randomUUID(), request.name, request.mimeType), ...(request.dimensions ? { dimensions: request.dimensions } : {}) }
  }) } })
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })
function Harness({ supported = true }: { supported?: boolean }) {
  const [images, setImages] = useState<AgentAttachmentHandle[]>([])
  return <ScreenshotInput target="workshop" attachments={images} onChange={setImages} disabled={false} supported={supported}><textarea aria-label="Prompt" /></ScreenshotInput>
}
const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10]
const file = () => new File([new Uint8Array(PNG_SIGNATURE)], 'shot.png', { type: 'image/png' })
const MB = 1024 * 1024
/** A small PNG that reports `size` bytes, so a test can cross the limits without allocating them. */
const sized = (name: string, size: number) => Object.defineProperty(new File([new Uint8Array(PNG_SIGNATURE)], name, { type: 'image/png' }), 'size', { value: size })
/** A draft store's side of the input's reads, recording what it is told. */
const port = (overrides: Partial<ScreenshotReadPort> = {}): ScreenshotReadPort => ({ pending: false, problem: null, begin: vi.fn(() => () => undefined), addLate: vi.fn(), ...overrides })
/** An attachment already on the composer whose content is `bytes` long. */
const attached = (id: string, bytes: number): AgentAttachmentHandle => ({ id, name: `${id}.png`, mimeType: 'image/png', sizeBytes: bytes, digest: 'a'.repeat(64) })

describe('screenshot attachment input', () => {
  it('stages a screenshot once, for the thread it is attached to, and allows removal before delivery', async () => {
    render(<Harness />)
    fireEvent.change(screen.getByLabelText('Screenshot files'), { target: { files: [file()] } })
    // The chip names the image while its thumbnail is made, and keeps the name once it shows.
    await waitFor(() => expect(screen.getByRole('img', { name: 'shot.png' })).toBeVisible())
    expect(staged).toEqual([expect.objectContaining({ threadId: 'workshop', name: 'shot.png', mimeType: 'image/png', bytes: new Uint8Array(PNG_SIGNATURE) })])
    fireEvent.click(screen.getByRole('button', { name: 'Remove shot.png' }))
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
  })
  it('accepts pasted screenshot files without inserting clipboard text', async () => {
    render(<Harness />)
    fireEvent.paste(screen.getByRole('textbox'), { clipboardData: { items: [{ kind: 'file', getAsFile: file }] } })
    await waitFor(() => expect(screen.getByRole('img', { name: 'shot.png' })).toBeVisible())
    expect(screen.getByRole('textbox')).toHaveValue('')
  })
  it('rejects unsupported files and models with useful feedback', async () => {
    const view = render(<Harness />)
    fireEvent.change(screen.getByLabelText('Screenshot files'), { target: { files: [new File(['text'], 'note.txt', { type: 'text/plain' })] } })
    expect(await screen.findByRole('alert')).toHaveTextContent(SCREENSHOT_WRONG_TYPE)
    view.rerender(<Harness supported={false} />)
    expect(screen.getByRole('button', { name: 'Attach screenshots' })).toBeDisabled()
    fireEvent.paste(screen.getByRole('textbox'), { clipboardData: { items: [{ kind: 'file', getAsFile: file }] } })
    expect(screen.getByRole('alert')).toHaveTextContent('does not support screenshots')
    expect(staged).toEqual([])
  })
  it('names the screenshot that could not be added, adds the ones before it, and says the rest were not attached', async () => {
    let calls = 0
    vi.stubGlobal('sotto', { agents: { stageAttachment: vi.fn(async (request: AgentAttachmentStageRequest) => {
      calls += 1
      if (calls === 2) throw new Error('STAGE_FAILED')
      return handleOf(request.bytes, crypto.randomUUID(), request.name, request.mimeType)
    }) } })
    const change = vi.fn()
    render(<ScreenshotInput target="workshop" attachments={[]} onChange={change} disabled={false} supported><textarea aria-label="Prompt" /></ScreenshotInput>)
    fireEvent.change(screen.getByLabelText('Screenshot files'), { target: { files: ['a.png', 'b.png', 'c.png'].map(name => new File([new Uint8Array(PNG_SIGNATURE)], name, { type: 'image/png' })) } })
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not add b.png, so it and the 1 after it were not attached. Try adding them again.')
    expect(change).toHaveBeenCalledWith([expect.objectContaining({ name: 'a.png' })])
    expect(calls).toBe(2)
  })
  it('gives staging\'s reason after naming what was not attached, without claiming nothing was', async () => {
    let calls = 0
    vi.stubGlobal('sotto', { agents: { stageAttachment: vi.fn(async (request: AgentAttachmentStageRequest) => {
      calls += 1
      if (calls === 2) throw new Error('This host is disconnected. Connect again before attaching images. Nothing was attached.')
      return handleOf(request.bytes, crypto.randomUUID(), request.name, request.mimeType)
    }) } })
    render(<Harness />)
    fireEvent.change(screen.getByLabelText('Screenshot files'), { target: { files: ['a.png', 'b.png'].map(name => new File([new Uint8Array(PNG_SIGNATURE)], name, { type: 'image/png' })) } })
    expect(await screen.findByRole('alert')).toHaveTextContent(/^Could not add b\.png, so it was not attached\. This host is disconnected\. Connect again before attaching images\.$/u)
    expect(screen.getByRole('img', { name: 'a.png' })).toBeVisible()
  })
  it('says so when main refuses to stage an image, and attaches nothing', async () => {
    vi.stubGlobal('sotto', { agents: { stageAttachment: vi.fn(async () => { throw new Error(SCREENSHOT_NOT_ITS_TYPE) }) } })
    const change = vi.fn()
    render(<ScreenshotInput target="workshop" attachments={[]} onChange={change} disabled={false} supported><textarea aria-label="Prompt" /></ScreenshotInput>)
    fireEvent.change(screen.getByLabelText('Screenshot files'), { target: { files: [file()] } })
    expect(await screen.findByRole('alert')).toHaveTextContent(SCREENSHOT_NOT_ITS_TYPE)
    expect(change).not.toHaveBeenCalled()
  })
  it('refuses dropped screenshots that total more than 20 MB before staging any of them', () => {
    const change = vi.fn()
    const read = vi.fn(() => () => undefined)
    render(<ScreenshotInput target="workshop" attachments={[]} onChange={change} reads={port({ begin: read })} disabled={false} supported><textarea aria-label="Prompt" /></ScreenshotInput>)
    fireEvent.drop(screen.getByRole('textbox'), { dataTransfer: { files: [sized('a.png', 8 * MB), sized('b.png', 8 * MB), sized('c.png', 8 * MB)], types: ['Files'] } })
    expect(screen.getByRole('alert')).toHaveTextContent(SCREENSHOTS_TOO_LARGE_IN_TOTAL)
    expect(staged).toEqual([])
    expect(read).not.toHaveBeenCalled()
    expect(change).not.toHaveBeenCalled()
  })
  it('counts the screenshots already attached toward the 20 MB total', () => {
    const change = vi.fn()
    render(<ScreenshotInput target="workshop" attachments={[attached('kept-a', 9 * MB), attached('kept-b', 9 * MB)]} onChange={change} disabled={false} supported><textarea aria-label="Prompt" /></ScreenshotInput>)
    fireEvent.drop(screen.getByRole('textbox'), { dataTransfer: { files: [sized('c.png', 3 * MB)], types: ['Files'] } })
    expect(screen.getByRole('alert')).toHaveTextContent('must total 20 MB or less')
    expect(staged).toEqual([])
    expect(change).not.toHaveBeenCalled()
  })
  it('still stages screenshots that total exactly 20 MB', async () => {
    const change = vi.fn()
    render(<ScreenshotInput target="workshop" attachments={[]} onChange={change} disabled={false} supported><textarea aria-label="Prompt" /></ScreenshotInput>)
    fireEvent.drop(screen.getByRole('textbox'), { dataTransfer: { files: [sized('a.png', AGENT_MAX_ATTACHMENT_BYTES / 2), sized('b.png', AGENT_MAX_ATTACHMENT_BYTES / 2)], types: ['Files'] } })
    await waitFor(() => expect(change).toHaveBeenCalledWith([expect.objectContaining({ name: 'a.png' }), expect.objectContaining({ name: 'b.png' })]))
    expect(staged).toHaveLength(2)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
  it('names the oversized screenshot rather than the total when one file is over 10 MB', () => {
    render(<Harness />)
    fireEvent.drop(screen.getByRole('textbox'), { dataTransfer: { files: [sized('huge.png', 25 * MB)], types: ['Files'] } })
    expect(screen.getByRole('alert')).toHaveTextContent(SCREENSHOT_TOO_LARGE)
    expect(staged).toEqual([])
  })
  it('does not attach an in-flight staging to a thread after the input unmounts', async () => {
    const change = vi.fn()
    const handedOn = vi.fn()
    const reads = port({ begin: () => handedOn })
    delete reads.addLate
    const view = render(<ScreenshotInput target="workshop" attachments={[]} onChange={change} reads={reads} disabled={false} supported><textarea /></ScreenshotInput>)
    fireEvent.change(screen.getByLabelText('Screenshot files'), { target: { files: [file()] } })
    view.unmount()
    // The read is over only once its screenshots have been handed on, or dropped for want of a draft to take them.
    await waitFor(() => expect(handedOn).toHaveBeenCalledOnce())
    expect(change).not.toHaveBeenCalled()
  })
  it('adds nothing and says it is still adding while an earlier input reads for the same draft', () => {
    const read = vi.fn(() => () => undefined)
    render(<ScreenshotInput target="workshop" attachments={[]} onChange={vi.fn()} reads={port({ begin: read, pending: true })} disabled={false} supported><textarea aria-label="Prompt" /></ScreenshotInput>)
    expect(screen.getByRole('status')).toHaveTextContent('Adding screenshots...')
    expect(screen.getByRole('button', { name: 'Attach screenshots' })).toBeDisabled()
    fireEvent.paste(screen.getByRole('textbox'), { clipboardData: { items: [{ kind: 'file', getAsFile: file }] } })
    expect(read).not.toHaveBeenCalled()
  })
  it('shows what became of screenshots an earlier input read', () => {
    render(<ScreenshotInput target="workshop" attachments={[]} onChange={vi.fn()} reads={port({ problem: 'A screenshot did not fit.' })} disabled={false} supported><textarea aria-label="Prompt" /></ScreenshotInput>)
    expect(screen.getByRole('alert')).toHaveTextContent('A screenshot did not fit.')
  })
})

/**
 * Chromium's decoder and offscreen canvas, as far as the composer uses them: each file decodes to the size
 * `sizes` gives its name, and a canvas writes a short blob of whatever type it is asked for.
 */
function stubCanvas(sizes: Record<string, { width: number, height: number }>) {
  const drawn: { width: number, height: number, type: string }[] = []
  vi.stubGlobal('createImageBitmap', async (source: File) => ({ ...sizes[source.name]!, close: () => undefined }))
  vi.stubGlobal('OffscreenCanvas', class {
    constructor(readonly width: number, readonly height: number) {}
    getContext() { return { drawImage: () => undefined } }
    async convertToBlob({ type }: { type: string }) { drawn.push({ width: this.width, height: this.height, type }); return new Blob([new Uint8Array(12)], { type }) }
  })
  return drawn
}
const screenshotOf = (name: string, type: string) => new File([new Uint8Array(4096)], name, { type })
/** How many bytes main was handed to stage for the most recent screenshot: what is sent, scaled or not. */
const stagedBytes = () => staged.at(-1)!.bytes.byteLength
async function attach(name: string, type: string): Promise<{ attachment: AgentAttachmentHandle, change: ReturnType<typeof vi.fn>, rerender: (attachments: AgentAttachmentHandle[]) => void }> {
  const change = vi.fn()
  const input = (attachments: AgentAttachmentHandle[]) => <ScreenshotInput target="workshop" attachments={attachments} onChange={change} disabled={false} supported><textarea aria-label="Prompt" /></ScreenshotInput>
  const view = render(input([]))
  fireEvent.change(screen.getByLabelText('Screenshot files'), { target: { files: [screenshotOf(name, type)] } })
  await waitFor(() => expect(change).toHaveBeenCalledTimes(1))
  const [attachment] = change.mock.calls[0]![0] as AgentAttachmentHandle[]
  return { attachment: attachment!, change, rerender: attachments => view.rerender(input(attachments)) }
}

describe('scaling screenshots down to the bound', () => {
  it('scales a 3840x2160 PNG to 2576x1449, keeps it a PNG and says so on its chip', async () => {
    const drawn = stubCanvas({ '4k.png': { width: 3840, height: 2160 } })
    const { attachment, rerender } = await attach('4k.png', 'image/png')
    expect(drawn).toEqual([{ width: 2576, height: 1449, type: 'image/png' }])
    expect(attachment).toMatchObject({ name: '4k.png', mimeType: 'image/png', dimensions: { original: { width: 3840, height: 2160 }, sent: { width: 2576, height: 1449 } } })
    // The scaled copy is what main stages, and the handle carries both sizes (ADR-0031).
    expect(staged.at(-1)).toMatchObject({ mimeType: 'image/png', dimensions: attachment.dimensions })
    expect(stagedBytes()).toBe(12)
    rerender([attachment])
    // Both sizes are on the chip itself, where a keyboard user sees them too, and a screen reader reads them as words.
    expect(screen.getByText('Resized from 3840 x 2160 to 2576 x 1449', { exact: true })).toBeVisible()
    expect(screen.getByText('Resized from 3840 x 2160 to 2576 x 1449', { exact: true }).parentElement).not.toHaveAttribute('title')
    expect(screen.getByText('Resized from 3840 by 2160 to 2576 by 1449 pixels')).toHaveClass('tt-visually-hidden')
  })
  it('hands a 1200x800 PNG on byte for byte and shows no note', async () => {
    const drawn = stubCanvas({ 'small.png': { width: 1200, height: 800 } })
    const { attachment, rerender } = await attach('small.png', 'image/png')
    expect(drawn).toEqual([])
    expect(stagedBytes()).toBe(4096)
    expect(attachment.dimensions).toEqual({ original: { width: 1200, height: 800 }, sent: { width: 1200, height: 800 } })
    rerender([attachment])
    expect(screen.getByRole('img', { name: 'small.png' })).toBeVisible()
    expect(screen.queryByText(/^Resized/u)).not.toBeInTheDocument()
  })
  it('keeps a JPEG a JPEG', async () => {
    const drawn = stubCanvas({ 'photo.jpg': { width: 4032, height: 3024 } })
    const { attachment } = await attach('photo.jpg', 'image/jpeg')
    expect(drawn).toEqual([{ width: 2576, height: 1932, type: 'image/jpeg' }])
    expect(attachment).toMatchObject({ mimeType: 'image/jpeg', dimensions: { sent: { width: 2576, height: 1932 } } })
    expect(staged.at(-1)).toMatchObject({ mimeType: 'image/jpeg' })
  })
})

describe('reading several screenshots at once', () => {
  it('decodes one at a time, so at most one decoded image is in memory', async () => {
    let alive = 0, most = 0
    // Each decode waits until the test lets it finish, so a second one started meanwhile would be seen.
    const decodes: (() => void)[] = []
    vi.stubGlobal('createImageBitmap', async () => {
      alive += 1; most = Math.max(most, alive)
      await (() => { const pending = deferred<void>(); decodes.push(pending.resolve); return pending.promise })()
      return { width: 3840, height: 2160, close: () => { alive -= 1 } }
    })
    vi.stubGlobal('OffscreenCanvas', class {
      constructor(readonly width: number, readonly height: number) {}
      getContext() { return { drawImage: () => undefined } }
      async convertToBlob({ type }: { type: string }) { return new Blob([new Uint8Array(12)], { type }) }
    })
    const change = vi.fn()
    render(<ScreenshotInput target="workshop" attachments={[]} onChange={change} disabled={false} supported><textarea aria-label="Prompt" /></ScreenshotInput>)
    const files = ['a', 'b', 'c', 'd'].map(name => screenshotOf(`${name}.png`, 'image/png'))
    fireEvent.change(screen.getByLabelText('Screenshot files'), { target: { files } })
    for (let finished = 0; finished < files.length; finished += 1) {
      await waitFor(() => expect(decodes).toHaveLength(finished + 1))
      // Every decode started so far is still held, and only one has started.
      expect(alive).toBe(1)
      decodes[finished]!()
    }
    await waitFor(() => expect(change).toHaveBeenCalledTimes(1))
    expect((change.mock.calls[0]![0] as AgentAttachmentHandle[]).map(image => image.name)).toEqual(['a.png', 'b.png', 'c.png', 'd.png'])
    expect(most).toBe(1)
    expect(alive).toBe(0)
  })
  it('hands screenshots that finish reading after the composer closes to the draft they were attached to', async () => {
    const change = vi.fn()
    const late = vi.fn()
    const view = render(<ScreenshotInput target="workshop" attachments={[]} onChange={change} reads={port({ addLate: late })} disabled={false} supported><textarea /></ScreenshotInput>)
    fireEvent.change(screen.getByLabelText('Screenshot files'), { target: { files: [file()] } })
    view.unmount()
    await waitFor(() => expect(late).toHaveBeenCalledWith([expect.objectContaining({ name: 'shot.png', digest: expect.stringMatching(/^[a-f0-9]{64}$/u) })], null))
    expect(change).not.toHaveBeenCalled()
  })
  it('hands the draft what was read and the failure when a screenshot fails after the composer closed', async () => {
    let calls = 0
    vi.stubGlobal('sotto', { agents: { stageAttachment: vi.fn(async (request: AgentAttachmentStageRequest) => {
      calls += 1
      if (calls === 2) throw new Error('STAGE_FAILED')
      return handleOf(request.bytes, crypto.randomUUID(), request.name, request.mimeType)
    }) } })
    const late = vi.fn()
    const view = render(<ScreenshotInput target="workshop" attachments={[]} onChange={vi.fn()} reads={port({ addLate: late })} disabled={false} supported><textarea /></ScreenshotInput>)
    fireEvent.change(screen.getByLabelText('Screenshot files'), { target: { files: ['a.png', 'b.png'].map(name => new File([new Uint8Array(PNG_SIGNATURE)], name, { type: 'image/png' })) } })
    view.unmount()
    await waitFor(() => expect(late).toHaveBeenCalledWith([expect.objectContaining({ name: 'a.png' })], 'Could not add b.png, so it was not attached. Try adding it again.'))
  })
})
