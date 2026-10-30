// @vitest-environment node
// #1178 part 3 (Zach's pick A, October 29, 2026): Watcher's propose_moves, offered only where moving threads runs. It
// puts a proposal before the user and moves nothing.
import { afterEach, expect, it, vi } from 'vitest'
import type { WatcherService } from '../../../src/main/agents/watcher'
import { WatcherToolServer } from '../../../src/main/agents/watcherTools'
import { THREAD_MOVE_PROPOSE_NOTE, THREAD_MOVE_PROPOSE_TOOL } from '../../../src/shared/threadMoves'

const servers: WatcherToolServer[] = []
afterEach(async () => { for (const server of servers.splice(0)) await server.close() })
const service = (current = true) => ({ isCurrent: () => current, startCall: vi.fn() }) as unknown as WatcherService
const PROPOSAL = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d', FORGE = '0b7f4c1e-2a9d-4f61-8c3e-5d2b9a7e4f10', HERE = '7d1c8a52-5f0a-4d55-9a38-1f9b7a2a0c11'
const answer = { status: 'ok', proposalId: PROPOSAL, machine: 'forge', threads: [{ hostId: HERE, threadId: 'tray', outcome: 'moves' }], note: THREAD_MOVE_PROPOSE_NOTE }
const names = (server: WatcherToolServer): string[] => server.definitions.map(definition => definition.name)

it('is offered only with Work across machines on and moving threads running', () => {
  const moves = { propose: vi.fn(() => answer) }
  const make = (options: ConstructorParameters<typeof WatcherToolServer>[1]) => { const server = new WatcherToolServer(service(), options); servers.push(server); return server }
  expect(names(make({ machines: true, moves }))).toContain(THREAD_MOVE_PROPOSE_TOOL)
  expect(names(make({ machines: true }))).not.toContain(THREAD_MOVE_PROPOSE_TOOL)
  expect(names(make({ moves }))).not.toContain(THREAD_MOVE_PROPOSE_TOOL)
})

it('passes Watcher’s words to the move service, answers what it proposed, and never starts a Watcher operation', async () => {
  const moves = { propose: vi.fn(() => answer) }
  const watcher = service()
  const server = new WatcherToolServer(watcher, { machines: true, moves }); servers.push(server)
  const input = { threads: [{ hostId: HERE, threadId: 'tray' }], machine: FORGE }
  const result = await server.call('watcher', THREAD_MOVE_PROPOSE_TOOL, input)
  expect(moves.propose).toHaveBeenCalledWith(input)
  expect(result.structuredContent).toEqual(answer)
  expect(result.isError).toBeUndefined()
  expect(watcher.startCall).not.toHaveBeenCalled()
  // Only the current Watcher proposes.
  const stale = new WatcherToolServer(service(false), { machines: true, moves }); servers.push(stale)
  expect((await stale.call('watcher', THREAD_MOVE_PROPOSE_TOOL, input)).structuredContent).toMatchObject({ status: 'refused', code: 'NOT_CURRENT_WATCHER' })
  expect(moves.propose).toHaveBeenCalledTimes(1)
})
