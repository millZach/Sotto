// @vitest-environment node
import { createHash, randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { MAX_DELIVERED_DRAFTS, agentStateSchema } from '../../src/shared/agents'
import { emptyWatcherRecord } from '../../src/shared/watcher'
import { FINISHED_UNREAD_MAX } from '../../src/main/agents/finishedUnread'
import { agentControlFixture } from '../fixtures/agentControlFixture'
import { FakeProviderHost } from '../fixtures/fakeProviderHost'
import { PIXEL_DATA_URL, PIXEL_PNG } from '../fixtures/stagedImages'
import { savedAgentsState, withoutWatcherFile } from '../fixtures/savedWatcher'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

it('keeps dormant Watcher receipts and marks through ordinary actions, full active bounds and a real stable restart', async () => {
  const host = new FakeProviderHost()
  const f = await agentControlFixture({ host, credentialOptions: { mode: 'unavailable' } })
  cleanups.push(f.dispose)
  await f.control.start()
  f.control.dispose(); await f.control.closed()
  const path = join(f.directory, 'agents.json'), queuePath = join(f.directory, 'followups.json')
  const saved = JSON.parse(await readFile(path, 'utf8'))
  const hidden = randomUUID(), ordinary = 'session-docs', at = new Date().toISOString()
  const record = emptyWatcherRecord()
  record.current = { target: { hostId: randomUUID(), threadId: hidden }, projectId: 'project', provider: 'codex',
    creationOperationId: randomUUID(), createdAt: at }
  saved.watcher = record
  const receipts = Array.from({ length: MAX_DELIVERED_DRAFTS }, (_, index) => ({ threadId: index === 0 ? hidden : ordinary, draftId: randomUUID() }))
  Object.assign(saved, { deliveredDrafts: receipts, obsoleteDrafts: receipts,
    deliveredPromptDigests: receipts.map(receipt => ({ ...receipt, digest: 'a'.repeat(64) })),
    answeredRequests: receipts.map((receipt, index) => ({ threadId: receipt.threadId, provider: 'codex', requestId: `answered-${index}`,
      questionsDigest: 'b'.repeat(64), decisionId: randomUUID() })),
    deliveries: receipts.map(receipt => ({ ...receipt, status: 'accepted', createdAt: at, updatedAt: at })),
    finishedUnread: [hidden, ...Array.from({ length: FINISHED_UNREAD_MAX - 1 }, (_, index) => `old-finish-${index}`)],
    outbox: [{ id: randomUUID(), type: 'send', threadId: hidden, messageId: randomUUID(), draftId: randomUUID() }] })
  const queue = { items: [], receipts: receipts.map(receipt => ({ ...receipt, digest: 'c'.repeat(64) })) }
  await writeFile(path, JSON.stringify(saved)); await writeFile(queuePath, JSON.stringify(queue))
  await withoutWatcherFile(f.directory)
  const control = f.create({ watcherEnabled: false })
  await control.start(); await control.commandShell({ type: 'connect' })
  const thread = host.state.threads.find(thread => thread.id === ordinary)!
  for (let index = 0; index < 2; index += 1) {
    thread.status = 'idle'; host.emit()
    expect((await control.commandShell({ type: 'save-thread-draft', threadId: ordinary, draftId: randomUUID(), text: `Synthetic edit ${index}` })).error).toBeNull()
    expect((await control.commandShell({ type: 'save-thread-draft', threadId: ordinary, draftId: randomUUID(), text: `Synthetic replacement ${index}` })).error).toBeNull()
    expect((await control.commandShell({ type: 'manual-send', threadId: ordinary, draftId: randomUUID(), text: `Synthetic sent ${index}` })).error).toBeNull()
    thread.status = 'idle'; thread.requests = [{ id: `question-${index}`, kind: 'question', text: 'Synthetic choice', options: [{ id: 'yes', label: 'Yes' }] }]; host.emit()
    expect((await control.commandShell({ type: 'answer', threadId: ordinary, requestId: `question-${index}`, answer: 'Yes' })).error).toBeNull()
    expect((await control.commandShell({ type: 'queue-followup', threadId: ordinary, draftId: randomUUID(), text: `Synthetic queued ${index}` })).error).toBeNull()
  }
  const finishing = host.state.threads.find(thread => thread.id === 'session-workshop')!
  finishing.status = 'running'; host.emit()
  finishing.status = 'idle'; host.emit()
  control.dispose(); await control.closed()
  const after = await savedAgentsState(f.directory), afterQueue = JSON.parse(await readFile(queuePath, 'utf8'))
  for (const key of ['deliveredDrafts', 'obsoleteDrafts', 'deliveredPromptDigests', 'answeredRequests', 'deliveries']) {
    expect.soft(after[key].filter((item: { threadId: string }) => item.threadId === hidden), key).toEqual(saved[key].filter((item: { threadId: string }) => item.threadId === hidden))
    expect.soft(after[key].filter((item: { threadId: string; status?: string }) => item.threadId !== hidden && (!item.status || item.status === 'accepted' || item.status === 'failed')), `${key} ordinary bound`).toHaveLength(MAX_DELIVERED_DRAFTS)
  }
  expect.soft(after.outbox).toEqual(saved.outbox)
  expect.soft(after.finishedUnread).toContain(hidden)
  expect.soft(after.finishedUnread.filter((id: string) => id !== hidden)).toHaveLength(FINISHED_UNREAD_MAX)
  expect.soft(afterQueue.receipts.filter((item: { threadId: string }) => item.threadId === hidden)).toEqual([queue.receipts[0]])
  expect.soft(afterQueue.receipts.filter((item: { threadId: string }) => item.threadId !== hidden)).toHaveLength(MAX_DELIVERED_DRAFTS)
  const restored = f.create({ watcherEnabled: false })
  await restored.start()
  expect(agentStateSchema.safeParse(restored.shell()).success).toBe(true)
  restored.dispose(); await restored.closed()
  const again = await savedAgentsState(f.directory), queueAgain = JSON.parse(await readFile(queuePath, 'utf8'))
  for (const key of ['watcher', 'deliveredDrafts', 'obsoleteDrafts', 'deliveredPromptDigests', 'answeredRequests', 'deliveries', 'outbox', 'finishedUnread']) expect.soft(again[key], `restart ${key}`).toEqual(after[key])
  expect.soft(queueAgain).toEqual(afterQueue)
})

it('loads and saves full dormant and ordinary receipt capacities, then reopens Owl with valid public shells and whole records', async () => {
  const host = new FakeProviderHost()
  const f = await agentControlFixture({ host, credentialOptions: { mode: 'unavailable' } })
  cleanups.push(f.dispose)
  await f.control.start(); f.control.dispose(); await f.control.closed()
  const path = join(f.directory, 'agents.json'), queuePath = join(f.directory, 'followups.json')
  const saved = JSON.parse(await readFile(path, 'utf8')), hidden = randomUUID(), at = new Date().toISOString()
  const record = emptyWatcherRecord()
  record.current = { target: { hostId: randomUUID(), threadId: hidden }, projectId: 'project', provider: 'codex',
    creationOperationId: randomUUID(), createdAt: at }
  saved.watcher = record
  const receipts = Array.from({ length: MAX_DELIVERED_DRAFTS * 2 }, (_, index) => ({ threadId: index < MAX_DELIVERED_DRAFTS ? hidden : 'session-docs', draftId: randomUUID() }))
  Object.assign(saved, { deliveredDrafts: receipts, obsoleteDrafts: receipts,
    deliveredPromptDigests: receipts.map(receipt => ({ ...receipt, digest: 'a'.repeat(64) })),
    answeredRequests: receipts.map((receipt, index) => ({ threadId: receipt.threadId, provider: 'codex', requestId: `answered-${index}`,
      questionsDigest: 'b'.repeat(64), decisionId: randomUUID() })),
    deliveries: receipts.map(receipt => ({ ...receipt, status: 'accepted', createdAt: at, updatedAt: at })) })
  const queue = { items: [], receipts: receipts.map(receipt => ({ ...receipt, digest: 'c'.repeat(64) })) }
  await writeFile(path, JSON.stringify(saved)); await writeFile(queuePath, JSON.stringify(queue))
  await withoutWatcherFile(f.directory)
  for (let index = 0; index < 2; index += 1) {
    const control = f.create({ watcherEnabled: false })
    await control.start()
    expect(agentStateSchema.safeParse(control.shell()).success).toBe(true)
    expect(control.shell().deliveredDrafts).toHaveLength(MAX_DELIVERED_DRAFTS)
    expect(control.shell().followupReceipts).toHaveLength(MAX_DELIVERED_DRAFTS)
    control.dispose(); await control.closed()
    const after = await savedAgentsState(f.directory)
    for (const key of ['watcher', 'deliveredDrafts', 'obsoleteDrafts', 'deliveredPromptDigests', 'answeredRequests', 'deliveries']) expect(after[key], key).toEqual(saved[key])
    expect(JSON.parse(await readFile(queuePath, 'utf8'))).toEqual(queue)
  }
  const owl = f.create({ watcherEnabled: true })
  await owl.start()
  for (const state of [owl.get(), owl.shell()]) {
    expect(agentStateSchema.safeParse(state).success).toBe(true)
    expect(state.deliveredDrafts).toEqual(receipts.slice(-MAX_DELIVERED_DRAFTS))
    expect(state.obsoleteDrafts).toEqual(receipts.slice(-MAX_DELIVERED_DRAFTS))
    expect(state.followupReceipts).toEqual(receipts.slice(-MAX_DELIVERED_DRAFTS))
  }
  owl.dispose(); await owl.closed()
  const afterOwl = await savedAgentsState(f.directory)
  for (const key of ['watcher', 'deliveredDrafts', 'obsoleteDrafts', 'deliveredPromptDigests', 'answeredRequests', 'deliveries']) expect(afterOwl[key], `Owl ${key}`).toEqual(saved[key])
  expect(JSON.parse(await readFile(queuePath, 'utf8'))).toEqual(queue)
})

it.each(['fresh', 'failed', 'accepted'] as const)('refuses a dormant Watcher atomic Send before changing %s delivery records', async status => {
  const host = new FakeProviderHost()
  const f = await agentControlFixture({ host, credentialOptions: { mode: 'unavailable' } })
  cleanups.push(f.dispose)
  await f.control.start(); f.control.dispose(); await f.control.closed()
  const path = join(f.directory, 'agents.json'), saved = JSON.parse(await readFile(path, 'utf8'))
  const hidden = randomUUID(), draftId = randomUUID(), text = 'Synthetic dormant packet', at = new Date().toISOString()
  const digest = createHash('sha256').update(JSON.stringify([hidden, text, null, null])).digest('hex')
  const record = emptyWatcherRecord()
  record.current = { target: { hostId: randomUUID(), threadId: hidden }, projectId: 'project', provider: 'codex', creationOperationId: randomUUID(), createdAt: at }
  Object.assign(saved, { watcher: record, deliveries: status === 'fresh' ? [] : [{ threadId: hidden, draftId, status, createdAt: at, updatedAt: at, packetDigest: digest }],
    deliveredDrafts: status === 'accepted' ? [{ threadId: hidden, draftId }] : [],
    deliveredPromptDigests: status === 'accepted' ? [{ threadId: hidden, draftId, digest, atomicDigest: digest }] : [] })
  await writeFile(path, JSON.stringify(saved))
  await withoutWatcherFile(f.directory)
  const control = f.create({ watcherEnabled: false })
  await control.start()
  const before = await savedAgentsState(f.directory)
  for (const content of [text, 'Synthetic changed packet']) {
    expect((await control.commandShell({ type: 'send', draft: { threadId: hidden, draftId, text: content } })).error).toContain('Sotto Owl')
  }
  control.dispose(); await control.closed()
  expect((await savedAgentsState(f.directory))).toEqual(before)
  expect(host.commands).toEqual([])
})

it.each([[true, 'inline', 'none'], [false, 'inline', 'none'], [true, 'handle', 'none'], [false, 'handle', 'none'],
  [true, 'inline', 'different'], [false, 'inline', 'different'], [true, 'inline', 'same'], [true, 'inline', 'equal'],
  [true, 'empty', 'different'], [false, 'empty', 'different']] as const)('keeps a legacy Watcher singleton independent of ordinary Send and Owl reopen (history %s, %s, native %s)', async (history, format, native) => {
  const host = new FakeProviderHost()
  const f = await agentControlFixture({ host, credentialOptions: { mode: 'unavailable' } })
  cleanups.push(f.dispose)
  await f.control.start(); f.control.dispose(); await f.control.closed()
  const path = join(f.directory, 'agents.json'), saved = JSON.parse(await readFile(path, 'utf8'))
  const hidden = randomUUID(), draftId = randomUUID(), at = new Date().toISOString()
  const record = emptyWatcherRecord()
  record.current = { target: { hostId: randomUUID(), threadId: hidden }, projectId: 'project', provider: 'codex', creationOperationId: randomUUID(), createdAt: at }
  const attachment = format === 'handle' ? { ...await f.control.stageAttachment({ name: 'Synthetic dormant.png', mimeType: 'image/png', bytes: PIXEL_PNG }), id: 'inline-only' }
    : { id: 'inline-only', name: 'Synthetic dormant.png', mimeType: 'image/png', dataUrl: PIXEL_DATA_URL }
  const legacy = { draftThreadId: hidden, draftRequestId: 'synthetic-unanswered', draft: '', draftAttachments: format === 'empty' ? [] : [attachment], manualDraftId: draftId, composing: true }
  const previous = { threadId: hidden, draftId: native === 'same' ? draftId : randomUUID(), text: format === 'empty' ? 'Synthetic older native draft' : '',
    attachments: native === 'equal' ? [attachment] : [], requestId: native === 'equal' ? legacy.draftRequestId : null, updatedAt: at,
    skills: [{ name: 'synthetic-skill', path: 'C:/synthetic/SKILL.md' }], files: [{ path: 'synthetic.ts' }] }
  Object.assign(saved, legacy, { watcher: record, threadDrafts: native === 'none' ? [] : [previous] })
  if (format === 'handle') Object.assign(saved, { dormantLegacyDraft: legacy, draftThreadId: null, draftRequestId: null,
    draft: '', draftAttachments: [], manualDraftId: null, composing: false })
  host.state.threads.push({ ...host.state.threads[0]!, id: hidden, kind: 'watcher' })
  await writeFile(path, JSON.stringify(saved))
  await withoutWatcherFile(f.directory)
  const control = f.create({ watcherEnabled: false, historyEnabled: () => history })
  await control.start(); await control.commandShell({ type: 'connect' })
  expect((await control.commandShell({ type: 'manual-send', threadId: 'session-docs', draftId: randomUUID(), text: 'Synthetic ordinary send' })).error).toBeNull()
  expect((await control.commandShell({ type: 'compose', threadId: 'session-docs', text: 'Synthetic ordinary unsent draft' })).error).toBeNull()
  const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 2 * 60 * 60_000)
  await control.privacyChanged(); clock.mockRestore(); control.dispose(); await control.closed()
  const after = await savedAgentsState(f.directory)
  expect(after.dormantLegacyDraft).toEqual(legacy)
  expect(after.threadDrafts.filter((draft: { threadId: string }) => draft.threadId === hidden)).toEqual(native === 'none' ? [] : [previous])
  expect(host.commands.filter(command => command.type === 'send')).toHaveLength(1)
  const digest = createHash('sha256').update(PIXEL_PNG).digest('hex')
  if (format !== 'handle') await expect(readFile(join(f.directory, 'attachments', digest + '.png'))).rejects.toMatchObject({ code: 'ENOENT' })
  else expect(await readFile(join(f.directory, 'attachments', digest + '.png'))).toEqual(PIXEL_PNG)
  const stable = f.create({ watcherEnabled: false, historyEnabled: () => history })
  await stable.start(); await stable.privacyChanged(); stable.dispose(); await stable.closed()
  expect((await savedAgentsState(f.directory)).dormantLegacyDraft).toEqual(legacy)
  const owl = f.create({ watcherEnabled: true, historyEnabled: () => history })
  await owl.start()
  const restored = owl.get().threadDrafts!.find(draft => draft.threadId === hidden)
  if (format === 'empty') {
    expect(restored).toBeUndefined()
    expect(owl.get().obsoleteDrafts).not.toContainEqual({ threadId: hidden, draftId: previous.draftId })
  } else {
    expect(restored).toMatchObject({ draftId: native === 'equal' ? previous.draftId : draftId, requestId: legacy.draftRequestId, text: '', attachments: [{ id: 'inline-only', name: 'Synthetic dormant.png', digest }] })
    expect(restored!.skills).toEqual(native === 'same' || native === 'equal' ? previous.skills : undefined)
    expect(restored!.files).toEqual(native === 'same' || native === 'equal' ? previous.files : undefined)
    if (native === 'equal') expect(restored!.updatedAt).toBe(previous.updatedAt)
    if (native === 'different') expect(owl.get().obsoleteDrafts).toContainEqual({ threadId: hidden, draftId: previous.draftId })
  }
  expect(owl.get().threadDrafts!.find(draft => draft.threadId === 'session-docs')!.text).toBe('Synthetic ordinary unsent draft')
  expect(owl.get().draft).toBe(after.draft)
  expect(owl.get().draftThreadId).toBe(after.draftThreadId)
  expect(agentStateSchema.safeParse(owl.shell()).success).toBe(true)
  if (format === 'empty') await expect(readFile(join(f.directory, 'attachments', digest + '.png'))).rejects.toMatchObject({ code: 'ENOENT' })
  else expect(await readFile(join(f.directory, 'attachments', digest + '.png'))).toEqual(PIXEL_PNG)
  owl.dispose(); await owl.closed()
  expect((await savedAgentsState(f.directory)).dormantLegacyDraft).toBeUndefined()
})
