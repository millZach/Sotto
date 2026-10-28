// @vitest-environment node
// #1316 review: an outcome update of a delegation on a paired host does work for the delegations it names, never for the
// history behind them, at the owner's scale or a quarter of it (AGENTS.md: work per update must not grow with history).
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { DesktopRemoteDelegations, type RemoteDelegationConnection } from '../../../src/main/agents/delegationRemoteDesktop'
import type { DelegationNews } from '../../../src/shared/delegation'
import type { RelayedReply } from '../../../src/shared/delegationRelay'
import { REMOTE_DELEGATION_HISTORY, remoteDelegationHistory } from '../../fixtures/ownerScale'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes('sotto-remote-scale-')) throw new Error('Unexpected test directory')
    await rm(root, { recursive: true, force: true })
  }
})
const MAC = '33333333-3333-4333-8333-333333333333', THERE = '44444444-4444-4444-8444-444444444444'

/** What one outcome update writes, with `history` settled delegations behind it. */
async function updateWith(history: number) {
  const root = await mkdtemp(join(tmpdir(), 'sotto-remote-scale-')); roots.push(root)
  const settledPath = join(root, 'delegation-remote-settled.jsonl')
  // The history as a record from before it was split keeps it, in the live file: the first save moves it to the history.
  await writeFile(join(root, 'delegation-remote.json'), JSON.stringify({ version: 1, delegations: remoteDelegationHistory(MAC, 'parent-old', history) }))
  let push: ((caller: string, news: DelegationNews, replies: readonly RelayedReply[]) => void) | undefined
  const connection: RemoteDelegationConnection = { hostId: MAC, kind: 'remote', service: { supportsDelegationRemote: true,
    delegationRemoteAsk: async () => ({ status: 'ok', delegation: { id: THERE, thread: 'child-new', outcome: 'working' } }),
    subscribeDelegationRemoteNews: listener => { push = listener; return () => undefined } } }
  const remote = new DesktopRemoteDelegations(root, { machineName: () => 'the Mac' })
  await remote.load()
  const told: DelegationNews[] = []
  remote.useDelivery(async (_, news) => { told.push(news) })
  remote.useHosts({ subscribeConnected: () => () => undefined, remoteConnections: () => [connection] })
  await remote.start('parent-new', 'code-review', { hostId: MAC, projectId: 'p', receipt: { hostId: MAC, name: 'the Mac', awayFromDefault: false } },
    { levels: 0, rootUserMessageId: 'root', runtimeMode: 'auto', input: { work: 'code-review', brief: 'Review it.' }, waitMs: 0 })
  const before = await stat(settledPath).then(file => file.size, () => 0)
  push!('parent-new', { source: 'delegation', items: [{ delegationId: THERE, threadId: 'child-new', outcome: 'background' }] }, [])
  await expect.poll(() => told.length).toBe(1)
  const live = (await readFile(join(root, 'delegation-remote.json'), 'utf8')).length
  const appended = await stat(settledPath).then(file => file.size, () => 0) - before
  // The history is still there to read.
  expect(remote.list('parent-old')).toHaveLength(20)
  // And after a restart, with the delegation that moved as it last stood.
  const again = new DesktopRemoteDelegations(root, { machineName: () => 'the Mac' })
  await again.load()
  expect(again.list('parent-old')).toHaveLength(20)
  expect(again.list('parent-new')).toEqual([expect.objectContaining({ outcome: 'background' })])
  return { live, appended }
}

it('writes the same for an outcome update whatever history is behind it, the owner’s or a quarter of it', async () => {
  const quarter = await updateWith(REMOTE_DELEGATION_HISTORY / 4), owner = await updateWith(REMOTE_DELEGATION_HISTORY)
  // The live record holds only the delegation that moved, and the history is not written again.
  expect(owner).toEqual(quarter)
  expect(owner.appended).toBe(0)
  expect(owner.live).toBeLessThan(2_000)
})
