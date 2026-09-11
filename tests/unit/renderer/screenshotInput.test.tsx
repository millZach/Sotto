import React, { useState } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentAttachment } from '../../../src/shared/agents'
import { ScreenshotInput } from '../../../src/renderer/src/agents/ScreenshotInput'

afterEach(cleanup)
function Harness({ supported = true }: { supported?: boolean }) {
  const [images, setImages] = useState<AgentAttachment[]>([])
  return <ScreenshotInput attachments={images} onChange={setImages} disabled={false} supported={supported}><textarea aria-label="Prompt" /></ScreenshotInput>
}
const file = () => new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], 'shot.png', { type: 'image/png' })
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
