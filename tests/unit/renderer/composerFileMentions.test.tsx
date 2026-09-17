import React from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AgentCommand, AgentState } from '../../../src/shared/agents'
import type { FileListing, FilesBridge } from '../../../src/shared/files'
import { E2E_THREADS_NOW } from '../../../src/shared/e2e'
import { useAgents } from '../../../src/renderer/src/agents/AgentContext'
import { ThreadsView } from '../../../src/renderer/src/agents/ThreadsView'
import { ThreadDraftStore } from '../../../src/renderer/src/agents/threadDraftStore'
import { agentFileReferenceSchema } from '../../../src/shared/agentFiles'
import {
  browseFolder, detectFileTrigger, fileLimitReached, fileQueryParts, insertFile, MAX_MENTIONED_FILES,
  retainFileReferences, searchFileEntries, unmentionableCount, type FileEntry,
} from '../../../src/renderer/src/agents/composerFiles'
import { FilePicker, type FilePickerModel } from '../../../src/renderer/src/agents/FilePicker'
import { liveAgentState, threadsStateFixture } from './liveAgentState'

vi.mock('../../../src/renderer/src/agents/AgentContext', () => ({ useAgents: vi.fn() }))

const NOW = E2E_THREADS_NOW
const THREAD = 'grok-previews'
const WORKSPACE = 'a'.repeat(64)

// What the Files service lists for this thread's working copy, boundary already applied by main.
const FOLDERS: Record<string, FileEntry[]> = {
  '': [
    { name: 'src', path: 'src', kind: 'directory' },
    { name: 'README.md', path: 'README.md', kind: 'file' },
    { name: '.git', path: '.git', kind: 'directory' },
    { name: 'dangling', path: 'dangling', kind: 'unavailable' },
    { name: 'release notes.md', path: 'release notes.md', kind: 'file' },
  ],
  src: [
    { name: 'app.ts', path: 'src/app.ts', kind: 'file' },
    { name: 'app.css', path: 'src/app.css', kind: 'file' },
  ],
}

function filesBridge(): { bridge: FilesBridge; list: ReturnType<typeof vi.fn> } {
  const list = vi.fn(async ({ path }: { path: string }) => {
    const entries = FOLDERS[path]
    if (!entries) return { ok: false as const, error: { code: 'path-unavailable' as const, message: 'This path is unavailable.' } }
    const value: FileListing = { workspace: { threadId: THREAD, projectId: 'workshop', workingDirectory: 'C:/workshop', workspaceId: WORKSPACE }, path, entries, truncated: false }
    return { ok: true as const, value }
  })
  const unsupported = vi.fn(async () => ({ ok: false as const, error: { code: 'unavailable' as const, message: 'no' } }))
  return { bridge: { list, preview: unsupported, copyPath: unsupported, reveal: unsupported } as unknown as FilesBridge, list }
}

function mount() {
  const state: AgentState = threadsStateFixture()
  state.assignments = []
  state.activeThreadId = THREAD
  const live = liveAgentState(state)
  vi.mocked(useAgents).mockImplementation(live.useLive)
  render(<ThreadsView onOpenAgents={vi.fn()} now={NOW} />)
  return { live, prompt: () => screen.getByRole('textbox', { name: 'Prompt', exact: true }) as HTMLTextAreaElement }
}

const requests = <T extends AgentCommand['type']>(live: ReturnType<typeof liveAgentState>, type: T): Extract<AgentCommand, { type: T }>[] =>
  live.command.mock.calls.map(([request]) => request).filter((request): request is Extract<AgentCommand, { type: T }> => request.type === type)

function type(prompt: HTMLTextAreaElement, value: string): void {
  fireEvent.change(prompt, { target: { value, selectionStart: value.length, selectionEnd: value.length } })
  prompt.setSelectionRange(value.length, value.length)
  fireEvent.select(prompt)
}

const optionNames = (list: HTMLElement): string[] => within(list).getAllByRole('option').map(option => option.querySelector('.composer-picker__name')!.textContent!)

beforeEach(() => {
  vi.mocked(useAgents).mockReset()
  Object.assign(window, { sotto: { files: filesBridge().bridge } })
})
afterEach(() => { cleanup(); Reflect.deleteProperty(window, 'sotto') })

describe('file mention tokens', () => {
  it('reads an @ token at the caret as a path being browsed', () => {
    expect(detectFileTrigger('Check @src/ap', 13)).toEqual({ query: 'src/ap', start: 6, end: 13 })
    expect(detectFileTrigger('mail me@example.com', 19)).toBeNull()
    expect(detectFileTrigger('@a', 0, 2)).toBeNull()
    expect(fileQueryParts('src/ap')).toEqual({ directory: 'src', filter: 'ap' })
    expect(fileQueryParts('READ')).toEqual({ directory: '', filter: 'READ' })
  })

  it('never offers what the working copy boundary leaves out, nor a path no prompt can write', () => {
    expect(searchFileEntries(FOLDERS['']!, '').map(entry => entry.path)).toEqual(['src', 'README.md'])
    expect(searchFileEntries(FOLDERS['']!, 'git')).toEqual([])
    expect(searchFileEntries(FOLDERS.src!, 'app.c').map(entry => entry.path)).toEqual(['src/app.css'])
    // A `@path` token ends at the first space, so a spaced name is left out here and refused in main.
    expect(searchFileEntries(FOLDERS['']!, 'notes')).toEqual([])
    expect(unmentionableCount(FOLDERS['']!)).toBe(1)
    expect(agentFileReferenceSchema.safeParse({ path: 'release notes.md' }).success).toBe(false)
    expect(agentFileReferenceSchema.safeParse({ path: 'README.md' }).success).toBe(true)
  })

  it('holds the per-prompt limit before inserting rather than dropping a mention later', () => {
    const full = Array.from({ length: MAX_MENTIONED_FILES }, (_, index) => ({ path: `src/f${index}.ts` }))
    expect(fileLimitReached(full, 'src/app.ts')).toBe(true)
    // Mentioning a file the draft already holds is not a new mention, so it stays available.
    expect(fileLimitReached(full, 'src/f0.ts')).toBe(false)
    expect(fileLimitReached(full.slice(1), 'src/app.ts')).toBe(false)
    const text = full.map(file => `@${file.path}`).join(' ')
    const inserted = insertFile(`${text} @app`, detectFileTrigger(`${text} @app`, text.length + 5)!, 'src/f0.ts', full)
    expect(inserted.files).toHaveLength(MAX_MENTIONED_FILES)
  })

  it('writes @path, keeps the reference only while the token is written, and browses a folder', () => {
    const inserted = insertFile('Check @READ', detectFileTrigger('Check @READ', 11)!, 'README.md', [])
    expect(inserted).toMatchObject({ text: 'Check @README.md ', files: [{ path: 'README.md' }] })
    expect(retainFileReferences(inserted.text, inserted.files)).toEqual([{ path: 'README.md' }])
    expect(retainFileReferences('Check @README.mdx', inserted.files)).toEqual([])
    expect(retainFileReferences('Check @README', inserted.files)).toEqual([])
    // A dot inside the path never ends the token; ordinary sentence punctuation does.
    expect(retainFileReferences('Check @README.md, please', inserted.files)).toEqual([{ path: 'README.md' }])
    expect(browseFolder('Check @sr', detectFileTrigger('Check @sr', 9)!, 'src')).toEqual({ text: 'Check @src/', caret: 11 })
  })
})

describe('composer file picker', () => {
  it('browses the working copy from @, mentions a file and sends its relative path', async () => {
    const { live, prompt } = mount()
    type(prompt(), 'Read @')
    const list = await screen.findByRole('listbox', { name: 'Files' })
    expect(optionNames(list)).toEqual(['src/', 'README.md'])

    // Arrows move and Enter takes the highlighted entry; a folder keeps browsing.
    fireEvent.keyDown(prompt(), { key: 'Enter' })
    expect(prompt()).toHaveValue('Read @src/')
    const inside = await screen.findByRole('listbox', { name: 'Files' })
    expect(optionNames(inside)).toEqual(['app.ts', 'app.css'])
    fireEvent.keyDown(prompt(), { key: 'ArrowDown' })
    fireEvent.keyDown(prompt(), { key: 'Enter' })
    expect(prompt()).toHaveValue('Read @src/app.css ')
    expect(live.threadDrafts.draft(THREAD).files).toEqual([{ path: 'src/app.css' }])

    fireEvent.keyDown(prompt(), { key: 'Enter' })
    expect(requests(live, 'manual-send')).toEqual([{ type: 'manual-send', threadId: THREAD, draftId: expect.any(String), text: 'Read @src/app.css ', files: [{ path: 'src/app.css' }] }])
    act(() => undefined)
  })

  it('closes on Escape and drops the reference when the token is deleted', async () => {
    const { live, prompt } = mount()
    type(prompt(), 'Read @READ')
    const list = await screen.findByRole('listbox', { name: 'Files' })
    expect(optionNames(list)).toEqual(['README.md'])
    fireEvent.keyDown(prompt(), { key: 'Escape' })
    expect(screen.queryByRole('listbox', { name: 'Files' })).not.toBeInTheDocument()

    type(prompt(), 'Read @README.md now')
    // Reopening and choosing the file is what selects it; typing the same path by hand does not.
    expect(live.threadDrafts.draft(THREAD).files).toEqual([])
    type(prompt(), 'Read @READ')
    await screen.findByRole('listbox', { name: 'Files' })
    fireEvent.keyDown(prompt(), { key: 'Enter' })
    expect(prompt()).toHaveValue('Read @README.md ')
    expect(live.threadDrafts.draft(THREAD).files).toEqual([{ path: 'README.md' }])

    type(prompt(), 'Read the readme')
    expect(live.threadDrafts.draft(THREAD).files).toEqual([])
    fireEvent.keyDown(prompt(), { key: 'Enter' })
    expect(requests(live, 'manual-send')).toEqual([{ type: 'manual-send', threadId: THREAD, draftId: expect.any(String), text: 'Read the readme' }])
    act(() => undefined)
  })

  it('says why an entry is missing and why a full draft takes no more', () => {
    const entries = FOLDERS['']!
    const options = searchFileEntries(entries, '')
    const onSelect = vi.fn()
    const model = {
      enabled: true, open: true, trigger: { query: '', start: 5, end: 6 }, directory: '', options, activeIndex: 0,
      listing: { status: 'ready' as const, entries, truncated: false }, truncated: false,
      move: vi.fn(), highlight: vi.fn(), close: vi.fn(), refresh: vi.fn(), track: vi.fn(), leave: vi.fn(),
    } satisfies FilePickerModel
    const full = Array.from({ length: MAX_MENTIONED_FILES }, (_, index) => ({ path: `src/f${index}.ts` }))
    render(<FilePicker model={model} listId="files" selected={full} onSelect={onSelect} />)
    expect(screen.getByText(/1 entry has a space in its name/u)).toBeInTheDocument()
    expect(screen.getByText(new RegExp(`at most ${MAX_MENTIONED_FILES} files`, 'u'))).toBeInTheDocument()
    // A folder still browses at the limit; a file says no instead of being taken and silently dropped.
    const [folder, file] = within(screen.getByRole('listbox', { name: 'Files' })).getAllByRole('option')
    expect(file).toHaveAttribute('aria-disabled', 'true')
    fireEvent.click(file!)
    expect(onSelect).not.toHaveBeenCalled()
    fireEvent.click(folder!)
    expect(onSelect).toHaveBeenCalledWith(options[0])
  })

  it('reloads a saved draft with its file mentions after a restart', async () => {
    const { live, prompt } = mount()
    type(prompt(), 'Read @src/app')
    await screen.findByRole('listbox', { name: 'Files' })
    fireEvent.keyDown(prompt(), { key: 'Enter' })
    expect(prompt()).toHaveValue('Read @src/app.ts ')
    await act(async () => { live.threadDrafts.flushAll(); await Promise.resolve() })
    const saved = requests(live, 'save-thread-draft').at(-1)!
    expect(saved).toMatchObject({ text: 'Read @src/app.ts ', files: [{ path: 'src/app.ts' }] })

    // A restart: the window is gone, and a fresh store adopts the draft main persisted.
    const reloaded = new ThreadDraftStore(vi.fn(async () => null))
    reloaded.receive(live.state)
    expect(reloaded.draft(THREAD)).toMatchObject({ text: 'Read @src/app.ts ', files: [{ path: 'src/app.ts' }] })
    act(() => undefined)
  })
})
