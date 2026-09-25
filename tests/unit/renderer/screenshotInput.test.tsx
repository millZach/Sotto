import React, { useState } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AGENT_MAX_ATTACHMENT_BYTES, type AgentAttachment } from '../../../src/shared/agents'
import { ScreenshotInput } from '../../../src/renderer/src/agents/ScreenshotInput'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })
function Harness({ supported = true }: { supported?: boolean }) {
  const [images, setImages] = useState<AgentAttachment[]>([])
  return <ScreenshotInput attachments={images} onChange={setImages} disabled={false} supported={supported}><textarea aria-label="Prompt" /></ScreenshotInput>
}
const file = () => new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], 'shot.png', { type: 'image/png' })
const MB = 1024 * 1024
/** A small PNG that reports `size` bytes, so a test can cross the limits without allocating them. */
const sized = (name: string, size: number) => Object.defineProperty(new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], name, { type: 'image/png' }), 'size', { value: size })
/** An attachment already on the composer that decodes to `bytes` bytes. */
const attached = (id: string, bytes: number): AgentAttachment => ({ id, name: `${id}.png`, mimeType: 'image/png', dataUrl: `data:image/png;base64,${'A'.repeat(bytes / 3 * 4)}` })
/** Counts every FileReader constructed while the test runs. */
function countReaders(): { count: number } {
  const readers = { count: 0 }
  const Original = globalThis.FileReader
  vi.stubGlobal('FileReader', class extends Original { constructor() { super(); readers.count += 1 } })
  return readers
}
describe('screenshot attachment input', () => {
  it('reads a screenshot and allows removal before delivery', async () => {
    render(<Harness />)
    fireEvent.change(screen.getByLabelText('Screenshot files'), { target: { files: [file()] } })
    expect(await screen.findByRole('img', { name: 'shot.png' })).toHaveAttribute('src', expect.stringContaining('data:image/png;base64,'))
    fireEvent.click(screen.getByRole('button', { name: 'Remove shot.png' }))
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
  })
  it('accepts pasted screenshot files without inserting clipboard text', async () => {
    render(<Harness />)
    fireEvent.paste(screen.getByRole('textbox'), { clipboardData: { items: [{ kind: 'file', getAsFile: file }] } })
    expect(await screen.findByRole('img', { name: 'shot.png' })).toBeVisible()
    expect(screen.getByRole('textbox')).toHaveValue('')
  })
  it('rejects unsupported files and models with useful feedback', async () => {
    const view = render(<Harness />)
    fireEvent.change(screen.getByLabelText('Screenshot files'), { target: { files: [new File(['text'], 'note.txt', { type: 'text/plain' })] } })
    expect(await screen.findByRole('alert')).toHaveTextContent('PNG, JPEG, GIF, or WebP')
    view.rerender(<Harness supported={false} />)
    expect(screen.getByRole('button', { name: 'Attach screenshots' })).toBeDisabled()
    fireEvent.paste(screen.getByRole('textbox'), { clipboardData: { items: [{ kind: 'file', getAsFile: file }] } })
    expect(screen.getByRole('alert')).toHaveTextContent('does not support screenshots')
  })
  it('refuses dropped screenshots that total more than 20 MB before reading any of them', () => {
    const readers = countReaders()
    const change = vi.fn()
    const reading = vi.fn()
    render(<ScreenshotInput attachments={[]} onChange={change} onReadingChange={reading} disabled={false} supported><textarea aria-label="Prompt" /></ScreenshotInput>)
    fireEvent.drop(screen.getByRole('textbox'), { dataTransfer: { files: [sized('a.png', 8 * MB), sized('b.png', 8 * MB), sized('c.png', 8 * MB)], types: ['Files'] } })
    expect(screen.getByRole('alert')).toHaveTextContent('Screenshots must total 20 MB or less. Remove an image or choose smaller files.')
    expect(readers.count).toBe(0)
    expect(reading).not.toHaveBeenCalledWith(true)
    expect(change).not.toHaveBeenCalled()
  })
  it('counts the screenshots already attached toward the 20 MB total', () => {
    const readers = countReaders()
    const change = vi.fn()
    render(<ScreenshotInput attachments={[attached('kept-a', 9 * MB), attached('kept-b', 9 * MB)]} onChange={change} disabled={false} supported><textarea aria-label="Prompt" /></ScreenshotInput>)
    fireEvent.drop(screen.getByRole('textbox'), { dataTransfer: { files: [sized('c.png', 3 * MB)], types: ['Files'] } })
    expect(screen.getByRole('alert')).toHaveTextContent('must total 20 MB or less')
    expect(readers.count).toBe(0)
    expect(change).not.toHaveBeenCalled()
  })
  it('still reads screenshots that total exactly 20 MB', async () => {
    const readers = countReaders()
    const change = vi.fn()
    render(<ScreenshotInput attachments={[]} onChange={change} disabled={false} supported><textarea aria-label="Prompt" /></ScreenshotInput>)
    fireEvent.drop(screen.getByRole('textbox'), { dataTransfer: { files: [sized('a.png', AGENT_MAX_ATTACHMENT_BYTES / 2), sized('b.png', AGENT_MAX_ATTACHMENT_BYTES / 2)], types: ['Files'] } })
    await waitFor(() => expect(change).toHaveBeenCalledWith([expect.objectContaining({ name: 'a.png' }), expect.objectContaining({ name: 'b.png' })]))
    expect(readers.count).toBe(2)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
  it('names the oversized screenshot rather than the total when one file is over 10 MB', () => {
    const readers = countReaders()
    render(<Harness />)
    fireEvent.drop(screen.getByRole('textbox'), { dataTransfer: { files: [sized('huge.png', 25 * MB)], types: ['Files'] } })
    expect(screen.getByRole('alert')).toHaveTextContent('Each screenshot must be 10 MB or smaller.')
    expect(readers.count).toBe(0)
  })
  it('does not attach an in-flight file read to a thread after the input unmounts', async () => {
    const change = vi.fn()
    const reading = vi.fn()
    const view = render(<ScreenshotInput attachments={[]} onChange={change} onReadingChange={reading} disabled={false} supported><textarea /></ScreenshotInput>)
    fireEvent.change(screen.getByLabelText('Screenshot files'), { target: { files: [file()] } })
    view.unmount()
    await waitFor(() => expect(reading).toHaveBeenLastCalledWith(false))
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(change).not.toHaveBeenCalled()
  })
})
