// @vitest-environment node
// #2863: Re-pairing a desktop with a paired host mints a new clientId while the desktop's persistent hostId stays the
// same. Verify both safe migration for the verified same desktop and strict cross-desktop anti-spoofing isolation.
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { DesktopClients } from '../../src/host/desktopClients'
import { WatcherService } from '../../src/main/agents/watcher'
import { DESKTOP_CLIENTS_FILE, DESKTOP_IDENTITIES_FILE } from '../../src/shared/desktopClients'
import type { WatcherIdentity } from '../../src/shared/watcher'
import { agentControlFixture } from '../fixtures/agentControlFixture'
import { workspaceFixture } from '../fixtures/workspaceFixture'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const digestOf = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

async function hostFixture() {
  const workspace = await workspaceFixture(undefined, { history: false })
  const f = await agentControlFixture({
    directory: workspace.root,
    host: workspace.host,
    credentialOptions: { mode: 'unavailable' },
    control: { historyEnabled: () => false, watcherEnabled: true },
  })
  const desktops = new DesktopClients(f.root)
  const watcher = new WatcherService({
    directory: f.root,
    host: workspace.host,
    control: f.control,
    historyEnabled: () => false,
    workerHost: true,
    desktopHostIdOf: clientId => desktops.hostIdOf(clientId),
  })
  cleanups.push(async () => {
    watcher.close()
    f.control.dispose()
    await f.control.closed()
    await workspace.stop()
    await workspace.remove()
  })
  await f.control.start()
  await f.control.commandShell({ type: 'connect', provider: 'codex' })
  await watcher.recover()
  const projectPath = join(f.root, 'repo')
  await mkdir(projectPath, { recursive: true })
  const created = await f.control.commandShell({ type: 'create-project', provider: 'codex', title: 'Repo', path: projectPath, useExisting: true })
  const project = created.host.projects.find(item => item.path === projectPath)!
  const model = created.host.models.find(item => item.providerId === 'codex' && item.ready)!
  const threadShell = await f.control.commandShell({ type: 'create-thread', projectId: project.id, modelId: model.id, title: 'Worker' })
  const thread = threadShell.host.threads[0]!
  const hostId = f.control.hostId()
  if (!hostId) throw new Error('Expected hostId')
  const finishTurns = () => {
    for (const item of workspace.adapters.codex.state.threads) item.status = 'idle'
    workspace.adapters.codex.emit()
  }
  return { root: f.root, hostId, threadId: thread.id, desktops, watcher, control: f.control, finishTurns }
}

async function writeIdentities(root: string, desktops: DesktopClients, clients: string[], mapping: Record<string, string>) {
  await writeFile(join(root, DESKTOP_CLIENTS_FILE), JSON.stringify(clients))
  await writeFile(join(root, DESKTOP_IDENTITIES_FILE), JSON.stringify({ version: 1, desktops: mapping }))
  await desktops.refresh()
}

function makeMaster(hostId: string, createdAt: string): WatcherIdentity {
  return {
    target: { hostId, threadId: randomUUID() },
    projectId: 'watcher-proj',
    provider: 'codex',
    creationOperationId: randomUUID(),
    createdAt,
  }
}

function sendPacket(hostId: string, threadId: string, master: WatcherIdentity, watchId: string, generation: number, text: string) {
  const requestId = randomUUID(), retryKey = randomUUID(), opId = randomUUID(), rootUserMessageId = randomUUID(), now = new Date().toISOString()
  const input = { requestId, retryKey, target: { hostId, threadId }, text, delivery: 'now' as const }
  return {
    master,
    request: { id: requestId, watcher: master.target, rootUserMessageId, createdAt: now, standingWatchId: watchId },
    ceiling: 'full-access' as const,
    operation: {
      id: opId, requestId, retryKey, digest: digestOf(['send_to_thread', input]), action: 'send' as const,
      target: { hostId, threadId }, standingWatchId: watchId, generation, delivery: 'now' as const, deliveryState: 'queued' as const,
      createdAt: now, updatedAt: now, receiptId: randomUUID(), cardId: randomUUID(), draftId: randomUUID(), messageId: randomUUID(),
      anchorMessageId: rootUserMessageId,
    },
    call: { name: 'send_to_thread' as const, input },
  }
}

it('migrates watches, requests, operations, and replacement watermarks across desktop re-pair without breaking watch toggles (#2863)', async () => {
  const h = await hostFixture()
  const DESKTOP_A = randomUUID(), guard = () => undefined, mayAnswer = () => true
  const masterOld = makeMaster(DESKTOP_A, '2026-11-01T00:00:00.000Z')
  const masterCurrent = makeMaster(DESKTOP_A, '2026-11-02T00:00:00.000Z')
  const watch1 = randomUUID(), watch2 = randomUUID()

  // Desktop A pairs initially as client-old (even before desktop-identities.json existed, simulating a pre-fix pairing).
  await writeFile(join(h.root, DESKTOP_CLIENTS_FILE), JSON.stringify(['client-old']))
  await h.desktops.refresh()

  const sync1 = await h.watcher.readRemote({
    master: masterCurrent,
    standingWatches: [{ id: watch1, target: { hostId: h.hostId, threadId: h.threadId }, createdAt: '2026-11-02T00:00:01.000Z', generation: 0 }],
  }, 'client-old', guard, mayAnswer)
  expect(sync1).toMatchObject({ standingWatches: [expect.objectContaining({ id: watch1 })] })

  // Send a prompt under watch1 before re-pairing so a request + operation exist under client-old.
  const sent1 = await h.watcher.admitRemote(sendPacket(h.hostId, h.threadId, masterCurrent, watch1, 0, 'Before re-pair'), 'client-old', guard, mayAnswer)
  expect(sent1).toMatchObject({ status: 'ok' })
  const op1Id = (sent1 as { receipt: { operationId: string } }).receipt.operationId
  h.finishTurns()
  await expect.poll(() => h.control.watcherSnapshot().threads.find(item => item.id === h.threadId)?.status).toBe('idle')

  // Desktop A re-pairs: SSH launch script writes client-new -> DESKTOP_A in desktop-identities.json; client-old is revoked.
  await writeIdentities(h.root, h.desktops, ['client-new'], { 'client-new': DESKTOP_A })

  // 1. Syncing the existing watch under client-new succeeds (no THREAD_TAKEN_OVER) and migrates origin to client-new.
  const syncAfterRepair = await h.watcher.readRemote({
    master: masterCurrent,
    standingWatches: [{ id: watch1, target: { hostId: h.hostId, threadId: h.threadId }, createdAt: '2026-11-02T00:00:01.000Z', generation: 0 }],
  }, 'client-new', guard, mayAnswer)
  expect(syncAfterRepair).toMatchObject({ standingWatches: [expect.objectContaining({ id: watch1, remoteOrigin: expect.objectContaining({ clientId: 'client-new' }) })] })

  // 2. Old Watcher conversation from before replacement is STILL refused with NOT_CURRENT_WATCHER after re-pair.
  const oldRefused = await h.watcher.readRemote({ master: masterOld, standingWatches: [] }, 'client-new', guard, mayAnswer)
  expect(oldRefused).toMatchObject({ status: 'refused', code: 'NOT_CURRENT_WATCHER' })

  // 3. Exact operation read for the pre-re-pair operation succeeds under client-new.
  const opRead = await h.watcher.readRemote({
    master: masterCurrent,
    call: { name: 'read_operation', input: { operationId: op1Id } },
  }, 'client-new', guard, mayAnswer)
  expect(opRead).toMatchObject({ status: 'ok', receipt: { operationId: op1Id } })

  // 4. Toggling Watch off/on (replacing watch1 with a brand-new watch2 on the same thread) succeeds cleanly.
  const syncReplaced = await h.watcher.readRemote({
    master: masterCurrent,
    standingWatches: [{ id: watch2, target: { hostId: h.hostId, threadId: h.threadId }, createdAt: '2026-11-02T00:05:00.000Z', generation: 0 }],
  }, 'client-new', guard, mayAnswer)
  expect(syncReplaced).toMatchObject({ standingWatches: [expect.objectContaining({ id: watch2 })] })

  // 5. Sending under watch2 passes checkRemoteAuthority (no REQUEST_NOT_ACTIVE).
  const sent2 = await h.watcher.admitRemote(sendPacket(h.hostId, h.threadId, masterCurrent, watch2, 0, 'After re-pair'), 'client-new', guard, mayAnswer)
  expect(sent2).toMatchObject({ status: 'ok' })

  // 6. remoteMasters is deduplicated to one entry for (client-new, DESKTOP_A).
  const masters = h.control.watcherRecords.copy().remoteMasters ?? []
  expect(masters.filter(item => item.masterHostId === DESKTOP_A)).toHaveLength(1)
  expect(masters.find(item => item.masterHostId === DESKTOP_A)?.clientId).toBe('client-new')
})

// #2873: replacing Watcher (New Watcher or a provider change) gives the desktop a new Watcher conversation, and the standing watches it made on a paired
// host stay bound to the old one until the host hears from the new one. On reconnect the desktop reads with the new
// Watcher, `adopt` and its standing watches (`reconcileRemoteNow`), and that read must re-bind every watch of this
// desktop, even when the desktop also re-paired in between and the host hears it under a new clientId.
it.each([
  { label: 'the same pairing', repair: false },
  { label: 'a re-pair in between', repair: true },
])('re-binds standing watches to a new Watcher after a replacement and reconnect with $label, so its sends go (#2873)', async ({ repair }) => {
  const h = await hostFixture()
  const DESKTOP_A = randomUUID(), guard = () => undefined, mayAnswer = () => true
  const before = makeMaster(DESKTOP_A, '2026-11-22T00:00:00.000Z')
  const after = makeMaster(DESKTOP_A, '2026-11-25T02:24:27.772Z')
  const watch = { id: randomUUID(), target: { hostId: h.hostId, threadId: h.threadId }, createdAt: '2026-11-22T00:00:01.000Z', generation: 0 }

  // A pairing from before desktop-identities.json existed, as forge's was.
  await writeFile(join(h.root, DESKTOP_CLIENTS_FILE), JSON.stringify(['client-old']))
  await h.desktops.refresh()
  expect(await h.watcher.readRemote({ master: before, adopt: true, standingWatches: [watch] }, 'client-old', guard, mayAnswer))
    .toMatchObject({ standingWatches: [expect.objectContaining({ id: watch.id })] })
  expect(await h.watcher.admitRemote(sendPacket(h.hostId, h.threadId, before, watch.id, 0, 'Before the replacement'), 'client-old', guard, mayAnswer))
    .toMatchObject({ status: 'ok' })
  h.finishTurns()
  await expect.poll(() => h.control.watcherSnapshot().threads.find(item => item.id === h.threadId)?.status).toBe('idle')

  // Watcher is replaced, and for the second case a re-pair the launch script records over SSH.
  const client = repair ? 'client-new' : 'client-old'
  if (repair) await writeIdentities(h.root, h.desktops, ['client-new'], { 'client-new': DESKTOP_A })

  // Until the host has heard from the new Watcher, its watch is the old one's, and a send under the new one is refused.
  // Only without a re-pair: admission migrates a re-paired desktop's records before it refuses, so a send here would
  // leave the reconnect read below nothing to migrate.
  if (!repair) {
    expect(await h.watcher.admitRemote(sendPacket(h.hostId, h.threadId, after, watch.id, 0, 'Too early'), client, guard, mayAnswer))
      .toMatchObject({ status: 'refused', code: 'REQUEST_NOT_ACTIVE' })
  } else {
    expect(h.control.watcherRecords.copy().watches?.find(item => item.id === watch.id)?.remoteOrigin)
      .toMatchObject({ clientId: 'client-old', masterCreationOperationId: before.creationOperationId })
  }

  // The desktop's reconnect read under the new Watcher migrates and re-binds the watch to it.
  expect(await h.watcher.readRemote({ master: after, adopt: true, standingWatches: [watch] }, client, guard, mayAnswer)).toMatchObject({
    standingWatches: [expect.objectContaining({ id: watch.id,
      remoteOrigin: expect.objectContaining({ clientId: client, masterCreationOperationId: after.creationOperationId, masterCreatedAt: after.createdAt }) })],
  })

  // Watcher's next send on the watched thread goes, and the replaced Watcher stays refused.
  expect(await h.watcher.admitRemote(sendPacket(h.hostId, h.threadId, after, watch.id, 0, 'After the replacement'), client, guard, mayAnswer))
    .toMatchObject({ status: 'ok' })
  expect(await h.watcher.admitRemote(sendPacket(h.hostId, h.threadId, before, watch.id, 0, 'From the replaced Watcher'), client, guard, mayAnswer))
    .toMatchObject({ status: 'refused', code: 'NOT_CURRENT_WATCHER' })
  expect(h.control.watcherRecords.copy().remoteMasters?.filter(item => item.masterHostId === DESKTOP_A))
    .toEqual([expect.objectContaining({ clientId: client, creationOperationId: after.creationOperationId })])
})

it('refuses cross-desktop masterHostId spoofing from both bound and unbound desktops (#2863)', async () => {
  const h = await hostFixture()
  const DESKTOP_A = randomUUID(), DESKTOP_B = randomUUID(), guard = () => undefined, mayAnswer = () => true
  const masterA = makeMaster(DESKTOP_A, '2026-11-02T00:00:00.000Z')
  const watchA = randomUUID(), watchSpoof = randomUUID()

  // Desktop A (bound), Desktop B (bound to a DIFFERENT desktopHostId), and Desktop U (unbound).
  await writeIdentities(h.root, h.desktops, ['client-a', 'client-b', 'client-unbound'], {
    'client-a': DESKTOP_A,
    'client-b': DESKTOP_B,
  })

  const syncedA = await h.watcher.readRemote({
    master: masterA,
    standingWatches: [{ id: watchA, target: { hostId: h.hostId, threadId: h.threadId }, createdAt: '2026-11-02T00:00:01.000Z', generation: 0 }],
  }, 'client-a', guard, mayAnswer)
  expect(syncedA).toMatchObject({ standingWatches: [expect.objectContaining({ id: watchA })] })
  const sentA = await h.watcher.admitRemote(sendPacket(h.hostId, h.threadId, masterA, watchA, 0, 'Desktop A prompt'), 'client-a', guard, mayAnswer)
  expect(sentA).toMatchObject({ status: 'ok' })
  const opAId = (sentA as { receipt: { operationId: string } }).receipt.operationId

  // Bound Desktop B spoofing Desktop A's masterHostId is refused everywhere and gets an empty projection.
  expect(await h.watcher.readRemote({ master: masterA, standingWatches: [] }, 'client-b', guard, mayAnswer))
    .toMatchObject({ status: 'refused', code: 'INVALID_INPUT' })
  expect(await h.watcher.admitRemote(sendPacket(h.hostId, h.threadId, masterA, watchA, 0, 'Spoofed B'), 'client-b', guard, mayAnswer))
    .toMatchObject({ status: 'refused', code: 'INVALID_INPUT' })
  expect(await h.watcher.readRemote({ master: masterA, call: { name: 'read_operation', input: { operationId: opAId } } }, 'client-b', guard, mayAnswer))
    .toMatchObject({ status: 'refused', code: 'INVALID_INPUT' })
  expect(h.watcher.remoteProjection(masterA, 'client-b')).toMatchObject({ requests: [], operations: [], standingWatches: [] })

  // Unbound Desktop U spoofing Desktop A's masterHostId CANNOT migrate, take over, send under, or read Desktop A's work.
  expect(await h.watcher.readRemote({
    master: masterA,
    standingWatches: [{ id: watchA, target: { hostId: h.hostId, threadId: h.threadId }, createdAt: '2026-11-02T00:00:01.000Z', generation: 0 }],
  }, 'client-unbound', guard, mayAnswer)).toMatchObject({ status: 'refused', code: 'THREAD_TAKEN_OVER' })
  expect(await h.watcher.readRemote({
    master: masterA,
    standingWatches: [{ id: watchSpoof, target: { hostId: h.hostId, threadId: h.threadId }, createdAt: '2026-11-02T00:05:00.000Z', generation: 0 }],
  }, 'client-unbound', guard, mayAnswer)).toMatchObject({ status: 'refused', code: 'THREAD_TAKEN_OVER' })
  expect(await h.watcher.admitRemote(sendPacket(h.hostId, h.threadId, masterA, watchA, 0, 'Spoofed U'), 'client-unbound', guard, mayAnswer))
    .toMatchObject({ status: 'refused', code: 'REQUEST_NOT_ACTIVE' })
  expect(await h.watcher.readRemote({ master: masterA, call: { name: 'read_operation', input: { operationId: opAId } } }, 'client-unbound', guard, mayAnswer))
    .toMatchObject({ status: 'refused', code: 'UNKNOWN_OPERATION' })
  expect(h.watcher.remoteProjection(masterA, 'client-unbound')).toMatchObject({ requests: [], operations: [], standingWatches: [] })

  // Desktop A's original watch is completely intact.
  expect(h.control.watcherRecords.copy().watches?.map(item => ({ id: item.id, clientId: item.remoteOrigin?.clientId })))
    .toEqual([{ id: watchA, clientId: 'client-a' }])
})
