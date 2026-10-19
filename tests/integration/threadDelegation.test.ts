// @vitest-environment node
// ADR-0081's proof over fake providers: an ordinary thread delegates to a thread it starts, under rules main enforces.
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { lastUserMessageIdOf } from '../../src/shared/agents'
import { DELEGATE_MCP_SERVER, type DelegatedView, type DelegationView } from '../../src/shared/delegation'
import { countWorkingThreads } from '../../src/shared/workingThreads'
import { delegationFixture, type DelegationRefused as Refused } from '../fixtures/delegationFixture'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

/** A card the window reads for a delegation main accepted, not one it refused. */
function accepted(view: DelegationView | undefined): DelegatedView {
  if (view === undefined || view.outcome === 'refused') throw new Error('Expected a delegation main accepted.')
  return view
}

const fixture = (options: Parameters<typeof delegationFixture>[1] = {}) => delegationFixture(cleanups, options)

it('starts a Codex thread for a Claude Code thread, and the wait returns its answer as the delegated thread\'s words', async () => {
  const f = await fixture(), parent = await f.userThread('claude')
  const call = f.delegate(parent, { provider: 'codex', model: f.model('codex').id, wait_seconds: 60 })
  await vi.waitFor(() => expect(f.control.shell().host.threads.find(thread => thread.delegatedBy === parent)?.status).toBe('running'))
  const child = f.control.shell().host.threads.find(thread => thread.delegatedBy === parent)!
  expect(child.providerId).toBe('codex')
  expect(f.native(child.id).messages[0]).toMatchObject({ role: 'user', text: 'Synthetic brief' })
  await f.endTurn(child.id, 'Synthetic review reply')
  const result = f.ok(await call)
  expect(result.delegation).toMatchObject({ thread: child.id, outcome: 'answered', reply: { from: 'delegated-thread', text: 'Synthetic review reply' } })
  expect(result.limits.prompts).toBe(1)
  // The link is in the snapshot by Sotto thread ID, and the record keeps identities only.
  expect(f.control.shell().host.threads.find(thread => thread.id === child.id)?.delegatedBy).toBe(parent)
  const saved = await import('node:fs/promises').then(fs => fs.readFile(`${f.root}/delegations.json`, 'utf8'))
  expect(saved).not.toContain('Synthetic brief')
  expect(saved).not.toContain('Synthetic review reply')
})

it('keeps the title the delegating thread gave, and names an untitled delegated thread as Sotto names any thread', async () => {
  const f = await fixture({ titles: true }), parent = await f.userThread('claude')
  const titled = f.ok(await f.delegate(parent, { provider: 'codex', model: f.model('codex').id, title: 'Synthetic chosen name', wait_seconds: 0 })).delegation.thread
  const untitled = f.ok(await f.delegate(parent, { provider: 'grok', model: f.model('grok').id, wait_seconds: 0 })).delegation.thread
  const thread = (threadId: string) => f.control.shell().host.threads.find(item => item.id === threadId)!
  // The brief's opening words name the untitled thread as soon as it is sent.
  await vi.waitFor(() => expect(thread(untitled).title).toBe('Synthetic brief'))
  await f.endTurn(titled, 'Synthetic titled reply')
  await f.endTurn(untitled, 'Synthetic untitled reply')
  // After the first reply, a generated name replaces only the stand-in; the given title stays.
  await vi.waitFor(() => expect(thread(untitled).title).toBe('Synthetic generated name'))
  expect(thread(titled)).toMatchObject({ title: 'Synthetic chosen name', titleSource: 'user' })
})

it('stops both levels below the thread the user stops, and only the second level when that is the one stopped', async () => {
  const f = await fixture(), parent = await f.userThread('claude')
  const first = f.ok(await f.delegate(parent, { provider: 'codex', model: f.model('codex').id, wait_seconds: 0 }))
  const child = first.delegation.thread
  // The delegated thread delegates once more, to a third provider.
  const second = f.ok(await f.delegate(child, { provider: 'grok', model: f.model('grok').id, wait_seconds: 0 }))
  const grandchild = second.delegation.thread
  await vi.waitFor(() => expect(f.native(grandchild).status).toBe('running'))
  // Stop on the second level stops only it.
  await f.control.commandShell({ type: 'interrupt', threadId: grandchild })
  expect(f.native(child).status).toBe('running')
  // Stop on the top thread stops every working thread below it in the same press.
  const third = f.ok(await f.delegate(child, { provider: 'grok', model: f.model('grok').id, wait_seconds: 0, work: 'research' }))
  await vi.waitFor(() => expect(f.native(third.delegation.thread).status).toBe('running'))
  await f.control.commandShell({ type: 'interrupt', threadId: parent })
  await vi.waitFor(() => {
    expect(f.native(child).status).toBe('idle')
    expect(f.native(third.delegation.thread).status).toBe('idle')
  })
  expect(f.adapterOf(child).commands.filter(command => command.type === 'interrupt')).toHaveLength(1)
  expect(f.adapterOf(third.delegation.thread).commands.filter(command => command.type === 'interrupt' && command.threadId === f.workspace.registry.byThread(third.delegation.thread)!.sessionId)).toHaveLength(1)
})

it('refuses a start wider than the delegating thread\'s permission and the new-thread default, or one that names none', async () => {
  const f = await fixture(), parent = await f.userThread('claude')
  expect(await f.service.delegate(parent, { work: 'research', brief: 'Synthetic brief', provider: 'codex', model: f.model('codex').id, effort: 'low' }))
    .toMatchObject({ status: 'refused', code: 'INVALID_INPUT' })
  expect(await f.service.delegate(parent, { work: 'research', brief: 'Synthetic brief', provider: 'codex', model: f.model('codex').id, permission: 'approval-required' }))
    .toMatchObject({ status: 'refused', code: 'INVALID_INPUT' })
  const refused = await f.delegate(parent, { provider: 'codex', model: f.model('codex').id, permission: 'full-access' }) as Refused
  expect(refused).toMatchObject({ status: 'refused', code: 'PERMISSION_TOO_WIDE' })
  expect(f.control.shell().host.threads.some(thread => thread.delegatedBy === parent)).toBe(false)
})

it('offers sotto_delegate to the first level and not to a thread a delegated thread started', async () => {
  const f = await fixture(), parent = await f.userThread('claude')
  const child = f.ok(await f.delegate(parent, { provider: 'codex', model: f.model('codex').id, wait_seconds: 0 })).delegation.thread
  const grandchild = f.ok(await f.delegate(child, { provider: 'grok', model: f.model('grok').id, wait_seconds: 0 })).delegation.thread
  expect((await f.tools.mcpServer(parent))?.name).toBe(DELEGATE_MCP_SERVER)
  expect((await f.tools.mcpServer(child))?.name).toBe(DELEGATE_MCP_SERVER)
  expect(await f.tools.mcpServer(grandchild)).toBeUndefined()
  expect(await f.delegate(grandchild, { provider: 'codex', model: f.model('codex').id })).toMatchObject({ status: 'refused', code: 'LEVEL_LIMIT' })
  expect((await f.tools.call(grandchild, 'delegate', { work: 'research', brief: 'Synthetic brief', provider: 'codex', model: f.model('codex').id })).isError).toBe(true)
})

it('pauses delegated sends while the user is typing in the delegated thread', async () => {
  const f = await fixture(), parent = await f.userThread('claude')
  const first = f.ok(await f.delegate(parent, { provider: 'codex', model: f.model('codex').id, wait_seconds: 0 }))
  await f.endTurn(first.delegation.thread, 'Synthetic first reply')
  await vi.waitFor(async () => expect(f.ok(await f.read(parent, first.delegation.id)).delegation.outcome).toBe('answered'))
  await f.control.commandShell({ type: 'save-thread-draft', threadId: first.delegation.thread, draftId: randomUUID(), text: 'The user is typing', requestId: null })
  expect(await f.delegate(parent, { thread: first.delegation.thread, brief: 'Synthetic second brief' })).toMatchObject({ status: 'refused', code: 'PAUSED' })
  expect(f.native(first.delegation.thread).messages.some(message => message.text === 'Synthetic second brief')).toBe(false)
})

it('refuses a send queued before the user\'s newer message as the target having changed, and delivers nothing', async () => {
  const f = await fixture(), parent = await f.userThread('claude')
  const first = f.ok(await f.delegate(parent, { provider: 'codex', model: f.model('codex').id, wait_seconds: 0 }))
  const child = first.delegation.thread
  // The delegated thread is still working on the first brief, so the second waits for it.
  const queued = f.ok(await f.delegate(parent, { thread: child, brief: 'Synthetic queued brief', wait_seconds: 0 }))
  expect(queued.delegation.outcome).toBe('working')
  // The user sends their own message to the delegated thread meanwhile.
  expect((await f.control.commandShell({ type: 'queue-followup', threadId: child, draftId: randomUUID(), text: 'Synthetic user instruction' })).error).toBeNull()
  const read = f.ok(await f.read(parent, queued.delegation.id))
  expect(read.delegation).toMatchObject({ outcome: 'paused', refusal: 'TARGET_CHANGED' })
  await f.endTurn(child, 'Synthetic first reply')
  await vi.waitFor(() => expect(f.native(child).messages.some(message => message.text === 'Synthetic user instruction')).toBe(true))
  expect(f.native(child).messages.some(message => message.text === 'Synthetic queued brief')).toBe(false)
})

it('leaves a brief unknown after a restart and sends nothing again', async () => {
  const f = await fixture(), parent = await f.userThread('claude')
  const first = f.ok(await f.delegate(parent, { provider: 'codex', model: f.model('codex').id, wait_seconds: 0 }))
  const child = first.delegation.thread
  const sends = () => f.adapterOf(child).commands.filter(command => command.type === 'send').length
  const before = sends()
  await f.restart()
  expect(f.ok(await f.read(parent, first.delegation.id)).delegation.outcome).toBe('unknown')
  // The window's card says it was the restart.
  expect(f.service.views(parent).made).toMatchObject([{ id: first.delegation.id, outcome: 'unknown', unknownWhy: 'restarted' }])
  await f.endTurn(child, 'Synthetic reply after restart')
  const read = f.ok(await f.read(parent, first.delegation.id))
  expect(read.delegation.outcome).toBe('unknown')
  expect(read.delegation.reply).toBeUndefined()
  expect(sends()).toBe(before)
  // The link survives the restart, on the thread's own record and in the delegation record.
  expect(f.control.shell().host.threads.find(thread => thread.id === child)?.delegatedBy).toBe(parent)
  expect((await f.tools.mcpServer(child))?.name).toBe(DELEGATE_MCP_SERVER)
  expect(f.control.shell().followups?.some(item => item.threadId === parent && item.wakeUp)).toBeFalsy()
})

it('starts past the old Threads in flight limit, and warns once more than ten threads are working on this computer (#1183)', async () => {
  const f = await fixture(), parent = await f.userThread('claude')
  const working = () => countWorkingThreads(f.control.shell().host.threads)
  // The user's own threads, working, until this computer has nine.
  while (working() < 9) await f.userThread('claude')
  expect(working()).toBe(9)
  // The tenth is the first delegated thread: ten working is not more than ten, so the result says nothing extra.
  const tenth = f.ok(await f.delegate(parent, { provider: 'codex', model: f.model('codex').id, wait_seconds: 0 }))
  expect(tenth.warning).toBeUndefined()
  expect(working()).toBe(10)
  // The eleventh starts too, nothing is refused or held back, and its result carries the warning.
  const retryKey = randomUUID(), eleventhInput = { provider: 'grok', model: f.model('grok').id, wait_seconds: 0, retry_key: retryKey }
  const eleventh = f.ok(await f.delegate(parent, eleventhInput))
  expect(eleventh.warning).toBe('11 threads are working. This computer may slow down or use its battery faster.')
  // A retry returns the first delegation and says nothing of the count: it started nothing.
  const retried = f.ok(await f.delegate(parent, eleventhInput))
  expect(retried.delegation.id).toBe(eleventh.delegation.id)
  expect(retried.warning).toBeUndefined()
  expect(f.control.shell().host.threads.filter(thread => thread.delegatedBy === parent)).toHaveLength(2)
  expect('inFlight' in eleventh.limits || 'inFlightLimit' in eleventh.limits).toBe(false)
  // A send to a thread it already started is not a start, and carries no warning.
  await f.endTurn(tenth.delegation.thread, 'Synthetic reply')
  await vi.waitFor(async () => expect(f.ok(await f.read(parent, tenth.delegation.id)).delegation.outcome).toBe('answered'))
  expect(f.ok(await f.delegate(parent, { thread: tenth.delegation.thread, brief: 'Synthetic second brief', wait_seconds: 0 })).warning).toBeUndefined()
})

it('gives each delegated thread four briefs per turn of the delegating thread, renewed by the user\'s next message alone', async () => {
  const f = await fixture(), parent = await f.userThread('claude')
  const first = f.ok(await f.delegate(parent, { provider: 'codex', model: f.model('codex').id, wait_seconds: 0 }))
  const child = first.delegation.thread
  for (let brief = 2; brief <= 4; brief++) {
    await f.endTurn(child, `Synthetic reply ${brief - 1}`)
    await vi.waitFor(async () => expect(f.ok(await f.read(parent, (await f.service.read(parent, {}) as { delegations: { id: string }[] }).delegations.at(-1)!.id)).delegation.outcome).toBe('answered'))
    const sent = f.ok(await f.delegate(parent, { thread: child, brief: `Synthetic brief ${brief}`, wait_seconds: 0 }))
    expect(sent.limits.prompts).toBe(brief)
  }
  await f.endTurn(child, 'Synthetic reply 4')
  await vi.waitFor(async () => expect(f.ok(await f.read(parent, (await f.service.read(parent, {}) as { delegations: { id: string }[] }).delegations.at(-1)!.id)).delegation.outcome).toBe('answered'))
  expect(await f.delegate(parent, { thread: child, brief: 'Synthetic brief 5' })).toMatchObject({ status: 'refused', code: 'PROMPT_LIMIT' })
  // A retry with the same key returns the first delegation and charges nothing.
  const key = randomUUID()
  expect(await f.delegate(parent, { thread: child, brief: 'Synthetic brief 5', retry_key: key })).toMatchObject({ status: 'refused', code: 'PROMPT_LIMIT' })
})

it('gives the window each delegation\'s outcome and wait, by the user\'s message it answers, and never its words (#1029)', async () => {
  const f = await fixture(), parent = await f.userThread('claude')
  const told: string[][] = []
  const stop = f.service.onViewsChanged(threadIds => { told.push([...threadIds]) })
  const shell = f.control.shell().host.threads.find(thread => thread.id === parent)!
  const root = lastUserMessageIdOf(shell) ?? shell.summary?.lastUser?.id
  expect(root).toBeDefined()
  const call = f.delegate(parent, { provider: 'codex', model: f.model('codex').id, wait_seconds: 60 })
  await vi.waitFor(() => expect(f.service.views(parent).made[0]).toMatchObject({ outcome: 'working', waiting: true, wait: { seconds: 60 } }))
  const waiting = accepted(f.service.views(parent).made[0])
  // The card goes in the turn the call was made in, here the user's own message.
  expect(waiting).toMatchObject({ action: 'start', work: 'code-review', rootUserMessageId: root, anchorMessageId: root })
  // The delegated thread reads the same brief as one it was sent, by the brief's message.
  expect(f.service.views(waiting.thread)).toMatchObject({ made: [], received: [{ id: waiting.id, briefMessageId: waiting.briefMessageId }] })
  expect(waiting.wait?.wentOnAt).toBeUndefined()
  expect(told.flat()).toContain(parent)
  await f.endTurn(waiting.thread, 'Synthetic review reply')
  f.ok(await call)
  const answered = accepted(f.service.views(parent).made[0])
  expect(answered).toMatchObject({ outcome: 'answered', waiting: false, told: true, wait: { seconds: 60 } })
  expect(answered.wait?.wentOnAt).toBeUndefined()
  expect(answered.outcomeAt).toBeDefined()
  // Opening its roster row reads the whole brief it was sent from its own record, never the reply.
  expect(f.service.brief(waiting.thread)).toBe('Synthetic brief')
  expect(f.service.brief('another-thread')).toBeUndefined()
  // A call that waits for nothing goes on at once; the card says the answer comes later.
  f.ok(await f.delegate(parent, { provider: 'codex', model: f.model('codex').id, wait_seconds: 0, work: 'research' }))
  expect(f.service.views(parent).made[1]).toMatchObject({ outcome: 'working', waiting: false, wait: { seconds: 0, wentOnAt: expect.any(String) } })
  expect(JSON.stringify(f.service.views(parent))).not.toMatch(/Synthetic (brief|review reply)/u)
  expect(f.service.views('another-thread')).toEqual({ made: [], received: [] })
  stop()
})

it('records a delegation it refuses as refused, holding no slot, starting and sending nothing, and telling no wake-up', async () => {
  const f = await fixture(), parent = await f.userThread('claude')
  const first = f.ok(await f.delegate(parent, { provider: 'codex', model: f.model('codex').id, wait_seconds: 0 }))
  const started = () => f.control.shell().host.threads.filter(thread => thread.delegatedBy === parent).length
  const refused = await f.delegate(parent, { provider: 'codex', model: f.model('codex').id, permission: 'full-access', wait_seconds: 0 }) as Refused & { delegation?: string }
  expect(refused).toMatchObject({ status: 'refused', code: 'PERMISSION_TOO_WIDE' })
  expect(refused.delegation).toBeDefined()
  expect(started()).toBe(1)
  const read = f.ok(await f.read(parent, refused.delegation!))
  expect(read.delegation).toMatchObject({ id: refused.delegation, outcome: 'refused', refusal: 'PERMISSION_TOO_WIDE', note: refused.message, provider: 'codex', action: 'start' })
  expect(read.delegation.thread).toBeUndefined()
  // A cancel has nothing to stop, and the listing names it beside the delegation that started.
  expect(await f.service.cancel(parent, { delegation: refused.delegation })).toMatchObject({ status: 'ok', delegation: { outcome: 'refused' } })
  const listed = await f.service.read(parent, {}) as { delegations: { id: string; outcome: string }[] }
  expect(listed.delegations.map(item => [item.id, item.outcome])).toEqual([[first.delegation.id, 'working'], [refused.delegation, 'refused']])
  // A refused send to a thread it delegated to names that thread, and sends nothing.
  await f.control.commandShell({ type: 'save-thread-draft', threadId: first.delegation.thread, draftId: randomUUID(), text: 'The user is typing', requestId: null })
  const send = await f.delegate(parent, { thread: first.delegation.thread, brief: 'Synthetic second brief', wait_seconds: 0 }) as Refused & { delegation?: string }
  expect(send).toMatchObject({ status: 'refused', code: 'PAUSED' })
  expect(f.ok(await f.read(parent, send.delegation!)).delegation).toMatchObject({ outcome: 'refused', refusal: 'PAUSED', thread: first.delegation.thread, action: 'send' })
  expect(f.native(first.delegation.thread).messages.some(message => message.text === 'Synthetic second brief')).toBe(false)
  // A call with arguments to correct is not a delegation, so nothing is recorded.
  const invalid = await f.service.delegate(parent, { work: 'research', brief: 'Synthetic brief', provider: 'codex', model: f.model('codex').id }) as Refused & { delegation?: string }
  expect(invalid).toMatchObject({ code: 'INVALID_INPUT' })
  expect(invalid.delegation).toBeUndefined()
  // It is kept across a restart, and nothing about it reaches the delegating thread as a wake-up.
  await f.restart()
  expect(f.ok(await f.read(parent, refused.delegation!)).delegation).toMatchObject({ outcome: 'refused', refusal: 'PERMISSION_TOO_WIDE' })
  expect(f.control.shell().followups?.some(item => item.threadId === parent && item.wakeUp)).toBeFalsy()
})

it('records the refusal of a thread that may not delegate, with its rule, through the tool server', async () => {
  const f = await fixture(), parent = await f.userThread('claude')
  const child = f.ok(await f.delegate(parent, { provider: 'codex', model: f.model('codex').id, wait_seconds: 0 })).delegation.thread
  const grandchild = f.ok(await f.delegate(child, { provider: 'grok', model: f.model('grok').id, wait_seconds: 0 })).delegation.thread
  const call = await f.tools.call(grandchild, 'delegate', { work: 'research', brief: 'Synthetic brief', provider: 'codex', model: f.model('codex').id, effort: 'low', permission: 'approval-required' })
  expect(call.isError).toBe(true)
  expect(call.structuredContent).toMatchObject({ status: 'refused', code: 'LEVEL_LIMIT', delegation: expect.any(String) })
  const saved = JSON.parse(await import('node:fs/promises').then(fs => fs.readFile(`${f.root}/delegations.json`, 'utf8'))) as { refusals?: { delegatingThreadId: string; code: string; provider?: string }[] }
  expect(saved.refusals).toEqual([expect.objectContaining({ delegatingThreadId: grandchild, code: 'LEVEL_LIMIT', provider: 'codex' })])
  expect(JSON.stringify(saved)).not.toContain('Synthetic brief')
})

it('gives the window each refused delegation by its rule, in the turn it was asked in, and never its words (#1029)', async () => {
  const f = await fixture(), parent = await f.userThread('claude')
  const shell = f.control.shell().host.threads.find(thread => thread.id === parent)!
  const root = lastUserMessageIdOf(shell) ?? shell.summary?.lastUser?.id
  const first = f.ok(await f.delegate(parent, { provider: 'codex', model: f.model('codex').id, wait_seconds: 0 }))
  const told: string[][] = []
  const stop = f.service.onViewsChanged(threadIds => { told.push([...threadIds]) })
  const refused = await f.delegate(parent, { provider: 'codex', model: f.model('codex').id, permission: 'full-access', wait_seconds: 0 }) as Refused & { delegation?: string }
  expect(refused).toMatchObject({ code: 'PERMISSION_TOO_WIDE' })
  // The window hears that the thread that asked has a new card, and nothing about any other thread.
  await vi.waitFor(() => expect(told).toEqual([[parent]]))
  const made = f.service.views(parent).made
  expect(made.map(view => [view.id, view.outcome])).toEqual([[first.delegation.id, 'working'], [refused.delegation, 'refused']])
  // A refused start names the provider it asked for and no thread, since nothing was started.
  expect(made[1]).toEqual({ id: refused.delegation, provider: 'codex', action: 'start', work: 'code-review', outcome: 'refused', refusal: 'PERMISSION_TOO_WIDE',
    rootUserMessageId: root, anchorMessageId: root, createdAt: expect.any(String) })
  // A refused send names the thread it would have gone to, which was sent nothing and so shows no brief for it.
  await f.control.commandShell({ type: 'save-thread-draft', threadId: first.delegation.thread, draftId: randomUUID(), text: 'The user is typing', requestId: null })
  const send = await f.delegate(parent, { thread: first.delegation.thread, brief: 'Synthetic second brief', wait_seconds: 0 }) as Refused & { delegation?: string }
  expect(send).toMatchObject({ code: 'PAUSED' })
  expect(f.service.views(parent).made.at(-1)).toMatchObject({ id: send.delegation, thread: first.delegation.thread, action: 'send', outcome: 'refused', refusal: 'PAUSED' })
  expect(f.service.views(first.delegation.thread).received.map(view => view.id)).toEqual([first.delegation.id])
  // Main's words to the agent stay with the agent; the window words the rule itself.
  const views = JSON.stringify(f.service.views(parent))
  for (const words of [refused.message, send.message, 'Synthetic second brief']) expect(views).not.toContain(words)
  stop()
  // They are kept across a restart, in the order they were asked for.
  await f.restart()
  expect(f.service.views(parent).made.filter(view => view.outcome === 'refused').map(view => view.id)).toEqual([refused.delegation, send.delegation])
})
