// @vitest-environment node
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import type { ThreadReadPurpose } from '../../src/main/agents/host'
import { desktopWindowClient } from '../../src/main/agents/hostService'
import { request, target } from '../fixtures/answerDraftFixture'
import { draftHandoffFixture } from '../fixtures/draftHandoffFixture'
import { PIXEL_PNG } from '../fixtures/stagedImages'

it('keeps an atomic Send draft saved when its staging persistence fails', async () => {
  const f = await draftHandoffFixture()
  try {
    await f.command({ type: 'assign', threadId: target.threadId, instruction: 'Work' })
    const control = f.control as unknown as { persist(): Promise<void> }
    vi.spyOn(control, 'persist').mockRejectedValueOnce(new Error('Could not save this draft.'))
    const result = await f.command({ type: 'send', draft: { threadId: target.threadId, text: 'Text at Send', attachments: [] } })
    expect(result.error).toContain('Could not save this thread draft')
    expect(f.attempts.filter(command => command.type === 'send' || command.type === 'answer')).toEqual([])
    expect((await f.disk()).threadDrafts).toContainEqual(expect.objectContaining({ threadId: target.threadId, text: 'Text at Send' }))
  } finally { vi.restoreAllMocks(); await f.close() }
})

it.each(['before', 'during'] as const)('preserves a newer same-owner saved revision %s atomic staging', async timing => {
  const f = await draftHandoffFixture()
  let release: () => void = () => undefined, sending: Promise<unknown> | undefined, predecessor: Promise<unknown> | undefined
  try {
    await f.command({ type: 'assign', threadId: target.threadId, instruction: 'Work' })
    f.host.event({ type: 'question', threadId: target.threadId, text: '', request: { ...request, delivery: undefined } })
    let entered: () => void = () => undefined
    const started = new Promise<void>(resolve => { entered = resolve }), gate = new Promise<void>(resolve => { release = resolve })
    // A snapshot's save runs once the code that accepted it has run on. Let it start, so the gate below holds the
    // save this test is about.
    await new Promise<void>(resolve => setImmediate(resolve))
    const control = f.control as unknown as { persist(): Promise<void> }, persist = control.persist.bind(control)
    vi.spyOn(control, 'persist').mockImplementationOnce(async () => { entered(); await gate; await persist() })
    if (timing === 'before') { predecessor = f.command({ type: 'compose', text: '' }); await started }
    sending = f.command({ type: 'send', draft: { threadId: target.threadId, text: 'Blue', attachments: [] } })
    if (timing === 'during') await started
    await f.command({ type: 'save-thread-draft', threadId: target.threadId, draftId: '00000000-0000-4000-8000-000000000099', text: 'Newer Green', requestId: request.id })
    release(); await sending
    if (timing === 'during') expect(f.attempts.filter(command => command.type === 'answer')).toContainEqual(expect.objectContaining({ answer: 'Blue' }))
    else expect(f.attempts.filter(command => command.type === 'answer' || command.type === 'send')).toEqual([])
    expect((await f.disk()).threadDrafts).toContainEqual(expect.objectContaining({ threadId: target.threadId, text: 'Newer Green' }))
  } finally { release(); await Promise.allSettled([predecessor, sending]); vi.restoreAllMocks(); await f.close() }
})

it('keeps an edit made during Send with its explicit owner after queue progression', async () => {
  const f = await draftHandoffFixture()
  let release: () => void = () => undefined, sending: Promise<unknown> | undefined, editing: Promise<unknown> | undefined
  try {
    await f.command({ type: 'assign', threadId: target.threadId, instruction: 'Work' })
    await f.command({ type: 'assign', threadId: 'docs', instruction: 'Documentation' })
    f.host.event({ type: 'question', threadId: 'docs', text: '', request: { ...request, id: 'docs-question', delivery: undefined } })
    f.host.event({ type: 'question', threadId: target.threadId, text: '', request: { ...request, delivery: undefined } })
    const image = await f.control.stageAttachment({ name: 'docs.png', mimeType: 'image/png', bytes: PIXEL_PNG })
    await f.command({ type: 'save-thread-draft', threadId: 'docs', draftId: '00000000-0000-4000-8000-000000000083', text: 'Retained Docs edit',
      requestId: 'docs-question', attachments: [image], skills: [{ name: 'docs', path: 'C:/synthetic/docs' }], files: [{ path: 'notes.md' }] })
    await f.command({ type: 'select-thread', threadId: target.threadId })
    let entered: () => void = () => undefined
    const started = new Promise<void>(resolve => { entered = resolve }), gate = new Promise<void>(resolve => { release = resolve })
    const execute = f.host.execute.bind(f.host)
    vi.spyOn(f.host, 'execute').mockImplementationOnce(async command => { entered(); await gate; return execute(command) })
    sending = f.command({ type: 'send', draft: { threadId: target.threadId, text: 'Blue', attachments: [] } })
    await started
    editing = f.command({ type: 'compose', threadId: target.threadId, text: 'Newer edit for Workshop' })
    release(); await sending; await editing
    expect(f.control.get().activeThreadId).toBe('docs')
    const drafts = (await f.disk()).threadDrafts
    expect(drafts).toContainEqual(expect.objectContaining({ threadId: target.threadId, text: 'Newer edit for Workshop', requestId: null, attachments: [] }))
    const workshop = drafts.find((draft: { threadId: string }) => draft.threadId === target.threadId)
    expect(workshop.skills).toBeUndefined(); expect(workshop.files).toBeUndefined()
    expect(drafts).toContainEqual(expect.objectContaining({ threadId: 'docs', text: 'Retained Docs edit', attachments: [image],
      skills: [{ name: 'docs', path: 'C:/synthetic/docs' }], files: [{ path: 'notes.md' }] }))
  } finally { release(); await Promise.allSettled([sending, editing]); vi.restoreAllMocks(); await f.close() }
})

it.each([['local', false], ['socket', false], ['local', true], ['socket', true]] as const)(
  'never converts a queued atomic %s answer into a prompt when its question closes (targeted predecessor %s)', async (route, targetedPredecessor) => {
  const f = await draftHandoffFixture(undefined, { authorizes: () => ({ allowed: false, reason: 'no-policy' }),
    mayGrant: client => ({ allowed: true, reason: client.transport === 'socket' ? 'paired-client' : 'local-window' }) })
  let release: () => void = () => undefined, predecessor: Promise<unknown> | undefined, sending: Promise<unknown> | undefined
  try {
    await f.command({ type: 'assign', threadId: target.threadId, instruction: 'Work' })
    f.host.event({ type: 'question', threadId: target.threadId, text: '', request: { ...request, delivery: undefined } })
    let entered: () => void = () => undefined
    const started = new Promise<void>(resolve => { entered = resolve }), gate = new Promise<void>(resolve => { release = resolve })
    const control = f.control as unknown as { persist(): Promise<void> }, persist = control.persist.bind(control)
    vi.spyOn(control, 'persist').mockImplementationOnce(async () => { entered(); await gate; await persist() })
    predecessor = f.command({ type: 'compose', ...(targetedPredecessor ? { threadId: target.threadId } : {}), text: '' }); await started
    const client = route === 'socket' ? { clientId: 'paired', user: 'User', transport: 'socket' as const, selectedThreadId: target.threadId } : desktopWindowClient()
    sending = f.control.commandShell({ type: 'send', draft: { threadId: target.threadId, text: 'Blue', attachments: [] } }, client)
    const closed = await f.host.snapshot(); closed.threads.find(thread => thread.id === target.threadId)!.requests = []
    vi.spyOn(f.host, 'snapshot').mockResolvedValue(closed)
    await f.command({ type: 'refresh', provider: 'claude' })
    release(); await predecessor; await sending
    expect(f.attempts.filter(command => command.type === 'send' || command.type === 'answer')).toEqual([])
    expect((await f.disk()).threadDrafts).toContainEqual(expect.objectContaining({ threadId: target.threadId, text: 'Blue', requestId: request.id }))
  } finally { release(); await Promise.allSettled([predecessor, sending]); vi.restoreAllMocks(); await f.close() }
})

it('verifies atomic Send attachment handles before staging or native dispatch', async () => {
  const f = await draftHandoffFixture()
  try {
    await f.command({ type: 'assign', threadId: target.threadId, instruction: 'Work' })
    const result = await f.command({ type: 'send', draft: { threadId: target.threadId, text: 'Text at Send',
      attachments: [{ id: 'unknown', name: 'synthetic.png', mimeType: 'image/png', sizeBytes: 1, digest: 'f'.repeat(64) }] } })
    expect(result.error).not.toBeNull()
    expect(f.attempts.filter(command => command.type === 'send' || command.type === 'answer')).toEqual([])
    expect(f.control.get().threadDrafts).not.toContainEqual(expect.objectContaining({ text: 'Text at Send' }))
  } finally { await f.close() }
})

it.each([['local', 'queued'], ['socket', 'queued'], ['local', 'staging'], ['socket', 'staging']] as const)(
  'refuses an atomic %s Send when an image vanishes while %s', async (route, timing) => {
  const f = await draftHandoffFixture()
  let release: () => void = () => undefined, predecessor: Promise<unknown> | undefined, sending: Promise<unknown> | undefined
  try {
    await f.command({ type: 'assign', threadId: target.threadId, instruction: 'Work' })
    const image = await f.control.stageAttachment({ name: 'synthetic.png', mimeType: 'image/png', bytes: PIXEL_PNG })
    let entered: () => void = () => undefined
    const started = new Promise<void>(resolve => { entered = resolve }), gate = new Promise<void>(resolve => { release = resolve })
    const control = f.control as unknown as { persist(): Promise<void> }, persist = control.persist.bind(control)
    vi.spyOn(control, 'persist').mockImplementationOnce(async () => { entered(); await gate; await persist() })
    if (timing === 'queued') { predecessor = f.command({ type: 'compose', text: 'Text with an image' }); await started }
    const client = route === 'socket' ? { clientId: 'paired', user: 'User', transport: 'socket' as const, selectedThreadId: target.threadId } : desktopWindowClient()
    sending = f.control.commandShell({ type: 'send', draft: { threadId: target.threadId, text: 'Text with an image', attachments: [image] } }, client)
    if (timing === 'staging') await started
    await writeFile(join(f.root, 'attachments', `${image.digest}.png`), 'synthetic corruption', 'utf8')
    expect(await f.control.attachmentContent(image.digest)).toBeNull()
    release(); await predecessor
    expect(await sending).toMatchObject({ error: 'The prompt was not sent. An image is no longer kept. Your text was saved. Attach it again before sending.' })
    expect(f.attempts.filter(command => command.type === 'send' || command.type === 'answer')).toEqual([])
    expect((await f.disk()).threadDrafts).toContainEqual(expect.objectContaining({ threadId: target.threadId, text: 'Text with an image' }))
  } finally { release(); await Promise.allSettled([predecessor, sending]); vi.restoreAllMocks(); await f.close() }
})

it.each([false, true])('keeps the atomic socket staging outcome independent of another command (staging fails %s)', async fails => {
  const f = await draftHandoffFixture()
  let release: () => void = () => undefined, off: () => void = () => undefined
  let sending: Promise<unknown> | undefined, other: Promise<unknown> | undefined
  try {
    await f.command({ type: 'assign', threadId: target.threadId, instruction: 'Work' })
    let entered: () => void = () => undefined
    const started = new Promise<void>(resolve => { entered = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    const control = f.control as unknown as { persist(): Promise<void> }, persist = control.persist.bind(control)
    vi.spyOn(control, 'persist').mockImplementationOnce(async () => {
      entered(); await gate
      if (fails) throw new Error('Synthetic staging write failure')
      await persist()
    })
    if (fails) {
      let navigated = false
      off = f.control.subscribe(state => {
        if (!navigated && state.error?.includes('Could not save this thread draft')) {
          navigated = true
          other = f.command({ type: 'select-thread', threadId: 'docs' })
        }
      })
    }
    const client = { clientId: 'paired-client', user: 'User', transport: 'socket' as const, selectedThreadId: target.threadId }
    sending = f.control.commandShell({ type: 'send', draft: { threadId: target.threadId, text: 'Text at Send', attachments: [] } }, client)
    await started
    if (!fails) {
      other = f.command({ type: 'answer', threadId: 'docs', requestId: 'missing', answer: 'Synthetic unrelated answer' })
      expect(await other).toMatchObject({ error: expect.stringContaining('request is no longer pending') })
    }
    release()
    expect(await sending).toMatchObject({ error: fails ? expect.stringContaining('Could not save this thread draft') : null })
    await other
    expect(f.attempts.filter(command => command.type === 'send')).toHaveLength(fails ? 0 : 1)
    if (fails) expect((await f.disk()).threadDrafts).toContainEqual(expect.objectContaining({ threadId: target.threadId, text: 'Text at Send' }))
  } finally { off(); release(); await Promise.allSettled([sending, other]); vi.restoreAllMocks(); await f.close() }
})

it.each(['local', 'socket'] as const)('refuses an atomic %s Send whose payload names a different draft owner', async route => {
  const f = await draftHandoffFixture()
  try {
    await f.command({ type: 'assign', threadId: target.threadId, instruction: 'Work' })
    await f.command({ type: 'select-thread', threadId: 'docs' })
    const client = route === 'socket'
      ? { clientId: 'paired-client', user: 'User', transport: 'socket' as const, selectedThreadId: 'docs' } : desktopWindowClient()
    const result = await f.control.commandShell({ type: 'send', draft: { threadId: target.threadId, text: 'Text at Send', attachments: [] } }, client)
    expect(result.error).toContain('draft now belongs to a different thread')
    expect(f.attempts.filter(command => command.type === 'send' || command.type === 'answer')).toEqual([])
    expect(f.control.get().threadDrafts).not.toContainEqual(expect.objectContaining({ text: 'Text at Send' }))
  } finally { await f.close() }
})

it.each([['answer', false], ['answer', true], ['send', false], ['send', true], ['voice', false], ['voice', true]] as const)(
  'keeps a newer %s reservation admitted during the native read (still dispatching %s)', async (route, active) => {
  const f = await draftHandoffFixture()
  let releaseRead: () => void = () => undefined, releaseWrite: () => void = () => undefined
  let checking: Promise<void> | undefined, answering: Promise<unknown> | undefined
  try {
    if (route !== 'answer') await f.command({ type: 'assign', threadId: target.threadId, instruction: 'Work' })
    f.host.event({ type: 'question', threadId: target.threadId, text: '', request: { ...request, delivery: undefined, answerRetryReady: true } })
    if (route !== 'answer') {
      await f.command({ type: 'select-thread', threadId: target.threadId })
      await f.command({ type: 'compose', text: 'Blue' })
    }
    const stale = await f.host.snapshot()
    let readStarted: () => void = () => undefined, writeStarted: () => void = () => undefined
    const reading = new Promise<void>(resolve => { readStarted = resolve })
    const readGate = new Promise<void>(resolve => { releaseRead = resolve })
    const writing = new Promise<void>(resolve => { writeStarted = resolve })
    const writeGate = new Promise<void>(resolve => { releaseWrite = resolve })
    Object.assign(f.host, { refreshThread: vi.fn(async (_id: string, purpose?: ThreadReadPurpose) => {
      if (purpose?.retryUncertainAnswers) { readStarted(); await readGate; return stale }
      return f.host.snapshot()
    }) })
    vi.spyOn(f.host, 'execute').mockResolvedValueOnce({ accepted: false, uncertain: true })
    checking = f.control.checkRequestAnswer(target, desktopWindowClient())
    const rejected = expect(checking).rejects.toThrow(active ? 'still being sent' : 'Another answer started during this check')
    await reading
    if (active) {
      const control = f.control as unknown as { persist(): Promise<void> }, persist = control.persist.bind(control)
      vi.spyOn(control, 'persist').mockImplementationOnce(async () => { writeStarted(); await writeGate; await persist() })
    }
    answering = route === 'voice' ? f.command({ type: 'utterance', text: 'send it' }) : route === 'send' ? f.command({ type: 'send' })
      : f.command({ type: 'answer', threadId: target.threadId, requestId: request.id, answer: '',
        questionAnswers: { q: { optionIds: [], text: 'Blue' } } })
    if (active) await writing
    else await answering
    expect(f.control.requestAnswerRecovery(target.threadId, 'claude').uncertainRequestIds).toEqual([request.id])
    releaseRead(); await rejected
    expect(f.control.requestAnswerRecovery(target.threadId, 'claude').uncertainRequestIds).toEqual([request.id])
    releaseWrite(); await answering
    expect((await f.disk()).outbox).toMatchObject([{ type: 'answer', threadId: target.threadId, requestId: request.id }])
    // The settled command releases both admission and dispatch ownership, so a new explicit Check can proceed.
    await expect(f.control.checkRequestAnswer(target, desktopWindowClient())).resolves.toBeUndefined()
  } finally { releaseRead(); releaseWrite(); await Promise.allSettled([checking, answering]); vi.restoreAllMocks(); await f.close() }
})
