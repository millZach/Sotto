// @vitest-environment node
/**
 * A command's reply as a receipt (issue #323), end to end: the `AGENT_COMMAND` handler with the
 * broadcaster's receipt encoder, the desktop host router and the local host service joined as `index.ts`
 * joins them, an IPC stand-in that copies every message the way a structured clone would, the main
 * window's preload bridge, and the page's wrapped bridge that `AgentContext` reads. The broadcast is sent
 * by hand through the same broadcaster, so the window holds exactly what main recorded as sent. The
 * chain is `tests/fixtures/commandReceiptWindow.ts`, which the benchmark in `tests/perf` shares.
 *
 * It sits under `unit/main` although it crosses into the preload and the page, because what it pins is
 * main's answer: the receipt `AgentStateBroadcaster.encodeReceipt` builds and the handler sends. The page's
 * own resolution rules are tested alone in `tests/unit/renderer/agentStateCatalogs.test.ts`.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { serialize } from 'node:v8'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AGENT_COMMAND, AGENT_GET, agentCommandReceiptSchema, type AgentCommandReceipt, type AgentState } from '../../../src/shared/agents'
import { ThreadDraftStore } from '../../../src/renderer/src/agents/threadDraftStore'
import { immediatePublishScheduler } from '../../fixtures/publishScheduler'

vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => 'D:/fixture' },
  contextBridge: { exposeInMainWorld: vi.fn() },
  ipcRenderer: { invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn() },
}))
import { commandReceiptWindow } from '../../fixtures/commandReceiptWindow'

/** The fixture coordinator has no host ID of its own, so the router passes its thread IDs through unkeyed. */
const WORKSHOP = 'workshop'
const roots: string[] = []
const disposables: Array<() => void> = []
afterEach(async () => {
  for (const dispose of disposables.splice(0)) dispose()
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes('sotto-command-receipt-')) throw new Error('Unexpected fixture directory')
    await rm(root, { recursive: true, force: true })
  }
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'sotto-command-receipt-')); roots.push(root)
  const window = await commandReceiptWindow(root, immediatePublishScheduler)
  disposables.push(() => window.dispose())
  const gets = (): number => window.wire.filter(entry => entry.channel === AGENT_GET).length
  const replies = (): unknown[] => window.wire.filter(entry => entry.channel === AGENT_COMMAND).map(entry => entry.payload)
  return { ...window, gets, replies }
}

const saveDraft = (text: string) => ({ type: 'save-thread-draft' as const, threadId: WORKSHOP, draftId: randomUUID(), text })

describe('a command receipt', () => {
  it('carries no model entries for a draft save on an unchanged catalog', async () => {
    const f = await fixture()
    f.broadcast()
    expect(f.seen[0]!.host.models).toHaveLength(609)

    const reply = await f.page.command(saveDraft('Keep this draft'))
    const [wire] = f.replies() as [Record<string, unknown>]
    const onWire = agentCommandReceiptSchema.parse(wire)
    expect(onWire.host.models).toEqual({ revision: 1, omitted: true })
    expect(onWire.host.clientHosts?.map(client => client.models)).toEqual([{ revision: 1, omitted: true }])
    expect(JSON.stringify(wire)).not.toContain('synthetic-model')
    expect(serialize(wire).length).toBeLessThan(10_000)
    // The page puts back the catalog the broadcast sent, without asking main for it.
    expect(f.gets()).toBe(0)
    expect(reply.host.models).toBe(f.seen[0]!.host.models)
    expect(reply.host.clientHosts![0]!.models).toBe(f.seen[0]!.host.clientHosts![0]!.models)
  })

  it('recovers a stale catalog once, then resolves revision-only replies from it', async () => {
    const f = await fixture()
    f.broadcast()
    // A provider changes its catalog; this window still holds revision 1 when the next replies land.
    f.host.catalog = f.host.catalog.map(model => ({ ...model, ready: !model.ready }))
    await f.control.command({ type: 'refresh' })

    const [first, second] = await Promise.all([f.page.command(saveDraft('One')), f.page.command(saveDraft('Two'))])
    expect(f.gets()).toBe(1)
    const changed = f.router.shell().host.models
    expect(first.host.models).toEqual(changed)
    expect(second.host.models).toEqual(changed)

    const third = await f.page.command(saveDraft('Three'))
    expect(f.gets()).toBe(1)
    expect(third.host.models).toEqual(changed)
    expect((f.replies() as AgentCommandReceipt[]).map(reply => reply.host.models)).toEqual(Array(3).fill({ revision: 2, omitted: true }))
    // The broadcast that follows still carries revision 2 in full, since main never sent it, and the
    // window resolves it without a second recovery either way.
    f.broadcast()
    expect(f.seen.at(-1)!.host.models).toEqual(changed)
    expect(f.gets()).toBe(1)
  })

  it('still gives the draft store the exact revision it acknowledged', async () => {
    const f = await fixture()
    f.broadcast()
    const acknowledged: AgentState[] = []
    const drafts = new ThreadDraftStore(async command => { const reply = await f.page.command(command); acknowledged.push(reply); return reply }, 0)
    drafts.edit(WORKSHOP, { text: 'Measure the reply' })
    const draftId = drafts.draft(WORKSHOP).draftId
    drafts.flush(WORKSHOP)
    await vi.waitFor(() => expect(drafts.snapshot(WORKSHOP).save).toBe('saved'))
    expect(drafts.snapshot(WORKSHOP).saveError).toBeNull()
    expect(acknowledged.at(-1)!.threadDraftPersistence).toContainEqual({ threadId: WORKSHOP, draftId, status: 'saved' })
    expect(acknowledged.at(-1)!.host.models).toHaveLength(609)
  })

  it('still gives a settings card the effective settings', async () => {
    const f = await fixture()
    f.broadcast()
    const reply = await f.page.command({ type: 'configure', patch: { projectsDirectory: 'C:/Projects' } })
    expect(reply.error).toBeNull()
    expect(reply.configuration).toEqual(f.control.get().configuration)
    expect(reply.configuration).toMatchObject({ projectsDirectory: 'C:/Projects' })
    expect((f.replies()[0] as AgentCommandReceipt).configuration).toEqual(reply.configuration)
    expect(f.gets()).toBe(0)
  })
})
