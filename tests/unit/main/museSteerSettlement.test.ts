// @vitest-environment node
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { MuseMspHost } from '../../../src/main/agents/muse'

// #1408: a turn's end settles the steers that went into it and Muse did not take. It must look only at its own unsettled
// steers, never at the thread's history (AGENTS.md: work per update must not grow with the user's history), and saves
// through the store's shared write, which serializes the threads once when it starts rather than copying them first.

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

type Origin = { messageId: string; commandId: string; nativeCommandId: string; digest: string; createdAt: string; confirmed: boolean; attachments: []; steerTurnId?: string; notTaken?: true }
type Internals = {
  aliases: Record<string, { projectId: string; cwd: string; title: string; modelId: string; createdAt: string; origins: Origin[] }>
  indexSteers(): void
  writing: Promise<void>
  settleTurn(id: string, turnId: string, outcome: 'completed'): void
  settleResumedSteers(id: string, resumed: { session: { activeTurnId?: string }; history: { items: unknown[] } }): boolean
  threads: Map<string, { notTakenMessageIds?: string[] }>
}

it('ends a turn without reading the thread’s history, settling only the steers that went into it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sotto-muse-steers-')); roots.push(root)
  const host = new MuseMspHost(root) as unknown as Internals
  const createdAt = new Date().toISOString()
  const origin = (messageId: string, extra: Partial<Origin> = {}): Origin =>
    ({ messageId, commandId: `c-${messageId}`, nativeCommandId: `n-${messageId}`, digest: 'd', createdAt, confirmed: true, attachments: [], ...extra })
  const history = Array.from({ length: 10_000 }, (_, index) => origin(`m${index}`, index % 2 ? { steerTurnId: `old-${index}` } : {}))
  let visits = 0
  const origins = new Proxy([...history, origin('pending', { confirmed: false, steerTurnId: 'turn-2' })], {
    get(target, key, receiver) { if (typeof key === 'string' && /^\d+$/u.test(key) || key === Symbol.iterator) visits++; return Reflect.get(target, key, receiver) },
  })
  host.aliases = { t: { projectId: 'p', cwd: root, title: 'Thread', modelId: 'muse', createdAt, origins } }
  host.indexSteers() // On connect, once.
  visits = 0
  host.settleTurn('t', 'turn-1', 'completed')
  expect(visits).toBe(0)
  expect(host.threads.get('t')?.notTakenMessageIds).toBeUndefined()
  host.settleTurn('t', 'turn-2', 'completed')
  expect(visits).toBe(0)
  expect(host.threads.get('t')?.notTakenMessageIds).toEqual(['pending'])
  expect(origins.at(-1)).toMatchObject({ notTaken: true, confirmed: false })
  await host.writing
  const saved = JSON.parse(await readFile(join(root, 'muse-threads.json'), 'utf8')) as Record<string, { origins: Origin[] }>
  expect(saved.t!.origins.at(-1)).toMatchObject({ messageId: 'pending', notTaken: true })
})

it('settles a steer saved without its turn when the turn running at its resume ends, not before (#1408)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sotto-muse-steers-')); roots.push(root)
  const host = new MuseMspHost(root) as unknown as Internals
  const createdAt = new Date().toISOString()
  // What an older Sotto saved: an unconfirmed steer with no turn, resumed while a turn runs whose history does not hold it.
  const held: Origin = { messageId: 'held', commandId: 'c-held', nativeCommandId: 'n-held', digest: 'd', createdAt, confirmed: false, attachments: [] }
  host.aliases = { t: { projectId: 'p', cwd: root, title: 'Thread', modelId: 'muse', createdAt, origins: [held] } }
  host.indexSteers()
  expect(host.settleResumedSteers('t', { session: { activeTurnId: 'turn-9' }, history: { items: [] } })).toBe(true)
  expect(host.threads.get('t')?.notTakenMessageIds).toBeUndefined()
  host.settleTurn('t', 'turn-9', 'completed')
  expect(host.threads.get('t')?.notTakenMessageIds).toEqual(['held'])
  expect(held).toMatchObject({ notTaken: true, steerTurnId: 'turn-9' })
  await host.writing
})
