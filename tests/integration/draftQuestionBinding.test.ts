// @vitest-environment node
import { expect, it, vi } from 'vitest'
import { desktopWindowClient } from '../../src/main/agents/hostService'
import { questions, request, target } from '../fixtures/answerDraftFixture'
import { draftHandoffFixture } from '../fixtures/draftHandoffFixture'
import { PIXEL_PNG } from '../fixtures/stagedImages'

it.each(['local', 'socket'] as const)('ends a queued empty %s prompt intent for edits admitted after its new question', async route => {
  const f = await draftHandoffFixture(undefined, { authorizes: () => ({ allowed: false, reason: 'no-policy' }),
    mayGrant: client => ({ allowed: true, reason: client.transport === 'socket' ? 'paired-client' : 'local-window' }) })
  let release: () => void = () => undefined
  const pending: Promise<unknown>[] = []
  try {
    let entered: () => void = () => undefined
    const started = new Promise<void>(resolve => { entered = resolve }), gate = new Promise<void>(resolve => { release = resolve })
    const control = f.control as unknown as { persist(): Promise<void> }, persist = control.persist.bind(control)
    vi.spyOn(control, 'persist').mockImplementationOnce(async () => { entered(); await gate; await persist() })
    pending.push(f.command({ type: 'configure', patch: { reasoningEffort: 'high' } })); await started
    const client = route === 'socket' ? { clientId: 'paired', user: 'User', transport: 'socket' as const, selectedThreadId: target.threadId } : desktopWindowClient()
    pending.push(f.control.commandShell({ type: 'compose', threadId: target.threadId, text: '' }, client))
    f.host.event({ type: 'question', threadId: target.threadId, text: '', request: { ...request, delivery: undefined } })
    release(); await Promise.all(pending)
    await f.control.commandShell({ type: 'compose', threadId: target.threadId, text: 'Fresh answer' }, client)
    expect((await f.disk()).threadDrafts).toContainEqual(expect.objectContaining({ threadId: target.threadId, text: 'Fresh answer', requestId: request.id }))
    expect(f.attempts.filter(command => command.type === 'answer' || command.type === 'send')).toEqual([])
  } finally { release(); await Promise.allSettled(pending); vi.restoreAllMocks(); await f.close() }
})

it.each([['local', 'saved-empty'], ['socket', 'saved-empty'], ['local', 'pristine'], ['socket', 'pristine']] as const)(
  'answers a fresh question on explicit %s Send after an earlier %s prompt was empty', async (route, empty) => {
  const f = await draftHandoffFixture(undefined, { authorizes: () => ({ allowed: false, reason: 'no-policy' }),
    mayGrant: client => ({ allowed: true, reason: client.transport === 'socket' ? 'paired-client' : 'local-window' }) })
  try {
    const client = route === 'socket' ? { clientId: 'paired', user: 'User', transport: 'socket' as const, selectedThreadId: target.threadId } : desktopWindowClient()
    if (empty === 'pristine') await f.command({ type: 'select-thread', threadId: target.threadId })
    else await f.control.commandShell({ type: 'compose', threadId: target.threadId, text: '' }, client)
    f.host.event({ type: 'question', threadId: target.threadId, text: '', request: { ...request, delivery: undefined } })
    expect(await f.control.commandShell({ type: 'send', draft: { threadId: target.threadId, text: 'Fresh answer', attachments: [] } }, client)).toMatchObject({ error: null })
    expect(f.attempts.filter(command => command.type === 'answer')).toEqual([expect.objectContaining({ requestId: request.id, answer: 'Fresh answer' })])
    expect(f.attempts.filter(command => command.type === 'send')).toEqual([])
  } finally { await f.close() }
})

it.each([['local', false], ['socket', false], ['local', true], ['socket', true]] as const)(
  'saves a queued %s edit as a prompt after its answer is accepted (new question %s)', async (route, nextQuestion) => {
  const f = await draftHandoffFixture(undefined, { authorizes: () => ({ allowed: false, reason: 'no-policy' }),
    mayGrant: client => ({ allowed: true, reason: client.transport === 'socket' ? 'paired-client' : 'local-window' }) })
  let release: () => void = () => undefined, sending: Promise<unknown> | undefined, editing: Promise<unknown> | undefined
  try {
    f.host.event({ type: 'question', threadId: target.threadId, text: '', request: { ...request, delivery: undefined } })
    let entered: () => void = () => undefined
    const started = new Promise<void>(resolve => { entered = resolve }), gate = new Promise<void>(resolve => { release = resolve })
    const execute = f.host.execute.bind(f.host)
    vi.spyOn(f.host, 'execute').mockImplementationOnce(async command => { entered(); await gate; return execute(command) })
    const client = route === 'socket' ? { clientId: 'paired', user: 'User', transport: 'socket' as const, selectedThreadId: target.threadId } : desktopWindowClient()
    sending = f.control.commandShell({ type: 'send', draft: { threadId: target.threadId, text: 'Blue', attachments: [] } }, client)
    await started
    editing = f.control.commandShell({ type: 'compose', threadId: target.threadId, text: 'Blue.' }, client)
    if (nextQuestion) f.host.event({ type: 'question', threadId: target.threadId, text: '', request: { ...request, id: 'unseen-next-question', delivery: undefined } })
    release(); await sending
    expect(await editing).toMatchObject({ error: null })
    expect((await f.disk()).threadDrafts).toContainEqual(expect.objectContaining({ threadId: target.threadId, text: 'Blue.', requestId: null }))
    expect(f.attempts.filter(command => command.type === 'answer')).toEqual([expect.objectContaining({ requestId: request.id, answer: 'Blue' })])
    expect(f.attempts.filter(command => command.type === 'send')).toEqual([])
    if (nextQuestion) {
      const refused = await f.control.commandShell({ type: 'send', draft: { threadId: target.threadId, text: 'Blue.', attachments: [] } }, client)
      expect(refused.error).toContain('pending question')
      expect(f.attempts.filter(command => command.type === 'answer')).toHaveLength(1)
    }
  } finally { release(); await Promise.allSettled([sending, editing]); vi.restoreAllMocks(); await f.close() }
})

it.each(['local', 'socket'] as const)('keeps a first queued %s prompt binding when a question arrives before the next Compose', async route => {
  const f = await draftHandoffFixture(undefined, { authorizes: () => ({ allowed: false, reason: 'no-policy' }),
    mayGrant: client => ({ allowed: true, reason: client.transport === 'socket' ? 'paired-client' : 'local-window' }) })
  let release: () => void = () => undefined
  const pending: Promise<unknown>[] = []
  try {
    const image = await f.control.stageAttachment({ name: 'synthetic.png', mimeType: 'image/png', bytes: PIXEL_PNG })
    let entered: () => void = () => undefined
    const started = new Promise<void>(resolve => { entered = resolve }), gate = new Promise<void>(resolve => { release = resolve })
    const control = f.control as unknown as { persist(): Promise<void> }, persist = control.persist.bind(control)
    vi.spyOn(control, 'persist').mockImplementationOnce(async () => { entered(); await gate; await persist() })
    pending.push(f.command({ type: 'configure', patch: { reasoningEffort: 'high' } })); await started
    const client = route === 'socket' ? { clientId: 'paired', user: 'User', transport: 'socket' as const, selectedThreadId: target.threadId } : desktopWindowClient()
    pending.push(f.control.commandShell({ type: 'compose', threadId: target.threadId, text: 'First prompt', attachments: [image] }, client))
    f.host.event({ type: 'question', threadId: target.threadId, text: '', request: { ...request, delivery: undefined } })
    pending.push(f.control.commandShell({ type: 'compose', threadId: target.threadId, text: 'Newest prompt' }, client))
    release(); await Promise.all(pending)
    expect((await f.disk()).threadDrafts).toContainEqual(expect.objectContaining({ threadId: target.threadId, text: 'Newest prompt', requestId: null, attachments: [image] }))
    await f.control.commandShell({ type: 'send', draft: { threadId: target.threadId, text: 'Newest prompt', attachments: [] } }, client)
    expect(f.attempts.filter(command => command.type === 'send' || command.type === 'answer')).toEqual([])
  } finally { release(); await Promise.allSettled(pending); vi.restoreAllMocks(); await f.close() }
})

it.each(['local', 'socket'] as const)('retains a null prompt and refuses immutable %s Send when its queued Compose question closes before execution', async route => {
  const f = await draftHandoffFixture(undefined, { authorizes: () => ({ allowed: false, reason: 'no-policy' }),
    mayGrant: client => ({ allowed: true, reason: client.transport === 'socket' ? 'paired-client' : 'local-window' }) })
  let release: () => void = () => undefined
  const pending: Promise<unknown>[] = []
  try {
    f.host.event({ type: 'question', threadId: target.threadId, text: '', request: { ...request, delivery: undefined } })
    let entered: () => void = () => undefined
    const started = new Promise<void>(resolve => { entered = resolve }), gate = new Promise<void>(resolve => { release = resolve })
    const control = f.control as unknown as { persist(): Promise<void> }, persist = control.persist.bind(control)
    vi.spyOn(control, 'persist').mockImplementationOnce(async () => { entered(); await gate; await persist() })
    pending.push(f.command({ type: 'configure', patch: { reasoningEffort: 'high' } })); await started
    const client = route === 'socket' ? { clientId: 'paired', user: 'User', transport: 'socket' as const, selectedThreadId: target.threadId } : desktopWindowClient()
    const editing = f.control.commandShell({ type: 'compose', threadId: target.threadId, text: '' }, client)
    const sending = f.control.commandShell({ type: 'send', draft: { threadId: target.threadId, text: 'Newest packet', attachments: [] } }, client)
    pending.push(editing, sending)
    const closed = await f.host.snapshot(); closed.threads.find(thread => thread.id === target.threadId)!.requests = []
    vi.spyOn(f.host, 'snapshot').mockResolvedValue(closed)
    await f.command({ type: 'refresh', provider: 'claude' })
    release(); await Promise.all(pending)
    expect(await editing).toMatchObject({ error: null })
    expect(await sending).toMatchObject({ error: expect.stringContaining('Nothing was sent. Your text was saved.') })
    expect((await f.disk()).threadDrafts).toContainEqual(expect.objectContaining({ threadId: target.threadId, text: 'Newest packet', requestId: null }))
    expect(f.attempts.filter(command => command.type === 'send' || command.type === 'answer')).toEqual([])
  } finally { release(); await Promise.allSettled(pending); vi.restoreAllMocks(); await f.close() }
})

it.each(['local', 'socket'] as const)('ignores a closed-question binding in an empty active %s composer', async route => {
  const f = await draftHandoffFixture(undefined, { authorizes: () => ({ allowed: false, reason: 'no-policy' }),
    mayGrant: client => ({ allowed: true, reason: client.transport === 'socket' ? 'paired-client' : 'local-window' }) })
  try {
    f.host.event({ type: 'question', threadId: target.threadId, text: '', request: { ...request, delivery: undefined } })
    await f.command({ type: 'compose', text: '' })
    expect(f.control.get()).toMatchObject({ composing: true, draftThreadId: target.threadId, draftRequestId: request.id })
    const closed = await f.host.snapshot(); closed.threads.find(thread => thread.id === target.threadId)!.requests = []
    vi.spyOn(f.host, 'snapshot').mockResolvedValue(closed)
    await f.command({ type: 'refresh', provider: 'claude' })
    const client = route === 'socket' ? { clientId: 'paired', user: 'User', transport: 'socket' as const, selectedThreadId: target.threadId } : desktopWindowClient()
    await f.control.commandShell({ type: 'compose', threadId: target.threadId, text: 'New prompt' }, client)
    expect((await f.disk()).threadDrafts).toContainEqual(expect.objectContaining({ threadId: target.threadId, text: 'New prompt', requestId: null }))
    expect(await f.control.commandShell({ type: 'send', draft: { threadId: target.threadId, text: 'New prompt', attachments: [] } }, client)).toMatchObject({ error: null })
    expect(f.attempts.filter(command => command.type === 'send')).toHaveLength(1)
    expect(f.attempts.filter(command => command.type === 'answer')).toEqual([])
  } finally { vi.restoreAllMocks(); await f.close() }
})

it.each([['local', false], ['socket', false], ['local', true], ['socket', true]] as const)(
  'saves the latest queued atomic %s packet without changing an earlier prompt binding (empty %s)', async (route, empty) => {
  const f = await draftHandoffFixture(undefined, { authorizes: () => ({ allowed: false, reason: 'no-policy' }),
    mayGrant: client => ({ allowed: true, reason: client.transport === 'socket' ? 'paired-client' : 'local-window' }) })
  let release: () => void = () => undefined
  const pending: Promise<unknown>[] = []
  try {
    const client = route === 'socket' ? { clientId: 'paired', user: 'User', transport: 'socket' as const, selectedThreadId: target.threadId } : desktopWindowClient()
    if (empty) await f.control.commandShell({ type: 'compose', threadId: target.threadId, text: '' }, client)
    let entered: () => void = () => undefined
    const started = new Promise<void>(resolve => { entered = resolve }), gate = new Promise<void>(resolve => { release = resolve })
    const control = f.control as unknown as { persist(): Promise<void> }, persist = control.persist.bind(control)
    vi.spyOn(control, 'persist').mockImplementationOnce(async () => { entered(); await gate; await persist() })
    pending.push(f.command({ type: 'configure', patch: { reasoningEffort: 'high' } })); await started
    pending.push(f.control.commandShell({ type: 'compose', threadId: target.threadId, text: empty ? '' : 'Earlier prompt' }, client))
    f.host.event({ type: 'question', threadId: target.threadId, text: '', request: { ...request, delivery: undefined } })
    const sending = f.control.commandShell({ type: 'send', draft: { threadId: target.threadId, text: 'Latest packet', attachments: [] } }, client)
    pending.push(sending)
    release(); await Promise.all(pending)
    expect(await sending).toMatchObject({ error: expect.stringContaining('Nothing was sent. Your text was saved.') })
    expect((await f.disk()).threadDrafts).toContainEqual(expect.objectContaining({ threadId: target.threadId, text: 'Latest packet', requestId: null }))
    expect(f.attempts.filter(command => command.type === 'send' || command.type === 'answer')).toEqual([])
  } finally { release(); await Promise.allSettled(pending); vi.restoreAllMocks(); await f.close() }
})

it.each(['local', 'socket'] as const)('refuses a same-ID new form when a bound question was absent at atomic %s Send admission', async route => {
  const f = await draftHandoffFixture(undefined, { authorizes: () => ({ allowed: false, reason: 'no-policy' }),
    mayGrant: client => ({ allowed: true, reason: client.transport === 'socket' ? 'paired-client' : 'local-window' }) })
  let release: () => void = () => undefined, predecessor: Promise<unknown> | undefined, sending: Promise<unknown> | undefined
  try {
    await f.command({ type: 'save-thread-draft', threadId: target.threadId, draftId: '00000000-0000-4000-8000-000000000090', text: 'Saved answer', requestId: request.id })
    let entered: () => void = () => undefined
    const started = new Promise<void>(resolve => { entered = resolve }), gate = new Promise<void>(resolve => { release = resolve })
    const control = f.control as unknown as { persist(): Promise<void> }, persist = control.persist.bind(control)
    vi.spyOn(control, 'persist').mockImplementationOnce(async () => { entered(); await gate; await persist() })
    predecessor = f.command({ type: 'compose', text: 'Saved answer' }); await started
    const client = route === 'socket' ? { clientId: 'paired', user: 'User', transport: 'socket' as const, selectedThreadId: target.threadId } : desktopWindowClient()
    sending = f.control.commandShell({ type: 'send', draft: { threadId: target.threadId, text: 'Latest answer', attachments: [] } }, client)
    f.host.event({ type: 'question', threadId: target.threadId, text: '', request: { ...request, delivery: undefined,
      questions: [{ ...questions[0]!, question: 'New same-ID form?' }] } })
    release(); await predecessor
    expect(await sending).toMatchObject({ error: expect.stringContaining('changed') })
    expect(f.attempts.filter(command => command.type === 'send' || command.type === 'answer')).toEqual([])
    expect((await f.disk()).threadDrafts).toContainEqual(expect.objectContaining({ threadId: target.threadId, text: 'Latest answer', requestId: request.id }))
  } finally { release(); await Promise.allSettled([predecessor, sending]); vi.restoreAllMocks(); await f.close() }
})

it.each(['local', 'socket'] as const)('ends an empty %s prompt binding on cancel and ignores its later closed question', async route => {
  const f = await draftHandoffFixture(undefined, { authorizes: () => ({ allowed: false, reason: 'no-policy' }),
    mayGrant: client => ({ allowed: true, reason: client.transport === 'socket' ? 'paired-client' : 'local-window' }) })
  try {
    const client = route === 'socket' ? { clientId: 'paired', user: 'User', transport: 'socket' as const, selectedThreadId: target.threadId } : desktopWindowClient()
    await f.control.commandShell({ type: 'compose', threadId: target.threadId, text: '' }, client)
    const revision = f.control.get().threadDraftPersistence?.find(item => item.threadId === target.threadId)?.draftId
    expect(revision).toBeTruthy()
    f.host.event({ type: 'question', threadId: target.threadId, text: '', request: { ...request, delivery: undefined } })
    await f.control.commandShell({ type: 'cancel-draft' }, client)
    expect(f.control.get().threadDraftPersistence?.find(item => item.threadId === target.threadId)?.draftId).toBe(revision)
    await f.control.commandShell({ type: 'compose', threadId: target.threadId, text: 'Answer after cancel' }, client)
    expect((await f.disk()).threadDrafts).toContainEqual(expect.objectContaining({ text: 'Answer after cancel', requestId: request.id }))
    await f.control.commandShell({ type: 'compose', threadId: target.threadId, text: '' }, client)
    const closed = await f.host.snapshot(); closed.threads.find(thread => thread.id === target.threadId)!.requests = []
    vi.spyOn(f.host, 'snapshot').mockResolvedValue(closed)
    await f.command({ type: 'refresh', provider: 'claude' })
    await f.control.commandShell({ type: 'compose', threadId: target.threadId, text: 'Prompt after closure' }, client)
    expect((await f.disk()).threadDrafts).toContainEqual(expect.objectContaining({ text: 'Prompt after closure', requestId: null }))
    expect(f.attempts.filter(command => command.type === 'send' || command.type === 'answer')).toEqual([])
  } finally { vi.restoreAllMocks(); await f.close() }
})

it.each(['local', 'socket'] as const)('clears only the binding of an empty %s revision when its thread disappears and returns', async route => {
  const f = await draftHandoffFixture(undefined, { authorizes: () => ({ allowed: false, reason: 'no-policy' }),
    mayGrant: () => ({ allowed: true, reason: 'paired-client' }) })
  try {
    const client = route === 'socket' ? { clientId: 'paired', user: 'User', transport: 'socket' as const, selectedThreadId: target.threadId } : desktopWindowClient()
    await f.control.commandShell({ type: 'compose', threadId: target.threadId, text: '' }, client)
    const revision = f.control.get().threadDraftPersistence?.find(item => item.threadId === target.threadId)?.draftId
    const restored = await f.host.snapshot(), absent = structuredClone(restored)
    absent.threads = absent.threads.filter(thread => thread.id !== target.threadId)
    vi.spyOn(f.host, 'snapshot').mockResolvedValue(absent)
    await f.command({ type: 'refresh', provider: 'claude' })
    expect(f.control.get().threadDraftPersistence?.find(item => item.threadId === target.threadId)?.draftId).toBe(revision)
    restored.threads.find(thread => thread.id === target.threadId)!.requests = [{ ...request, delivery: undefined }]
    vi.mocked(f.host.snapshot).mockResolvedValue(restored)
    await f.command({ type: 'refresh', provider: 'claude' })
    await f.control.commandShell({ type: 'compose', threadId: target.threadId, text: 'Restored question answer' }, client)
    expect((await f.disk()).threadDrafts).toContainEqual(expect.objectContaining({ text: 'Restored question answer', requestId: request.id }))
  } finally { vi.restoreAllMocks(); await f.close() }
})

it.each(['local', 'socket'] as const)(
  'keeps an explicit saved null-bound %s prompt separate from a newly arrived question', async route => {
  const f = await draftHandoffFixture(undefined, { authorizes: () => ({ allowed: false, reason: 'no-policy' }),
    mayGrant: client => ({ allowed: true, reason: client.transport === 'socket' ? 'paired-client' : 'local-window' }) })
  try {
    await f.command({ type: 'save-thread-draft', threadId: target.threadId, draftId: '00000000-0000-4000-8000-000000000080', text: 'Plain prompt', requestId: null })
    f.host.event({ type: 'question', threadId: target.threadId, text: '', request: { ...request, delivery: undefined } })
    const client = route === 'socket' ? { clientId: 'paired', user: 'User', transport: 'socket' as const, selectedThreadId: target.threadId } : desktopWindowClient()
    const result = await f.control.commandShell({ type: 'send', draft: { threadId: target.threadId, text: 'Updated plain prompt', attachments: [] } }, client)
    expect(result.error).toContain('pending question')
    expect(f.attempts.filter(command => command.type === 'send' || command.type === 'answer')).toEqual([])
    expect((await f.disk()).threadDrafts).toContainEqual(expect.objectContaining({ threadId: target.threadId, text: 'Updated plain prompt', requestId: null }))
  } finally { await f.close() }
})

it.each([['local', 'add'], ['socket', 'add'], ['local', 'remove'], ['socket', 'remove']] as const)(
  'keeps a queued %s image %s when a later text-only Compose inherits omitted fields', async (route, change) => {
  const f = await draftHandoffFixture()
  let release: () => void = () => undefined
  const pending: Promise<unknown>[] = []
  try {
    const image = await f.control.stageAttachment({ name: 'synthetic.png', mimeType: 'image/png', bytes: PIXEL_PNG })
    await f.command({ type: 'save-thread-draft', threadId: target.threadId, draftId: '00000000-0000-4000-8000-000000000081', text: 'Initial',
      requestId: null, attachments: change === 'remove' ? [image] : [] })
    let entered: () => void = () => undefined
    const started = new Promise<void>(resolve => { entered = resolve }), gate = new Promise<void>(resolve => { release = resolve })
    const control = f.control as unknown as { persist(): Promise<void> }, persist = control.persist.bind(control)
    vi.spyOn(control, 'persist').mockImplementationOnce(async () => { entered(); await gate; await persist() })
    pending.push(f.command({ type: 'compose', text: 'Initial' })); await started
    const client = route === 'socket' ? { clientId: 'paired', user: 'User', transport: 'socket' as const, selectedThreadId: target.threadId } : desktopWindowClient()
    const expected = change === 'add' ? [image] : []
    pending.push(f.control.commandShell({ type: 'compose', threadId: target.threadId, text: 'Image edit', attachments: expected }, client))
    pending.push(f.control.commandShell({ type: 'compose', threadId: target.threadId, text: 'Newest text' }, client))
    release(); await Promise.all(pending)
    expect((await f.disk()).threadDrafts).toContainEqual(expect.objectContaining({ threadId: target.threadId, text: 'Newest text', attachments: expected, requestId: null }))
    expect(f.attempts.filter(command => command.type === 'send' || command.type === 'answer')).toEqual([])
  } finally { release(); await Promise.allSettled(pending); vi.restoreAllMocks(); await f.close() }
})

it.each(['local', 'socket'] as const)('validates the actual second question form captured by a queued atomic %s answer', async route => {
  const f = await draftHandoffFixture(undefined, { authorizes: () => ({ allowed: false, reason: 'no-policy' }),
    mayGrant: client => ({ allowed: true, reason: client.transport === 'socket' ? 'paired-client' : 'local-window' }) })
  let release: () => void = () => undefined, predecessor: Promise<unknown> | undefined, sending: Promise<unknown> | undefined
  try {
    f.host.event({ type: 'question', threadId: target.threadId, text: '', request: { ...request, id: 'first-question', delivery: undefined } })
    f.host.event({ type: 'question', threadId: target.threadId, text: '', request: { ...request, delivery: undefined } })
    await f.command({ type: 'save-thread-draft', threadId: target.threadId, draftId: '00000000-0000-4000-8000-000000000082', text: 'Saved answer', requestId: request.id })
    let entered: () => void = () => undefined
    const started = new Promise<void>(resolve => { entered = resolve }), gate = new Promise<void>(resolve => { release = resolve })
    const control = f.control as unknown as { persist(): Promise<void> }, persist = control.persist.bind(control)
    vi.spyOn(control, 'persist').mockImplementationOnce(async () => { entered(); await gate; await persist() })
    predecessor = f.command({ type: 'compose', text: 'Saved answer' }); await started
    const client = route === 'socket' ? { clientId: 'paired', user: 'User', transport: 'socket' as const, selectedThreadId: target.threadId } : desktopWindowClient()
    sending = f.control.commandShell({ type: 'send', draft: { threadId: target.threadId, text: 'Blue', attachments: [] } }, client)
    const changed = await f.host.snapshot()
    changed.threads.find(thread => thread.id === target.threadId)!.requests.find(item => item.id === request.id)!.questions = [{ ...questions[0]!, question: 'Different second question?' }]
    vi.spyOn(f.host, 'snapshot').mockResolvedValue(changed)
    await f.command({ type: 'refresh', provider: 'claude' })
    release(); await predecessor
    expect(await sending).toMatchObject({ error: expect.stringContaining('changed') })
    expect(f.attempts.filter(command => command.type === 'send' || command.type === 'answer')).toEqual([])
  } finally { release(); await Promise.allSettled([predecessor, sending]); vi.restoreAllMocks(); await f.close() }
})

it('does not retire a still-current revision on an idempotent save', async () => {
  const f = await draftHandoffFixture()
  const draft = { type: 'save-thread-draft' as const, threadId: target.threadId,
    draftId: '00000000-0000-4000-8000-000000000095', requestId: null, text: 'Saved text' }
  try {
    await f.command(draft)
    await f.command(draft)
    expect(f.control.get()).toMatchObject({ obsoleteDrafts: [], threadDrafts: [expect.objectContaining({ draftId: draft.draftId, text: draft.text })] })
    await f.command({ type: 'save-thread-draft', threadId: target.threadId, draftId: '00000000-0000-4000-8000-000000000097', text: '', attachments: [] })
    expect(f.control.get()).toMatchObject({ obsoleteDrafts: [{ threadId: target.threadId, draftId: draft.draftId }], deliveredDrafts: [], threadDrafts: [] })
  } finally { await f.close() }
})

it.each(['local', 'socket'] as const)(
  'ends an empty %s prompt intent when a fresh question arrives', async route => {
  const f = await draftHandoffFixture(undefined, { authorizes: () => ({ allowed: false, reason: 'no-policy' }),
    mayGrant: client => ({ allowed: true, reason: client.transport === 'socket' ? 'paired-client' : 'local-window' }) })
  try {
    const client = route === 'socket' ? { clientId: 'paired', user: 'User', transport: 'socket' as const, selectedThreadId: target.threadId } : desktopWindowClient()
    await f.control.commandShell({ type: 'compose', threadId: target.threadId, text: 'Deleted prompt' }, client)
    await f.control.commandShell({ type: 'compose', threadId: target.threadId, text: '' }, client)
    await f.command({ type: 'select-thread', threadId: target.threadId })
    f.host.event({ type: 'question', threadId: target.threadId, text: '', request: { ...request, delivery: undefined } })
    await f.control.commandShell({ type: 'compose', threadId: target.threadId, text: 'Blue' }, client)
    expect((await f.disk()).threadDrafts).toContainEqual(expect.objectContaining({ threadId: target.threadId, text: 'Blue', requestId: request.id }))
    expect(await f.control.commandShell({ type: 'send', draft: { threadId: target.threadId, text: 'Blue', attachments: [] } }, client)).toMatchObject({ error: null })
    expect(f.attempts.filter(command => command.type === 'answer')).toEqual([expect.objectContaining({ requestId: request.id, answer: 'Blue' })])
    expect(f.attempts.filter(command => command.type === 'send')).toEqual([])
  } finally { await f.close() }
})
