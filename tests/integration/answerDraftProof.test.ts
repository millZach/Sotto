// @vitest-environment node
import { deferred } from '../fixtures/deferred'
import { expect, it, vi } from 'vitest'
import { request, target } from '../fixtures/answerDraftFixture'
import { draftHandoffFixture } from '../fixtures/draftHandoffFixture'

it.each([false, true])('records only the captured draft accepted by a direct answer (newer edit %s)', async newer => {
  const f = await draftHandoffFixture()
  const draftId = '00000000-0000-4000-8000-000000000091', newerId = '00000000-0000-4000-8000-000000000092'
  let release: () => void = () => undefined, answering: Promise<unknown> | undefined
  try {
    f.host.event({ type: 'question', threadId: target.threadId, text: '', request: { ...request, delivery: undefined } })
    await f.command({ type: 'save-thread-draft', threadId: target.threadId, draftId, requestId: request.id, text: 'Blue' })
    const { promise: started, resolve: entered } = deferred<void>()

    const { promise: gate, resolve: gateResolve } = deferred<void>()
    release = gateResolve
    const execute = f.host.execute.bind(f.host)
    vi.spyOn(f.host, 'execute').mockImplementationOnce(async command => { entered(); await gate; return execute(command) })
    answering = f.command({ type: 'answer', threadId: target.threadId, requestId: request.id, answer: 'Blue' })
    await started
    if (newer) await f.command({ type: 'save-thread-draft', threadId: target.threadId, draftId: newerId, requestId: request.id, text: 'Green' })
    release(); await answering
    expect(f.attempts.filter(command => command.type === 'answer')).toEqual([expect.objectContaining({ answer: 'Blue' })])
    expect(f.control.get().deliveredDrafts).toContainEqual({ threadId: target.threadId, draftId })
    expect(f.control.get().deliveredDrafts).not.toContainEqual({ threadId: target.threadId, draftId: newerId })
    expect((await f.disk()).deliveredDrafts).toContainEqual({ threadId: target.threadId, draftId })
    expect(f.control.get().threadDrafts).toEqual(newer ? [expect.objectContaining({ draftId: newerId, text: 'Green' })] : [])
  } finally { release(); await Promise.allSettled([answering]); vi.restoreAllMocks(); await f.close() }
})

it.each(['replacement', 'empty', 'cancel'] as const)('records exact %s draft obsolescence without claiming native acceptance', async action => {
  const f = await draftHandoffFixture()
  const draftId = '00000000-0000-4000-8000-000000000093', nextId = '00000000-0000-4000-8000-000000000094'
  const original = { type: 'save-thread-draft' as const, threadId: target.threadId, draftId, requestId: null, text: 'Original text' }
  try {
    await f.command(original)
    if (action === 'cancel') await f.control.commandShell({ type: 'cancel-draft' },
      { clientId: 'paired', user: 'User', transport: 'socket', selectedThreadId: target.threadId })
    else await f.command({ ...original, draftId: nextId, text: action === 'empty' ? '' : 'Newer text' })
    const obsolete = [{ threadId: target.threadId, draftId }]
    expect(f.control.get()).toMatchObject({ obsoleteDrafts: obsolete, deliveredDrafts: [] })
    expect(await f.disk()).toMatchObject({ obsoleteDrafts: obsolete, deliveredDrafts: [] })
    await f.restart()
    expect(f.control.get()).toMatchObject({ obsoleteDrafts: obsolete, deliveredDrafts: [] })
    // A delayed save of an obsolete revision cannot revive it after Clear or replace a newer edit.
    expect((await f.command(original)).error).toContain('cleared or replaced')
    expect(f.control.get().threadDrafts).toEqual(action === 'replacement' ? [expect.objectContaining({ draftId: nextId, text: 'Newer text' })] : [])
    expect(f.attempts.filter(command => command.type === 'send' || command.type === 'answer')).toEqual([])
  } finally { await f.close() }
})

it.each([['', false], ['Blue', false], ['', true], ['Blue', true]] as const)(
  'does not confirm a saved text revision for a different structured answer (legacy answer %s, active composer %s)', async (answer, active) => {
  const f = await draftHandoffFixture()
  const draftId = '00000000-0000-4000-8000-000000000096'
  try {
    f.host.event({ type: 'question', threadId: target.threadId, text: '', request: { ...request, delivery: undefined } })
    if (active) await f.command({ type: 'compose', text: 'Blue' })
    await f.command({ type: 'save-thread-draft', threadId: target.threadId, draftId, requestId: request.id, text: 'Blue' })
    await f.command({ type: 'answer', threadId: target.threadId, requestId: request.id, answer,
      questionAnswers: { q: { optionIds: [], text: 'Green' } } })
    expect(f.control.get().deliveredDrafts).toEqual([])
    expect((await f.disk()).deliveredDrafts).toEqual([])
    expect(f.control.get()).toMatchObject(active
      ? { obsoleteDrafts: expect.arrayContaining([{ threadId: target.threadId, draftId }]), threadDrafts: [] }
      : { obsoleteDrafts: [], threadDrafts: [expect.objectContaining({ draftId, text: 'Blue', requestId: request.id })] })
  } finally { await f.close() }
})

it('keeps a newer active draft when a different structured answer finishes', async () => {
  const f = await draftHandoffFixture()
  const draftId = '00000000-0000-4000-8000-000000000088', newerId = '00000000-0000-4000-8000-000000000089'
  let release: () => void = () => undefined, answering: Promise<unknown> | undefined
  try {
    f.host.event({ type: 'question', threadId: target.threadId, text: '', request: { ...request, delivery: undefined } })
    await f.command({ type: 'compose', text: 'Blue' })
    await f.command({ type: 'save-thread-draft', threadId: target.threadId, draftId, requestId: request.id, text: 'Blue' })
    const { promise: started, resolve: entered } = deferred<void>()
    const { promise: gate, resolve: gateResolve } = deferred<void>()
    release = gateResolve
    const execute = f.host.execute.bind(f.host)
    vi.spyOn(f.host, 'execute').mockImplementationOnce(async command => { entered(); await gate; return execute(command) })
    answering = f.command({ type: 'answer', threadId: target.threadId, requestId: request.id, answer: '',
      questionAnswers: { q: { optionIds: [], text: 'Green' } } })
    await started
    await f.command({ type: 'save-thread-draft', threadId: target.threadId, draftId: newerId, requestId: request.id, text: 'Newer edit' })
    release(); await answering
    expect(f.control.get()).toMatchObject({ deliveredDrafts: [], obsoleteDrafts: expect.arrayContaining([{ threadId: target.threadId, draftId }]),
      threadDrafts: [expect.objectContaining({ draftId: newerId, requestId: request.id, text: 'Newer edit' })], draft: 'Newer edit' })
  } finally { release(); await Promise.allSettled([answering]); vi.restoreAllMocks(); await f.close() }
})

it.each([false, true])('publishes obsolete revisions only after a durable write (failed write %s)', async fails => {
  const f = await draftHandoffFixture()
  const draftId = '00000000-0000-4000-8000-000000000097', nextId = '00000000-0000-4000-8000-000000000090'
  let release: () => void = () => undefined, changing: Promise<unknown> | undefined
  const published: unknown[] = []
  const off = f.control.subscribe(state => { published.push(state.obsoleteDrafts) })
  try {
    await f.command({ type: 'save-thread-draft', threadId: target.threadId, draftId, requestId: null, text: 'Durable original' })
    const control = f.control as unknown as { store: { write(value: unknown): Promise<void> } }
    const write = control.store.write.bind(control.store)
    const { promise: started, resolve: entered } = deferred<void>()

    const { promise: gate, resolve: gateResolve } = deferred<void>()
    release = gateResolve
    vi.spyOn(control.store, 'write').mockImplementation(async value => {
      entered(); await gate
      if (fails) throw new Error('Synthetic disk write failure')
      await write(value)
    })
    changing = f.command({ type: 'save-thread-draft', threadId: target.threadId, draftId: nextId, requestId: null, text: 'Newer text' })
    await started
    // A provider publication must not turn an in-flight mutation into durable retirement evidence.
    f.host.event({ type: 'question', threadId: 'docs', text: '', request: { ...request, id: 'other-question', delivery: undefined } })
    expect(f.control.get().obsoleteDrafts).toEqual([])
    expect(f.control.shell().obsoleteDrafts).toEqual([])
    expect(published.every(value => JSON.stringify(value) === '[]')).toBe(true)
    expect((await f.disk()).threadDrafts).toContainEqual(expect.objectContaining({ draftId, text: 'Durable original' }))
    release(); await changing
    if (fails) {
      expect(f.control.get().obsoleteDrafts).toEqual([])
      expect((await f.disk()).obsoleteDrafts).toEqual([])
      vi.restoreAllMocks()
      await f.command({ type: 'configure', patch: { } })
    }
    expect(f.control.get().obsoleteDrafts).toEqual([{ threadId: target.threadId, draftId }])
    expect(published).toContainEqual([{ threadId: target.threadId, draftId }])
    expect((await f.disk()).obsoleteDrafts).toEqual([{ threadId: target.threadId, draftId }])
  } finally { release(); await Promise.allSettled([changing]); off(); vi.restoreAllMocks(); await f.close() }
})
