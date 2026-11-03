// @vitest-environment node
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import * as fsPromises from 'node:fs/promises'
import { afterEach, expect, it, vi } from 'vitest'
import { ThreadStore } from '../../src/main/agents/threadStore'
import { SubagentStore } from '../../src/main/agents/subagentStore'
import { AttachmentStore } from '../../src/main/agents/attachmentStore'
import { AttachmentPreviews } from '../../src/main/agents/attachmentPreviews'
import { connectCheckpoints } from '../../src/main/tools/checkpointIntegration'
import { CheckpointStore, type CheckpointRecord } from '../../src/main/tools/checkpointStore'
import { FilesService } from '../../src/main/files/service'
import { resolveFilesBinding } from '../../src/main/files/binding'
import { emptyWatcherRecord, watcherRecordSchema } from '../../src/shared/watcher'
import type { AgentAttachment, AgentThread } from '../../src/shared/agents'
import { workspaceFixture } from '../fixtures/workspaceFixture'
import { agentControlFixture } from '../fixtures/agentControlFixture'
import { PIXEL_DATA_URL, PIXEL_PNG, pngOfSize } from '../fixtures/stagedImages'
import { savedWatcherRecord, withoutWatcherFile } from '../fixtures/savedWatcher'

vi.mock('node:fs/promises', async importOriginal => ({ ...await importOriginal<typeof import('node:fs/promises')>() }))

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close() })
const threadTables = ['events', 'messages', 'activities', 'activity_epochs', 'visuals', 'wake_ups']
const subagentTables = ['subagent_threads', 'subagent_rows', 'subagent_assignments', 'subagent_classifications']
function databaseRows(root: string, name: string, tables: readonly string[], ids: readonly string[]): Record<string, Record<string, Record<string, unknown>[]>> {
  const db = new DatabaseSync(join(root, name), { readOnly: true })
  try {
    return Object.fromEntries(ids.map(id => [id, Object.fromEntries(tables.map(table => [table,
      db.prepare('SELECT * FROM ' + table + ' WHERE thread_id = ? ORDER BY rowid').all(id)]))]))
  } finally { db.close() }
}
async function profile() {
  const owl = await workspaceFixture()
  cleanup.push(owl.remove)
  cleanup.push(owl.stop)
  const snapshot = await owl.host.connect('codex')
  const project = snapshot.projects.find(item => item.providerId === 'codex')!
  const model = snapshot.models.find(item => item.providerId === 'codex')!
  const ordinary = snapshot.threads.find(item => item.providerId === 'codex')!.id
  const hidden: string[] = Array.from({ length: 4 }, () => randomUUID())
  for (const id of hidden) await owl.host.execute({ type: 'create-thread', threadId: id, commandId: randomUUID(),
    projectId: project.id, modelId: model.id, title: 'Synthetic retained thread', workingCopy: 'shared' })
  const control = await agentControlFixture({ directory: owl.root, host: owl.host,
    credentialOptions: { mode: 'unavailable' }, control: { watcherEnabled: true } })
  cleanup.push(control.dispose)
  await control.control.start()
  await control.dispose()
  await control.control.closed()
  await owl.stop()
  const workspaceFile = join(owl.root, 'workspace.json')
  const workspace = JSON.parse(await readFile(workspaceFile, 'utf8'))
  const kinds = ['watcher', 'watcher-history', 'project', 'watcher-history']
  for (const [index, id] of hidden.entries()) workspace.snapshot.threads.find((thread: AgentThread) => thread.id === id).kind = kinds[index]
  await writeFile(workspaceFile, JSON.stringify(workspace))
  const at = new Date().toISOString()
  const identity = (id: string) => ({ target: { hostId: workspace.snapshot.hostId as string, threadId: id },
    projectId: project.id, provider: 'codex' as const, createdAt: at, creationOperationId: randomUUID() })
  const watcher = emptyWatcherRecord()
  watcher.current = identity(hidden[0]!)
  watcher.history = [identity(hidden[1]!)]
  watcher.creation = { phase: 'intent', identity: identity(hidden[2]!), replaces: watcher.current.target }
  watcherRecordSchema.parse(watcher)
  const agentsFile = join(owl.root, 'agents.json')
  const agents = JSON.parse(await readFile(agentsFile, 'utf8'))
  agents.watcher = watcher
  await writeFile(agentsFile, JSON.stringify(agents))
  await withoutWatcherFile(owl.root)
  const threads = new ThreadStore(join(owl.root, 'threads.sqlite'))
  const subagents = new SubagentStore(join(owl.root, 'subagents.sqlite'))
  threads.open(); subagents.open()
  try {
    for (const id of [...hidden, ordinary]) {
      threads.replaceThreadMessages(id, [{ id: 'user-' + id, role: 'user', text: 'Synthetic retained message ' + id, createdAt: at }])
      const activity = { id: 'activity-' + id, turnId: 'turn-' + id, sequence: 1, kind: 'tool' as const, status: 'running' as const,
        title: 'Synthetic retained activity ' + id, toolName: 'synthetic' }
      threads.syncActivities(id, [activity])
      threads.addVisual(id, { visual: { id: 'visual-' + id, kind: 'mermaid', title: 'Synthetic visual', source: 'graph TD; A-->B' },
        createdAt: at, anchorMessageId: 'user-' + id, anchorUserMessageId: 'user-' + id })
      threads.addWakeUps(id, ['wake-' + id])
      subagents.ingest(id, [{ id: 'child-' + id, assignmentId: 'task-' + id, status: 'running', observedAt: at,
        title: 'Synthetic retained task', prompt: 'Synthetic retained task words ' + id }], undefined, [activity])
    }
  } finally { threads.close(); subagents.close() }
  return { root: owl.root, hidden, ordinary, watcher }
}

it.each(['startup', 'privacy-change'] as const)('keeps dormant Watcher SQLite data whole during history-off %s and erases ordinary history', async scenario => {
  const f = await profile()
  const beforeThreads = databaseRows(f.root, 'threads.sqlite', threadTables, f.hidden)
  const beforeSubagents = databaseRows(f.root, 'subagents.sqlite', subagentTables, f.hidden)
  const stable = await workspaceFixture(f.root, { watcherEnabled: false, history: scenario !== 'startup' })
  cleanup.push(stable.stop)
  expect(new Set(stable.host.watcherThreadIds())).toEqual(new Set(f.hidden))
  expect(stable.host.workspaceSnapshot().threads.some(thread => f.hidden.includes(thread.id))).toBe(false)
  stable.setHistory(false)
  await stable.host.privacyChanged()
  expect(databaseRows(f.root, 'threads.sqlite', threadTables, f.hidden)).toEqual(beforeThreads)
  expect(databaseRows(f.root, 'subagents.sqlite', subagentTables, f.hidden)).toEqual(beforeSubagents)
  const ordinaryThreads = databaseRows(f.root, 'threads.sqlite', threadTables, [f.ordinary])[f.ordinary]!
  expect(ordinaryThreads.messages).toEqual([])
  expect(ordinaryThreads.activities).toEqual([])
  expect(ordinaryThreads.visuals).toEqual([])
  const messageEvents = ordinaryThreads.events!.filter(row => /^message-(added|replaced|text-appended)$/.test(String(JSON.parse(String(row.payload)).kind)))
  expect(messageEvents.length).toBeGreaterThan(0)
  expect(messageEvents.every(row => JSON.parse(String(row.payload)).redacted === true)).toBe(true)
  expect(JSON.stringify(ordinaryThreads)).not.toContain('Synthetic retained message ' + f.ordinary)
  const ordinarySubagents = databaseRows(f.root, 'subagents.sqlite', subagentTables, [f.ordinary])[f.ordinary]!
  expect(ordinarySubagents.subagent_assignments).toEqual([])
  expect(ordinarySubagents.subagent_classifications).toEqual([])
  expect(await savedWatcherRecord(f.root)).toEqual(f.watcher)
})

it.each(['startup', 'privacy-change'] as const)('keeps Watcher submitted previews and bytes through history-off %s while ordinary previews are removed', async scenario => {
  const f = await profile()
  const content = new AttachmentStore(f.root)
  await content.load()
  const watcherImage = await content.stage({ name: 'Synthetic Watcher.png', mimeType: 'image/png', bytes: PIXEL_PNG })
  const ordinaryImage = await content.stage({ name: 'Synthetic ordinary.png', mimeType: 'image/png', bytes: pngOfSize(80, 2) })
  const previews = new AttachmentPreviews(f.root, content)
  await previews.load()
  await previews.remember(f.hidden[0]!, 'watcher-message', 'watcher-command', [watcherImage])
  await previews.remember(f.ordinary, 'ordinary-message', 'ordinary-command', [ordinaryImage])
  const previewFile = join(f.root, 'attachment-previews.json')
  const original = JSON.parse(await readFile(previewFile, 'utf8')).entries.find((entry: { threadId: string }) => entry.threadId === f.hidden[0])
  const stable = await workspaceFixture(f.root, { watcherEnabled: false, history: scenario !== 'startup' })
  cleanup.push(stable.stop)
  let historyEnabled = scenario !== 'startup'
  const control = await agentControlFixture({ directory: f.root, host: stable.host, credentialOptions: { mode: 'unavailable' },
    control: { watcherEnabled: false, historyEnabled: () => historyEnabled } })
  cleanup.push(control.dispose)
  await control.control.start()
  historyEnabled = false; stable.setHistory(false)
  await control.control.privacyChanged()
  expect(JSON.parse(await readFile(previewFile, 'utf8')).entries).toEqual([original])
  expect(await control.control.attachmentPreview({ threadId: f.hidden[0]!, messageId: 'watcher-message', attachmentId: watcherImage.id })).toBeNull()
  expect(await readFile(join(f.root, 'attachments', watcherImage.digest + '.png'))).toEqual(PIXEL_PNG)
  if (scenario === 'privacy-change') await expect(readFile(join(f.root, 'attachments', ordinaryImage.digest + '.png'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it.each(['startup', 'privacy-change'] as const)('keeps dormant Watcher checkpoint records, file blobs and recovery copies during history-off %s', async scenario => {
  const f = await profile()
  const directory = join(f.root, 'checkpoints')
  await mkdir(join(directory, 'blobs'), { recursive: true })
  const bytes = [...f.hidden, f.ordinary].map(id => Buffer.from('Synthetic checkpoint file ' + id))
  const hashes = bytes.map(value => createHash('sha256').update(value).digest('hex'))
  for (const [index, hash] of hashes.entries()) await writeFile(join(directory, 'blobs', hash), bytes[index]!)
  const records: CheckpointRecord[] = [...f.hidden, f.ordinary].map((id, index) => ({
    id: randomUUID(), threadId: id, workspaceId: 'synthetic-workspace', cwd: f.root, providerId: 'codex', bindingId: 'synthetic-' + id,
    createdAt: new Date(Date.now() - (index < f.hidden.length ? 40 : 0) * 86_400_000).toISOString(), beforeUsers: [],
    before: { files: { 'app.txt': { hash: hashes[index]!, mode: 0o100644 } }, index: '', head: '' },
    status: index === 0 ? 'capturing' : index === 1 ? 'uncertain' : 'ready',
  }))
  const store = new CheckpointStore(directory)
  await store.write(records)
  const recoveryBytes = Buffer.from('Synthetic Watcher recovery copy file')
  const recoveryHash = createHash('sha256').update(recoveryBytes).digest('hex')
  await writeFile(join(directory, 'blobs', recoveryHash), recoveryBytes)
  const watcherBackup = join(directory, 'checkpoints.json.corrupt-' + randomUUID())
  const watcherCopy = '{"threadId":' + JSON.stringify(f.hidden[0]) + ',"hash":' + JSON.stringify(recoveryHash) + ',"incomplete":'
  await writeFile(watcherBackup, watcherCopy)
  const ordinaryBackup = join(directory, 'checkpoints.json.corrupt-' + randomUUID())
  await writeFile(ordinaryBackup, JSON.stringify({ threadId: f.ordinary }))
  const mixedBackup = join(directory, 'checkpoints.json.corrupt-' + randomUUID())
  const retainedCopy = { ...records[0]!, before: { files: { 'recovery.txt': { hash: recoveryHash, mode: 0o100644 } }, head: '', index: '' } }
  await writeFile(mixedBackup, JSON.stringify({ version: 1, records: [records.at(-1), retainedCopy] }))
  const stable = await workspaceFixture(f.root, { watcherEnabled: false, history: scenario !== 'startup' })
  cleanup.push(stable.stop)
  let historyEnabled = scenario !== 'startup'
  const control = await agentControlFixture({ directory: f.root, host: stable.host, credentialOptions: { mode: 'unavailable' },
    control: { watcherEnabled: false, historyEnabled: () => historyEnabled } })
  cleanup.push(control.dispose)
  await control.control.start()
  const files = new FilesService({ resolveBinding: id => resolveFilesBinding(stable.host.workspaceSnapshot(), id), copyPath: vi.fn(), reveal: vi.fn() })
  const integration = connectCheckpoints({ files, directory: f.root, host: stable.host, control: control.control, registry: stable.registry,
    historyEnabled: () => historyEnabled, report: vi.fn() })
  cleanup.push(async () => integration.dispose())
  await integration.checkpoints.initialize()
  // An interrupted hidden revert in the same folder must not block an ordinary thread.
  expect(integration.checkpoints.isBlocked(f.ordinary)).toBe(false)
  expect(await integration.checkpoints.isWorkspaceBlocked(f.ordinary)).toBe(false)
  for (const id of f.hidden) {
    await integration.checkpoints.beforeTurn(id)
    await integration.checkpoints.afterTurn(id)
    await integration.checkpoints.forgetThread(id)
    expect((await integration.checkpoints.checkpoints({ threadId: id })).ok).toBe(false)
  }
  historyEnabled = false; stable.setHistory(false)
  await stable.host.privacyChanged()
  await integration.checkpoints.privacyChanged()
  expect((await new CheckpointStore(directory).load()).records).toEqual(records.slice(0, f.hidden.length))
  for (const [index, hash] of hashes.slice(0, f.hidden.length).entries()) expect(await readFile(join(directory, 'blobs', hash))).toEqual(bytes[index])
  expect(await readFile(watcherBackup, 'utf8')).toBe(watcherCopy)
  expect(JSON.parse(await readFile(mixedBackup, 'utf8'))).toEqual({ version: 1, records: [retainedCopy] })
  expect(await readFile(join(directory, 'blobs', recoveryHash))).toEqual(recoveryBytes)
  await expect(readFile(ordinaryBackup)).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(readFile(join(directory, 'blobs', hashes.at(-1)!))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('keeps possible Watcher recovery blobs when a backup cannot be read and resumes ordinary cleanup after repair', async () => {
  const f = await profile(), directory = join(f.root, 'checkpoints')
  await mkdir(join(directory, 'blobs'), { recursive: true })
  const retained = Buffer.from('Synthetic Watcher backup blob'), ordinary = Buffer.from('Synthetic ordinary orphan blob')
  const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
  await writeFile(join(directory, 'blobs', hash(retained)), retained)
  await writeFile(join(directory, 'blobs', hash(ordinary)), ordinary)
  await new CheckpointStore(directory).write([])
  const backup = join(directory, 'checkpoints.json.corrupt-' + randomUUID())
  const original = JSON.stringify({ threadId: f.hidden[0], hash: hash(retained) })
  await writeFile(backup, original)
  const stable = await workspaceFixture(f.root, { watcherEnabled: false, history: false })
  cleanup.push(stable.stop)
  const control = await agentControlFixture({ directory: f.root, host: stable.host, credentialOptions: { mode: 'unavailable' }, control: { watcherEnabled: false } })
  cleanup.push(control.dispose)
  await control.control.start()
  const actualRead = fsPromises.readFile
  const denied = vi.spyOn(fsPromises, 'readFile').mockImplementation((...args) => args[0] === backup
    ? Promise.reject(Object.assign(new Error('Synthetic denied backup'), { code: 'EACCES' })) : actualRead(...args))
  const files = new FilesService({ resolveBinding: id => resolveFilesBinding(stable.host.workspaceSnapshot(), id), copyPath: vi.fn(), reveal: vi.fn() })
  const report = vi.fn()
  const integration = connectCheckpoints({ files, directory: f.root, host: stable.host, control: control.control, registry: stable.registry, historyEnabled: () => false, report })
  cleanup.push(async () => integration.dispose())
  await integration.checkpoints.initialize()
  expect(report).toHaveBeenCalledWith('checkpoint-cleanup-failed')
  expect(await readFile(join(directory, 'blobs', hash(retained)))).toEqual(retained)
  expect(await readFile(join(directory, 'blobs', hash(ordinary)))).toEqual(ordinary)
  denied.mockRestore()
  await integration.checkpoints.privacyChanged()
  expect(await readFile(backup, 'utf8')).toBe(original)
  expect(await readFile(join(directory, 'blobs', hash(retained)))).toEqual(retained)
  await expect(readFile(join(directory, 'blobs', hash(ordinary)))).rejects.toMatchObject({ code: 'ENOENT' })
})

it.each([true, false])('carries dormant inline drafts, follow-ups and V1 previews unchanged until Owl migrates them (history %s)', async history => {
  const f = await profile(), at = new Date().toISOString()
  const inline: AgentAttachment = { id: 'watcher-inline', name: 'Synthetic Watcher.png', mimeType: 'image/png', dataUrl: PIXEL_DATA_URL }
  const ordinaryBytes = pngOfSize(80, 2)
  const ordinaryInline: AgentAttachment = { id: 'ordinary-inline', name: 'Synthetic ordinary.png', mimeType: 'image/png', dataUrl: 'data:image/png;base64,' + ordinaryBytes.toString('base64') }
  const draft = { threadId: f.hidden[2]!, draftId: randomUUID(), requestId: null, text: 'Synthetic dormant inline draft', attachments: [inline], updatedAt: at }
  const agentsFile = join(f.root, 'agents.json'), agents = JSON.parse(await readFile(agentsFile, 'utf8'))
  Object.assign(agents, { draftThreadId: draft.threadId, draftRequestId: null, draft: draft.text, draftAttachments: [inline], manualDraftId: draft.draftId,
    threadDrafts: [draft, { ...draft, threadId: f.ordinary, draftId: randomUUID(), attachments: [ordinaryInline] }] })
  await writeFile(agentsFile, JSON.stringify(agents))
  const followup = { id: randomUUID(), threadId: f.hidden[3]!, draftId: randomUUID(), text: 'Synthetic dormant inline follow-up', attachments: [inline], status: 'dispatching',
    createdAt: at, updatedAt: at, commandId: randomUUID(), messageId: randomUUID() }
  const followupsFile = join(f.root, 'followups.json')
  await writeFile(followupsFile, JSON.stringify({ items: [followup, { ...followup, id: randomUUID(), threadId: f.ordinary, draftId: randomUUID(), attachments: [ordinaryInline], status: 'queued' }], receipts: [] }))
  const preview = { threadId: f.hidden[0]!, messageId: 'legacy-message', commandId: 'legacy-command', storedAt: Date.now(), attachments: [inline] }
  const previewsFile = join(f.root, 'attachment-previews.json')
  await writeFile(previewsFile, JSON.stringify({ version: 1, entries: [preview, { ...preview, threadId: f.ordinary, attachments: [ordinaryInline] }] }))
  const stable = await workspaceFixture(f.root, { watcherEnabled: false, history })
  cleanup.push(stable.stop)
  const control = await agentControlFixture({ directory: f.root, host: stable.host, credentialOptions: { mode: 'unavailable' }, control: { watcherEnabled: false, historyEnabled: () => history } })
  cleanup.push(control.dispose)
  await control.control.start(); await control.control.privacyChanged()
  const savedAgents = JSON.parse(await readFile(agentsFile, 'utf8'))
  expect(savedAgents.threadDrafts.find((item: { threadId: string }) => item.threadId === draft.threadId)).toEqual(draft)
  expect(savedAgents.draftAttachments).toEqual([inline])
  expect(savedAgents.threadDrafts.find((item: { threadId: string }) => item.threadId === f.ordinary).attachments[0]).toHaveProperty('digest')
  expect(JSON.parse(await readFile(followupsFile, 'utf8')).items.find((item: { id: string }) => item.id === followup.id)).toEqual(followup)
  const savedPreviews = JSON.parse(await readFile(previewsFile, 'utf8'))
  expect(savedPreviews.version).toBe(1)
  expect(savedPreviews.entries.find((item: { threadId: string }) => item.threadId === preview.threadId)).toEqual(preview)
  const watcherDigest = createHash('sha256').update(PIXEL_PNG).digest('hex')
  await expect(readFile(join(f.root, 'attachments', watcherDigest + '.png'))).rejects.toMatchObject({ code: 'ENOENT' })
  await control.dispose(); await control.control.closed(); await stable.stop()
  const owl = await workspaceFixture(f.root, { watcherEnabled: true, history: true })
  cleanup.push(owl.stop)
  const reopened = await agentControlFixture({ directory: f.root, host: owl.host, credentialOptions: { mode: 'unavailable' }, control: { watcherEnabled: true } })
  cleanup.push(reopened.dispose)
  await reopened.control.start(); await reopened.control.privacyChanged()
  const migrated = JSON.parse(await readFile(agentsFile, 'utf8'))
  expect(migrated.threadDrafts.find((item: { threadId: string }) => item.threadId === draft.threadId).attachments[0]).toMatchObject({ id: inline.id, digest: watcherDigest })
  expect(JSON.parse(await readFile(followupsFile, 'utf8')).items.find((item: { id: string }) => item.id === followup.id).attachments[0]).toMatchObject({ id: inline.id, digest: watcherDigest })
  const migratedPreviews = JSON.parse(await readFile(previewsFile, 'utf8'))
  expect(migratedPreviews.version).toBe(2)
  expect(migratedPreviews.entries.find((item: { threadId: string }) => item.threadId === preview.threadId).attachments[0]).toMatchObject({ id: inline.id, digest: watcherDigest })
  expect(await readFile(join(f.root, 'attachments', watcherDigest + '.png'))).toEqual(PIXEL_PNG)
})

it.each(['readable', 'denied'] as const)('keeps dormant preview recovery records and bytes while ordinary temp copies expire (%s)', async access => {
  const f = await profile(), content = new AttachmentStore(f.root)
  await content.load()
  const watcher = await content.stage({ name: 'Synthetic Watcher copy.png', mimeType: 'image/png', bytes: PIXEL_PNG })
  const ordinary = await content.stage({ name: 'Synthetic ordinary copy.png', mimeType: 'image/png', bytes: pngOfSize(80, 2) })
  const entry = { threadId: f.hidden[0]!, messageId: 'copy-message', commandId: 'copy-command', storedAt: Date.now(), attachments: [watcher] }
  const mixed = join(f.root, 'attachment-previews.json.tmp-123-' + randomUUID())
  await writeFile(mixed, JSON.stringify({ version: 2, entries: [entry, { ...entry, threadId: f.ordinary, attachments: [ordinary] }] }))
  const damaged = join(f.root, 'attachment-previews.json.tmp-124-' + randomUUID())
  const damagedWords = '{"threadId":' + JSON.stringify(f.hidden[0]) + ',"attachments":' + JSON.stringify([watcher]) + ',"cut-off":'
  await writeFile(damaged, damagedWords)
  const ordinaryCopy = join(f.root, 'attachment-previews.json.tmp-125-' + randomUUID())
  await writeFile(ordinaryCopy, '{"threadId":' + JSON.stringify(f.ordinary) + ',"cut-off":')
  const actualRead = fsPromises.readFile
  const denied = access === 'denied' ? vi.spyOn(fsPromises, 'readFile').mockImplementation((...args) => args[0] === mixed
    ? Promise.reject(Object.assign(new Error('Synthetic denied preview copy'), { code: 'EACCES' })) : actualRead(...args)) : undefined
  const stable = await workspaceFixture(f.root, { watcherEnabled: false, history: false })
  cleanup.push(stable.stop)
  const control = await agentControlFixture({ directory: f.root, host: stable.host, credentialOptions: { mode: 'unavailable' }, control: { watcherEnabled: false, historyEnabled: () => false } })
  cleanup.push(control.dispose)
  await control.control.start()
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 2 * 60 * 60_000)
  const upkeep = control.control as unknown as { maintainAttachments(): Promise<void> }
  await upkeep.maintainAttachments()
  expect(await readFile(join(f.root, 'attachments', watcher.digest + '.png'))).toEqual(PIXEL_PNG)
  if (access === 'denied') {
    expect(await readFile(join(f.root, 'attachments', ordinary.digest + '.png'))).toEqual(pngOfSize(80, 2))
    denied!.mockRestore()
    await upkeep.maintainAttachments()
  }
  expect(JSON.parse(await readFile(mixed, 'utf8'))).toEqual({ version: 2, entries: [entry] })
  expect(await readFile(damaged, 'utf8')).toBe(damagedWords)
  await expect(readFile(ordinaryCopy)).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(readFile(join(f.root, 'attachments', ordinary.digest + '.png'))).rejects.toMatchObject({ code: 'ENOENT' })
})
