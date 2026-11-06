// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { MuseMspHost } from '../../../src/main/agents/muse'

// #1408: a turn's end settles the steers that went into it and Muse did not take. It must look only at its own unsettled
// steers, never at the thread's history (AGENTS.md: work per update must not grow with the user's history).

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

type Origin = { messageId: string; commandId: string; nativeCommandId: string; digest: string; createdAt: string; confirmed: boolean; attachments: []; steerTurnId?: string; notTaken?: true }
type Internals = {
  aliases: Record<string, { projectId: string; cwd: string; title: string; modelId: string; createdAt: string; origins: Origin[] }>
  indexSteers(): void
  persist(): Promise<void>
  settleTurn(id: string, turnId: string, outcome: 'completed'): void
  threads: Map<string, { notTakenMessageIds?: string[] }>
}

it('ends a turn without reading the thread’s history, settling only the steers that went into it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sotto-muse-steers-')); roots.push(root)
  const host = new MuseMspHost(root) as unknown as Internals
  host.persist = async () => undefined
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
})
