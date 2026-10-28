// @vitest-environment node
/**
 * A check's reply on its row of delegated work (#1312, Zach's pick C on October 28, 2026): the window's read carries a
 * check's mark and, once answered, its reply excerpt, the first line with words in it and no more, and the window reads
 * the rest of the reply, as `read_delegation` gives it, only on a press and only for a check.
 */
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { checkReplyExcerpt, DelegationService, type DelegationCoordinator } from '../../../src/main/agents/delegation'
import { registerDelegationIpc } from '../../../src/main/agents/delegationIpc'
import { hostEntityKey } from '../../../src/shared/clientIdentity'
import { CHECK_REPLY_EXCERPT_MAX, DELEGATION_CHECK_REPLY_READ, DELEGATIONS_READ, type DelegatedView, type DelegationsRead } from '../../../src/shared/delegation'
import { WATCHER_REPLY_BYTES_MAX } from '../../../src/shared/watcher'
import { EMPTY_AGENT_HOST, type AgentHostSnapshot } from '../../../src/shared/agents'
import { ipcRegistry } from '../../fixtures/ipcHarness'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes('sotto-check-replies-')) throw new Error('Unexpected test directory')
    await rm(root, { recursive: true, force: true })
  }
})

const at = '2026-10-28T14:00:00.000Z'
const LOCAL = '11111111-1111-4111-8111-111111111111'
const REMOTE = '22222222-2222-4222-8222-222222222222'
const FAILED = 'Failed: 2 of 1,214 tests.\n1,209 passed, 2 failed, 3 skipped, in 4 min 38 s.\n\nFailing:\ntests/unit/agents/checkQueue.test.ts:212  Stop on a waiting check'
const record = (patch: Record<string, unknown>) => ({ id: randomUUID(), delegatingThreadId: 'parent', delegatedThreadId: 'child', action: 'start', work: 'building',
  rootUserMessageId: 'root', inputDigest: 'a'.repeat(64), draftId: randomUUID(), messageId: randomUUID(), expectedLastUserMessageId: null,
  deliveryState: 'accepted', outcome: 'answered', outcomeAt: at, told: 'answered', charged: true, createdAt: at, updatedAt: at, ...patch })

/** Delegation over a saved record and a thread store holding `replies` by message ID, with checks shown or not. */
async function service(records: Record<string, unknown>[], replies: Record<string, string>, options: { checkReplies?: boolean; history?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'sotto-check-replies-')); roots.push(root)
  await writeFile(join(root, 'delegations.json'), JSON.stringify({ version: 1, delegations: [], links: [], roots: [] }))
  const snapshot: AgentHostSnapshot = { ...EMPTY_AGENT_HOST, connected: true, threads: [] }
  const control: DelegationCoordinator = {
    hostId: () => LOCAL, watcherSnapshot: () => snapshot, configuration: () => ({}), useDelegation: () => () => undefined,
    commandFromDelegation: async () => ({ host: snapshot }) as never, hasPendingThreadWork: () => false, hasUserDraft: () => false,
    refreshDelegationObservation: () => undefined, deliverWakeUp: async () => undefined,
  }
  const threadMessage = vi.fn((_threadId: string, messageId: string) => replies[messageId] === undefined ? undefined : { id: messageId, role: 'assistant', text: replies[messageId]! })
  const delegation = new DelegationService({ directory: root, control, host: { setDelegatedBy: async () => undefined, threadMessage }, historyEnabled: () => options.history ?? true,
    ...options.checkReplies === false ? {} : { checkReplies: true } })
  await delegation.recover()
  // As they stand in this run, so a check still working is not ended as a restart would end it.
  ;(delegation as unknown as { records: unknown[] }).records = records
  return { delegation, threadMessage }
}
const made = (delegation: DelegationService): DelegatedView[] => delegation.views('parent').made as DelegatedView[]

describe('a check\'s reply excerpt', () => {
  it('is the first line with words in it, as the thread wrote it, cut at 200 characters and never inside a character', () => {
    expect(checkReplyExcerpt(FAILED)).toBe('Failed: 2 of 1,214 tests.')
    // A reply that opens with prose shows its prose: Sotto reads no verdict from it.
    expect(checkReplyExcerpt('\n  \r\nI ran the suite on forge. Most of it passed.\r\nmore')).toBe('I ran the suite on forge. Most of it passed.')
    expect(checkReplyExcerpt('\n \n')).toBeUndefined()
    expect(checkReplyExcerpt('x'.repeat(500))).toHaveLength(CHECK_REPLY_EXCERPT_MAX)
    // A character outside the Basic Multilingual Plane straddling the cut is left out whole.
    const straddling = checkReplyExcerpt(`${'x'.repeat(CHECK_REPLY_EXCERPT_MAX - 1)}🧪 tail`)!
    expect(straddling).toBe('x'.repeat(CHECK_REPLY_EXCERPT_MAX - 1))
  })

  it('goes with an answered check\'s row, never with another delegation\'s, and never more of the reply than its first line', async () => {
    const replyId = randomUUID(), reviewReplyId = randomUUID()
    const check = record({ check: true, replyMessageId: replyId })
    const waiting = record({ check: true, delegatedThreadId: 'waiting', outcome: 'working', told: 'working', outcomeAt: undefined })
    const review = record({ work: 'code-review', delegatedThreadId: 'review', replyMessageId: reviewReplyId })
    const f = await service([check, waiting, review], { [replyId]: FAILED, [reviewReplyId]: 'Two findings.' })
    const [checkView, waitingView, reviewView] = made(f.delegation)
    expect(checkView).toMatchObject({ id: check.id, outcome: 'answered', check: true, checkReply: { excerpt: 'Failed: 2 of 1,214 tests.', truncated: false } })
    expect(JSON.stringify(checkView)).not.toContain('1,209 passed')
    // A check still working, waiting its turn among them, has its mark and nothing of a reply: its card is today's.
    expect(waitingView).toMatchObject({ outcome: 'working', check: true })
    expect(waitingView).not.toHaveProperty('checkReply')
    expect(reviewView).not.toHaveProperty('check')
    expect(reviewView).not.toHaveProperty('checkReply')
    // The thread the check was sent to reads its brief as before, with no mark and no reply.
    const [brief] = f.delegation.views('child').received
    expect(brief).toMatchObject({ id: check.id, outcome: 'answered' })
    expect(brief).not.toHaveProperty('check')
    expect(brief).not.toHaveProperty('checkReply')
    // The excerpt is read once for that reply, not on every read.
    made(f.delegation); made(f.delegation)
    expect(f.threadMessage.mock.calls.filter(([, id]) => id === replyId)).toHaveLength(1)
    expect(f.threadMessage.mock.calls.filter(([, id]) => id === reviewReplyId)).toHaveLength(0)
  })

  it('says a reply longer than 32 KiB was cut, and that one no longer held was not kept, as read_delegation says it', async () => {
    const long = randomUUID(), gone = randomUUID()
    const cut = record({ check: true, replyMessageId: long })
    const lost = record({ check: true, delegatedThreadId: 'lost', replyMessageId: gone })
    const f = await service([cut, lost], { [long]: `Failed: 37 of 1,214 tests.\n${'log line\n'.repeat(WATCHER_REPLY_BYTES_MAX / 4)}` })
    expect(made(f.delegation).map(view => view.checkReply)).toEqual([{ excerpt: 'Failed: 37 of 1,214 tests.', truncated: true }, { unavailable: true }])
    // With Keep local history off, a reply from before Sotto restarted is not kept, even while its message is still there.
    const off = await service([record({ check: true, replyMessageId: long })], { [long]: FAILED }, { history: false })
    expect(made(off.delegation)[0]!.checkReply).toEqual({ unavailable: true })
  })

  it('is not in the read where checks are not offered, as on stable, though the record keeps its check', async () => {
    const replyId = randomUUID()
    const check = record({ check: true, replyMessageId: replyId })
    const f = await service([check], { [replyId]: FAILED }, { checkReplies: false })
    expect(made(f.delegation)[0]).not.toHaveProperty('check')
    expect(made(f.delegation)[0]).not.toHaveProperty('checkReply')
    expect(f.delegation.checkReply('parent', check.id)).toBeUndefined()
    expect(f.threadMessage).not.toHaveBeenCalled()
  })
})

describe('a check\'s reply, read on a press', () => {
  it('is the reply as read_delegation gives it, for an answered check this thread delegated, and nothing for anything else', async () => {
    const replyId = randomUUID(), reviewReplyId = randomUUID()
    const check = record({ check: true, replyMessageId: replyId })
    const working = record({ check: true, delegatedThreadId: 'working', outcome: 'working', told: 'working' })
    const review = record({ delegatedThreadId: 'review', replyMessageId: reviewReplyId })
    const f = await service([check, working, review], { [replyId]: FAILED, [reviewReplyId]: 'Two findings.' })
    expect(f.delegation.checkReply('parent', check.id)).toEqual({ text: FAILED, truncated: false })
    // Not a check, not answered, or another thread's: nothing, and its reply is never read.
    expect(f.delegation.checkReply('parent', review.id)).toBeUndefined()
    expect(f.delegation.checkReply('parent', working.id)).toBeUndefined()
    expect(f.delegation.checkReply('other', check.id)).toBeUndefined()
    expect(f.delegation.checkReply('parent', randomUUID())).toBeUndefined()
    expect(f.threadMessage.mock.calls.map(([, id]) => id)).toEqual([replyId])
  })

  it('is cut at 32 KiB, as the thread that delegated was given it', async () => {
    const replyId = randomUUID()
    const check = record({ check: true, replyMessageId: replyId })
    const f = await service([check], { [replyId]: `Failed: 37 of 1,214 tests.\n${'é'.repeat(WATCHER_REPLY_BYTES_MAX)}` })
    const reply = f.delegation.checkReply('parent', check.id)!
    expect(reply.truncated).toBe(true)
    expect(new TextEncoder().encode(reply.text).byteLength).toBeLessThanOrEqual(WATCHER_REPLY_BYTES_MAX)
    expect(reply.text.startsWith('Failed: 37 of 1,214 tests.\n')).toBe(true)
  })

  it('answers the main window alone, by the window\'s key for this computer\'s thread, and only where checks are offered', async () => {
    const replyId = randomUUID()
    const check = record({ check: true, replyMessageId: replyId })
    const review = record({ delegatedThreadId: 'review', replyMessageId: replyId })
    const f = await service([check, review], { [replyId]: FAILED })
    const { ipc, handlers, main, mainEvent, widgetEvent } = ipcRegistry()
    const close = registerDelegationIpc(ipc, f.delegation, () => [main], () => LOCAL, vi.fn(), undefined, true)
    const read = handlers.get(DELEGATION_CHECK_REPLY_READ)!
    const parent = hostEntityKey(LOCAL, 'parent')
    expect(await read(mainEvent, { threadId: parent, delegation: check.id })).toEqual({ delegation: check.id, text: FAILED, truncated: false })
    // A delegation that is not a check is refused its reply: the window reads none but a check's.
    expect(await read(mainEvent, { threadId: parent, delegation: review.id })).toBeNull()
    // A thread on a paired host carries no check in its read, so nothing is asked of that host for one.
    expect(await read(mainEvent, { threadId: hostEntityKey(REMOTE, 'parent'), delegation: check.id })).toBeNull()
    expect(() => read(widgetEvent, { threadId: parent, delegation: check.id })).toThrow('main Sotto window')
    expect(() => read(mainEvent, { threadId: parent, delegation: 'not-a-uuid' })).toThrow()
    expect(() => read(mainEvent, { threadId: parent, delegation: check.id, text: true })).toThrow()
    // The window's read carries the row's excerpt, the first line only, through the same channel as before.
    const views = await handlers.get(DELEGATIONS_READ)!(mainEvent, { threadId: parent }) as DelegationsRead
    expect(views.delegations[0]).toMatchObject({ thread: hostEntityKey(LOCAL, 'child'), check: true, checkReply: { excerpt: 'Failed: 2 of 1,214 tests.', truncated: false } })
    close()
    expect(handlers.size).toBe(0)
    // Where checks are not offered, as on stable or with Watcher off, nothing is registered for it.
    const without = registerDelegationIpc(ipc, f.delegation, () => [main], () => LOCAL, vi.fn())
    expect(handlers.has(DELEGATION_CHECK_REPLY_READ)).toBe(false)
    without()
  })
})
