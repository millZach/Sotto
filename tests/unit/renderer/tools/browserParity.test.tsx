// The full browser's pane pieces (ADR-0220): the page's dialog answered at its foot, the recording line with Stop, the
// More menu's devices and colours, and the servers Sotto started, offered with no page open.
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BrowserBridge, BrowserPage } from '../../../../src/shared/browser'
import type { ToolsResult } from '../../../../src/shared/tools'
import { DialogStrip, LocalServers, parityMenuGroups, recordingClock, RecordingLine } from '../../../../src/renderer/src/tools/BrowserParity'
import { BrowserStore } from '../../../../src/renderer/src/tools/browserStore'
import { browserPage } from '../../../fixtures/renderer/browserBridge'
import { TOKEN_A } from '../../../fixtures/renderer/fakeFilesBridge'

afterEach(() => { cleanup(); vi.restoreAllMocks() })
const workspace = { threadId: 'workshop', projectId: 'p', workingDirectory: 'D:\\work', workspaceId: TOKEN_A }
const ok = <T,>(value: T): ToolsResult<T> => ({ ok: true, value })
const page = (patch: Partial<BrowserPage> = {}): BrowserPage => browserPage(workspace, patch)
const words = { device: (name: string) => `Show as ${name}`, rotate: (landscape: boolean) => landscape ? 'Rotate to landscape' : 'Rotate to portrait', scheme: (scheme: string) => `Page ${scheme}` }

describe('the page\'s dialog in the pane', () => {
  it('shows the page\'s words and answers with OK, focusing it first', async () => {
    const answerDialog = vi.fn<NonNullable<BrowserBridge['answerDialog']>>(async () => ok(page({ dialog: null })))
    const store = new BrowserStore(); const adopt = vi.spyOn(store, 'adopt')
    render(<DialogStrip page={page({ dialog: { type: 'confirm', message: 'Ship it?' } })} threadId="workshop" store={store} bridge={{ answerDialog } as unknown as BrowserBridge} />)
    expect(screen.getByRole('group', { name: /The page asks\s*Ship it\?/u })).toBeTruthy()
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'OK' })))
    fireEvent.click(screen.getByRole('button', { name: 'OK' }))
    await waitFor(() => expect(answerDialog).toHaveBeenCalledWith({ threadId: 'workshop', workspaceId: TOKEN_A, pageId: '11111111-1111-4111-8111-111111111111', accept: true }))
    await waitFor(() => expect(adopt).toHaveBeenCalled())
  })

  it('answers Escape as Cancel from any of its controls', async () => {
    const answerDialog = vi.fn<NonNullable<BrowserBridge['answerDialog']>>(async () => ok(page({ dialog: null })))
    render(<DialogStrip page={page({ dialog: { type: 'confirm', message: 'Ship it?' } })} threadId="workshop" store={new BrowserStore()} bridge={{ answerDialog } as unknown as BrowserBridge} />)
    const cancel = screen.getByRole('button', { name: 'Cancel' })
    cancel.focus()
    fireEvent.keyDown(cancel, { key: 'Escape' })
    await waitFor(() => expect(answerDialog).toHaveBeenCalledWith(expect.objectContaining({ accept: false })))
    expect(answerDialog).toHaveBeenCalledTimes(1)
  })

  it('takes a prompt\'s text, offers Cancel, and leaves out Cancel for an alert', async () => {
    const answerDialog = vi.fn<NonNullable<BrowserBridge['answerDialog']>>(async () => ok(page()))
    const bridge = { answerDialog } as unknown as BrowserBridge
    const { rerender } = render(<DialogStrip page={page({ dialog: { type: 'prompt', message: 'Your name?', defaultPrompt: 'Ada' } })} threadId="workshop" store={new BrowserStore()} bridge={bridge} />)
    const field = screen.getByRole('textbox', { name: 'Your answer to the page' }) as HTMLInputElement
    expect(field.value).toBe('Ada')
    fireEvent.change(field, { target: { value: 'Rez' } })
    fireEvent.click(screen.getByRole('button', { name: 'OK' }))
    await waitFor(() => expect(answerDialog).toHaveBeenLastCalledWith(expect.objectContaining({ accept: true, promptText: 'Rez' })))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(answerDialog).toHaveBeenLastCalledWith(expect.not.objectContaining({ promptText: expect.anything() })))
    rerender(<DialogStrip page={page({ dialog: { type: 'alert', message: 'Saved' } })} threadId="workshop" store={new BrowserStore()} bridge={bridge} />)
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull()
    rerender(<DialogStrip page={page({ dialog: { type: 'beforeunload', message: '' } })} threadId="workshop" store={new BrowserStore()} bridge={bridge} />)
    expect(screen.getByRole('button', { name: 'Leave' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Stay' })).toBeTruthy()
  })

  it('says why when the window cannot answer, and shows nothing with no dialog', async () => {
    const { container, rerender } = render(<DialogStrip page={page()} threadId="workshop" store={new BrowserStore()} bridge={undefined} />)
    expect(container.textContent).toBe('')
    rerender(<DialogStrip page={page({ dialog: { type: 'alert', message: 'Hi' } })} threadId="workshop" store={new BrowserStore()} bridge={undefined} />)
    fireEvent.click(screen.getByRole('button', { name: 'OK' }))
    expect((await screen.findByRole('alert')).textContent).toContain('cannot answer')
  })
})

describe('the recording line', () => {
  it('counts minutes and seconds from the start', () => {
    expect(recordingClock(1000, 1000)).toBe('0:00')
    expect(recordingClock(1000, 66_500)).toBe('1:05')
    expect(recordingClock(5000, 1000)).toBe('0:00')
  })

  it('shows while a page records, and Stop keeps the video', async () => {
    const stopRecording = vi.fn<NonNullable<BrowserBridge['stopRecording']>>(async () => ok(page({ recording: null })))
    render(<RecordingLine page={page({ recording: { startedAt: Date.now() - 3000 } })} threadId="workshop" store={new BrowserStore()} bridge={{ stopRecording } as unknown as BrowserBridge} />)
    expect(screen.getByText('Recording this page')).toBeTruthy()
    expect(screen.getByText(/0:0[34]/u)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
    await waitFor(() => expect(stopRecording).toHaveBeenCalledWith({ threadId: 'workshop', workspaceId: TOKEN_A, pageId: '11111111-1111-4111-8111-111111111111' }))
  })
})

describe('the More menu\'s devices and colours', () => {
  it('checks the shown preset and offers Rotate, and the page\'s colour scheme', () => {
    const run = vi.fn()
    const [devices, schemes] = parityMenuGroups(page({ viewport: { width: 844, height: 390, preset: 'iphone-12-pro', orientation: 'landscape' }, appearance: 'dark' }), words, run, false, true)
    expect(devices!.find(item => item.id === 'preset-iphone-12-pro')?.checked).toBe(true)
    expect(devices!.filter(item => item.checked)).toHaveLength(1)
    const rotate = devices!.find(item => item.id === 'rotate')!
    expect(rotate.label).toBe('Rotate to portrait')
    rotate.run()
    expect(run).toHaveBeenLastCalledWith({ preset: 'iphone-12-pro', orientation: 'portrait' })
    expect(schemes!.find(item => item.checked)?.id).toBe('scheme-dark')
    schemes!.find(item => item.id === 'scheme-auto')!.run()
    expect(run).toHaveBeenLastCalledWith({ appearance: null })
  })

  it('offers no Rotate without a preset, keeps a preset the menu does not list, and leaves devices out on a host', () => {
    const [plain] = parityMenuGroups(page(), words, vi.fn(), false, true)
    expect(plain!.some(item => item.id === 'rotate')).toBe(false)
    expect(plain!.find(item => item.id === 'preset-iphone-se')?.label).toBe('Show as iPhone SE')
    const [listed] = parityMenuGroups(page({ viewport: { width: 1024, height: 600, preset: 'nest-hub', orientation: 'portrait' } }), words, vi.fn(), false, true)
    expect(listed!.find(item => item.id === 'preset-nest-hub')?.checked).toBe(true)
    const host = parityMenuGroups(page(), words, vi.fn(), false, false)
    expect(host).toHaveLength(1)
    expect(host[0]!.every(item => item.id.startsWith('scheme-'))).toBe(true)
  })
})

describe('servers Sotto started', () => {
  it('lists them with their titles and opens one', async () => {
    const localServers = vi.fn<NonNullable<BrowserBridge['localServers']>>(async () => ok([{ port: 5173, url: 'http://localhost:5173/', title: 'Fieldnotes', process: 'node.exe' }]))
    const onOpen = vi.fn()
    render(<LocalServers threadId="workshop" workspaceId={TOKEN_A} bridge={{ localServers } as unknown as BrowserBridge} disabled={false} onOpen={onOpen} />)
    expect(screen.getByRole('heading', { name: 'Servers started from Sotto' })).toBeTruthy()
    fireEvent.click(await screen.findByRole('button', { name: 'Open localhost:5173' }))
    expect(onOpen).toHaveBeenCalledWith('http://localhost:5173/')
    expect(localServers).toHaveBeenCalledWith({ threadId: 'workshop', workspaceId: TOKEN_A })
    fireEvent.click(screen.getByRole('button', { name: 'Look for local servers again' }))
    await waitFor(() => expect(localServers).toHaveBeenCalledTimes(2))
  })

  it('says when none answers, and shows nothing without a workspace or a bridge that lists', async () => {
    const localServers = vi.fn<NonNullable<BrowserBridge['localServers']>>(async () => ok([]))
    const { rerender, container } = render(<LocalServers threadId="workshop" workspaceId={TOKEN_A} bridge={{ localServers } as unknown as BrowserBridge} disabled={false} onOpen={vi.fn()} />)
    expect(await screen.findByText(/No web server started from Sotto is answering/u)).toBeTruthy()
    rerender(<LocalServers threadId="workshop" workspaceId={null} bridge={{ localServers } as unknown as BrowserBridge} disabled={false} onOpen={vi.fn()} />)
    expect(container.textContent).toBe('')
    rerender(<LocalServers threadId="workshop" workspaceId={TOKEN_A} bridge={{} as BrowserBridge} disabled={false} onOpen={vi.fn()} />)
    expect(container.textContent).toBe('')
  })
})
