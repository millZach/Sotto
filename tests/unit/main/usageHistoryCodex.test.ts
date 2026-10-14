// @vitest-environment node
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { NativeUsage } from '../../../src/main/agents/nativeUsage'
import { codexClient, scanCodexHistory } from '../../../src/main/agents/usageHistory/codexHistory'
import { usageHistoryMessageId, usageHistoryThreadId } from '../../../src/main/agents/usageHistory/sink'
import { usageHistoryPromptSchema, usageTokenObservationSchema, type UsageTokenObservation } from '../../../src/shared/usageDashboard'
import { codexMeta, codexRecord, codexTaskStarted, codexTokenCount, codexTurnContext, codexUserMessage, jsonl, SECRET } from '../../fixtures/usageHistory/lines'
import { memorySink } from '../../fixtures/usageHistory/sink'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes('sotto-usage-history-codex-')) throw new Error('Unexpected test directory')
    await rm(root, { recursive: true, force: true })
  }
})
async function home(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'sotto-usage-history-codex-')); roots.push(root)
  await mkdir(join(root, 'sessions', '2026', '09', '20'), { recursive: true })
  await mkdir(join(root, 'archived_sessions'), { recursive: true })
  return root
}
const rollout = (root: string, name: string): string => join(root, 'sessions', '2026', '09', '20', `rollout-${name}.jsonl`)
const scan = (root: string, sink: ReturnType<typeof memorySink>, owned = new Map<string, string>()) =>
  scanCodexHistory({ home: root, owned }, sink.sink, new AbortController().signal)
const t = (minute: number): string => new Date(Date.UTC(2026, 8, 20, 10, minute)).toISOString()
/** A prompt's identity: a hash of its turn, never the turn's own ID. */
const turn = (id: string): string => usageHistoryMessageId('codex', id)

describe('Codex history reader', () => {
  it('names each client from the session originator', () => {
    expect(['sotto', 'codex_exec', 'Codex Desktop', 'codex-tui', 'codex_cli_rs', 'codex_vscode', 't3code_desktop', 'Claude Code', 'something-new', undefined].map(codexClient))
      .toEqual(['sotto', 'codex-exec', 'codex-app', 'codex-cli', 'codex-cli', 'codex-ide', 't3-code', 'codex-in-claude-code', 'other', 'other'])
  })

  it('reads old token_count rollouts, counting each running total once and each turn as a prompt', async () => {
    const root = await home()
    await writeFile(rollout(root, '2026-09-20T10-00-00-exec'), jsonl([
      codexMeta({ id: 'session-exec', originator: 'codex_exec', at: t(0) }),
      codexTaskStarted({ turn: 'turn-1', at: t(1) }),
      codexTurnContext({ turn: 'turn-1', model: 'gpt-6-astra', at: t(1) }),
      codexUserMessage({ at: t(1) }),
      codexTokenCount({ at: t(2), total: { input: 100, cached: 40, output: 10 }, last: { input: 100, cached: 40, output: 10 } }),
      // Codex repeats the last count at the turn's end.
      codexTokenCount({ at: t(3), total: { input: 100, cached: 40, output: 10 }, last: { input: 100, cached: 40, output: 10 } }),
      codexTokenCount({ at: t(4), total: { input: 250, cached: 140, output: 30 }, last: { input: 150, cached: 100, output: 20 } }),
      codexTaskStarted({ turn: 'turn-2', at: t(5) }),
      codexTokenCount({ at: t(6), total: { input: 300, cached: 140, output: 31 }, last: { input: 50, cached: 0, output: 1 } }),
    ]))
    const sink = memorySink()
    await scan(root, sink)
    const thread = usageHistoryThreadId('codex', 'session-exec')
    expect(sink.rows().size).toBe(3)
    expect(sink.sum('input')).toBe(300)
    expect(sink.sum('output')).toBe(31)
    for (const row of sink.tokens) {
      expect(usageTokenObservationSchema.safeParse(row).success).toBe(true)
      expect(row).toMatchObject({ providerId: 'codex', threadId: thread, modelId: 'gpt-6-astra', source: 'outside', client: 'codex-exec', origin: 'history' })
    }
    expect(sink.prompts.map(prompt => [prompt.messageId, prompt.at, prompt.client, prompt.threadId])).toEqual([
      [turn('turn-1'), t(1), 'codex-exec', thread], [turn('turn-2'), t(5), 'codex-exec', thread]])
    for (const prompt of sink.prompts) expect(usageHistoryPromptSchema.safeParse(prompt).success).toBe(true)
  })

  it('reads per-request records and not the token_count events beside them', async () => {
    const root = await home()
    await writeFile(rollout(root, '2026-09-20T10-00-00-app'), jsonl([
      codexMeta({ id: 'session-app', originator: 'Codex Desktop', at: t(0) }),
      codexTaskStarted({ turn: 'turn-a', at: t(1) }),
      codexTurnContext({ turn: 'turn-a', model: 'gpt-6.1-sol', at: t(1) }),
      // Codex writes a request's record first and its token_count just after.
      codexRecord({ at: t(2), thread: 'session-app', turn: 'turn-a', response: 'resp-1', total: { input: 100, output: 10 }, last: { input: 100, output: 10 } }),
      codexTokenCount({ at: t(2), total: { input: 100, output: 10 }, last: { input: 100, output: 10 } }),
      codexRecord({ at: t(3), thread: 'session-app', turn: 'turn-a', response: 'resp-1', total: { input: 100, output: 10 }, last: { input: 100, output: 10 } }),
      codexRecord({ at: t(4), thread: 'session-app', turn: 'turn-a', response: 'resp-2', total: { input: 180, output: 25 }, last: { input: 80, output: 15 } }),
      codexTokenCount({ at: t(4), total: { input: 180, output: 25 }, last: { input: 80, output: 15 } }),
      // The turn's closing repeat of the last count.
      codexTokenCount({ at: t(5), total: { input: 180, output: 25 }, last: { input: 80, output: 15 } }),
    ]))
    const sink = memorySink()
    await scan(root, sink)
    expect(sink.rows().size).toBe(2)
    expect(sink.sum('input')).toBe(180)
    expect(sink.tokens.every(row => row.client === 'codex-app' && row.modelId === 'gpt-6.1-sol')).toBe(true)
    expect(sink.prompts.map(prompt => prompt.messageId)).toEqual([turn('turn-a')])
  })

  it('skips the parent history a forked sub-agent rollout begins with', async () => {
    const root = await home()
    const parentLines = [
      codexMeta({ id: 'parent', originator: 'codex-tui', at: t(0) }),
      codexTaskStarted({ turn: 'p-turn', at: t(1) }),
      codexTurnContext({ turn: 'p-turn', model: 'gpt-6-astra', at: t(1) }),
      codexRecord({ at: t(2), thread: 'parent', turn: 'p-turn', response: 'p-resp-1', total: { input: 100, output: 10 }, last: { input: 100, output: 10 } }),
      codexRecord({ at: t(3), thread: 'parent', turn: 'p-turn', response: 'p-resp-2', total: { input: 300, output: 30 }, last: { input: 200, output: 20 } }),
    ]
    await writeFile(rollout(root, '2026-09-20T10-00-00-parent'), jsonl(parentLines))
    await writeFile(rollout(root, '2026-09-20T10-05-00-child'), jsonl([
      codexMeta({ id: 'child', originator: 'codex-tui', at: t(5), forkedFrom: 'parent', parent: 'parent', threadSource: 'subagent', source: { subagent: { thread_spawn: {} } } }),
      ...parentLines,
      codexTaskStarted({ turn: 'c-turn', at: t(6) }),
      codexTurnContext({ turn: 'c-turn', model: 'gpt-6.1-sol', at: t(6) }),
      codexRecord({ at: t(7), thread: 'child', turn: 'c-turn', response: 'c-resp-1', total: { input: 40, output: 4 }, last: { input: 40, output: 4 } }),
    ]))
    const sink = memorySink()
    await scan(root, sink)
    expect(sink.sum('input')).toBe(340)
    const child = [...sink.rows().values()].filter(row => row.subAgent)
    expect(child.map(row => [row.threadId, row.modelId, row.tokens.input])).toEqual([[usageHistoryThreadId('codex', 'child'), 'gpt-6.1-sol', 40]])
    expect(sink.prompts.map(prompt => prompt.messageId)).toEqual([turn('p-turn')])
  })

  it('counts the copied history of an old subagent rollout once when it does not carry its parent header', async () => {
    // Older Codex subagent rollouts name their parent and begin with its token_count history, with no copy of its session_meta.
    const parentLines = [
      codexMeta({ id: 'old-parent', originator: 'Codex Desktop', at: t(0) }),
      codexTaskStarted({ turn: 'op-turn', at: t(1) }),
      codexTokenCount({ at: t(2), total: { input: 100, output: 10 }, last: { input: 100, output: 10 } }),
      codexTokenCount({ at: t(3), total: { input: 300, output: 30 }, last: { input: 200, output: 20 } }),
    ]
    const childLines = [
      codexMeta({ id: 'old-child', originator: 'Codex Desktop', at: t(5), parent: 'old-parent', threadSource: 'subagent' }),
      ...parentLines.slice(1),
      codexTaskStarted({ turn: 'oc-turn', at: t(6) }),
      codexTokenCount({ at: t(7), total: { input: 340, output: 34 }, last: { input: 40, output: 4 } }),
    ]
    const together = await home()
    await writeFile(rollout(together, '2026-09-20T10-00-00-old-parent'), jsonl(parentLines))
    await writeFile(rollout(together, '2026-09-20T10-05-00-old-child'), jsonl(childLines))
    const one = memorySink()
    await scan(together, one)
    // The parent alone in a first pass, its subagent in the next.
    const apart = await home()
    await writeFile(rollout(apart, '2026-09-20T10-00-00-old-parent'), jsonl(parentLines))
    const two = memorySink()
    await scan(apart, two)
    await writeFile(rollout(apart, '2026-09-20T10-05-00-old-child'), jsonl(childLines))
    await scan(apart, two)
    for (const sink of [one, two]) {
      expect(sink.sum('input')).toBe(340)
      expect([...sink.rows().values()].filter(row => row.subAgent).map(row => row.tokens.input)).toEqual([40])
    }
  })
  it('attributes a fork read in a later pass to its parent, so the store counts the copy once', async () => {
    const root = await home()
    const parentLines = [
      codexMeta({ id: 'parent', originator: 'codex-tui', at: t(0) }),
      codexTaskStarted({ turn: 'p-turn', at: t(1) }),
      codexTurnContext({ turn: 'p-turn', model: 'gpt-6-astra', at: t(1) }),
      codexRecord({ at: t(2), thread: 'parent', turn: 'p-turn', response: 'p-resp-1', total: { input: 100, output: 10 }, last: { input: 100, output: 10 } }),
    ]
    await writeFile(rollout(root, '2026-09-20T10-00-00-parent'), jsonl(parentLines))
    const sink = memorySink()
    await scan(root, sink)
    // The user forks the session in the Codex app: a new rollout that copies the parent and goes on.
    await writeFile(rollout(root, '2026-09-20T11-00-00-fork'), jsonl([
      codexMeta({ id: 'fork', originator: 'Codex Desktop', at: t(10), forkedFrom: 'parent' }),
      ...parentLines,
      codexTaskStarted({ turn: 'f-turn', at: t(11) }),
      codexRecord({ at: t(12), thread: 'fork', turn: 'f-turn', response: 'f-resp-1', total: { input: 150, output: 12 }, last: { input: 50, output: 2 } }),
    ]))
    await scan(root, sink)
    expect(sink.sum('input')).toBe(150)
    expect(sink.uniquePrompts().size).toBe(2)
    expect([...sink.uniquePrompts().values()].find(prompt => prompt.messageId === turn('f-turn'))?.client).toBe('codex-app')
  })

  it('uses the copied-history ordinal for an old rollout forked after its parent was read', async () => {
    const root = await home()
    const parentLines = [
      codexMeta({ id: 'old-parent', originator: 'codex-tui', at: t(0) }),
      codexTaskStarted({ turn: 'p-turn', at: t(1) }),
      codexTokenCount({ at: t(2), total: { input: 100, output: 10 }, last: { input: 100, output: 10 } }),
    ]
    await writeFile(rollout(root, '2026-09-20T10-00-00-old-parent'), jsonl(parentLines))
    const sink = memorySink()
    await scan(root, sink)
    await writeFile(rollout(root, '2026-09-20T11-00-00-old-child'), jsonl([
      codexMeta({ id: 'old-child', originator: 'codex-tui', at: t(10), forkedFrom: 'old-parent', parent: 'old-parent', threadSource: 'subagent', ordinal: parentLines.length }),
      ...parentLines,
      codexTaskStarted({ turn: 'c-turn', at: t(11) }),
      codexTokenCount({ at: t(12), total: { input: 30, output: 3 }, last: { input: 30, output: 3 } }),
    ]))
    await scan(root, sink)
    expect(sink.sum('input')).toBe(130)
    expect([...sink.rows().values()].map(row => [row.threadId === usageHistoryThreadId('codex', 'old-child'), row.subAgent ?? false]))
      .toEqual([[false, false], [true, true]])
    expect(sink.uniquePrompts().size).toBe(1)
  })

  it('reports a Sotto thread under the live ledger key and its sub-agents as that thread\'s work', async () => {
    const root = await home()
    await writeFile(rollout(root, '2026-09-20T10-00-00-owned'), jsonl([
      codexMeta({ id: 'native-owned', originator: 'sotto', at: t(0) }),
      codexTaskStarted({ turn: 'o-turn', at: t(1) }),
      codexTurnContext({ turn: 'o-turn', model: 'gpt-6-astra', at: t(1) }),
      codexTokenCount({ at: t(2), total: { input: 100, cached: 60, output: 10 }, last: { input: 100, cached: 60, output: 10 } }),
    ]))
    await writeFile(rollout(root, '2026-09-20T10-01-00-owned-child'), jsonl([
      codexMeta({ id: 'native-child', originator: 'sotto', at: t(1), parent: 'native-owned', threadSource: 'subagent' }),
      codexTaskStarted({ turn: 'k-turn', at: t(3) }),
      codexTokenCount({ at: t(4), total: { input: 7, output: 1 }, last: { input: 7, output: 1 } }),
    ]))
    await writeFile(rollout(root, '2026-09-20T10-02-00-side-call'), jsonl([
      codexMeta({ id: 'native-side', originator: 'sotto', at: t(1) }),
      codexTaskStarted({ turn: 's-turn', at: t(3) }),
      codexTokenCount({ at: t(4), total: { input: 5, output: 1 }, last: { input: 5, output: 1 } }),
    ]))
    const live: UsageTokenObservation[] = []
    const ledger = new NativeUsage(root, 'codex', true)
    ledger.subscribeUsage(record => live.push(record))
    ledger.codex('adapter-thread-9', 'gpt-6-astra', { turnId: 'o-turn', tokenUsage: {
      total: { inputTokens: 100, cachedInputTokens: 60, outputTokens: 10, reasoningOutputTokens: 0, totalTokens: 110 },
      last: { inputTokens: 100, cachedInputTokens: 60, outputTokens: 10, reasoningOutputTokens: 0, totalTokens: 110 } } })
    const sink = memorySink()
    await scan(root, sink, new Map([['native-owned', 'adapter-thread-9']]))
    const owned = sink.tokens.find(row => row.threadId === 'adapter-thread-9' && !row.subAgent)
    expect(owned).toMatchObject({ recordKey: live[0]!.recordKey, groupKey: live[0]!.groupKey, at: t(2), tokens: { input: 100, cached: 60, output: 10 } })
    expect(owned?.source).toBeUndefined()
    expect(sink.tokens.find(row => row.threadId === 'adapter-thread-9' && row.subAgent)?.tokens.input).toBe(7)
    const side = sink.tokens.find(row => row.threadId === usageHistoryThreadId('codex', 'native-side'))
    expect(side).toMatchObject({ source: 'sotto' })
    expect(side?.client).toBeUndefined()
    expect(usageTokenObservationSchema.safeParse(side).success).toBe(true)
    // Sotto's own prompts come from its thread store; sub-agent turns are never prompts.
    expect(sink.prompts).toEqual([])
    await ledger.flushed()
  })

  it('keys a Sotto thread from its token_count running totals when its rollout also has per-request records', async () => {
    // On Zach's laptop thread_token_usage matched only 3,602 of 16,621 live ledger keys; token_count totals matched 16,620.
    const root = await home()
    await writeFile(rollout(root, '2026-09-20T10-00-00-owned-records'), jsonl([
      codexMeta({ id: 'native-owned', originator: 'sotto', at: t(0) }),
      codexTaskStarted({ turn: 'o-turn', at: t(1) }),
      codexTurnContext({ turn: 'o-turn', model: 'gpt-6-astra', at: t(1) }),
      codexRecord({ at: t(2), thread: 'native-owned', turn: 'o-turn', response: 'resp-1', total: { input: 90, cached: 50, output: 9 }, last: { input: 100, cached: 60, output: 10 } }),
      codexTokenCount({ at: t(2), total: { input: 100, cached: 60, output: 10 }, last: { input: 100, cached: 60, output: 10 } }),
    ]))
    await writeFile(rollout(root, '2026-09-20T10-01-00-outside-records'), jsonl([
      codexMeta({ id: 'native-app', originator: 'Codex Desktop', at: t(0) }),
      codexTaskStarted({ turn: 'a-turn', at: t(1) }),
      codexRecord({ at: t(2), thread: 'native-app', turn: 'a-turn', response: 'resp-2', total: { input: 40, output: 4 }, last: { input: 40, output: 4 } }),
      codexTokenCount({ at: t(2), total: { input: 40, output: 4 }, last: { input: 40, output: 4 } }),
    ]))
    const live: UsageTokenObservation[] = []
    const ledger = new NativeUsage(root, 'codex', true)
    ledger.subscribeUsage(record => live.push(record))
    ledger.codex('adapter-thread-9', 'gpt-6-astra', { turnId: 'o-turn', tokenUsage: {
      total: { inputTokens: 100, cachedInputTokens: 60, outputTokens: 10, reasoningOutputTokens: 0, totalTokens: 110 },
      last: { inputTokens: 100, cachedInputTokens: 60, outputTokens: 10, reasoningOutputTokens: 0, totalTokens: 110 } } })
    const sink = memorySink()
    await scan(root, sink, new Map([['native-owned', 'adapter-thread-9']]))
    const owned = sink.tokens.filter(row => row.threadId === 'adapter-thread-9')
    expect(owned).toHaveLength(1)
    expect(owned[0]).toMatchObject({ recordKey: live[0]!.recordKey, at: t(2), tokens: { input: 100, cached: 60, output: 10 } })
    // Work outside Sotto still comes from its records, once.
    expect(sink.tokens.filter(row => row.threadId === usageHistoryThreadId('codex', 'native-app'))).toHaveLength(1)
    await ledger.flushed()
  })

  it('counts two unrelated sessions whose first requests have the same figures, in records and in token_count rollouts', async () => {
    const root = await home()
    const first = { input: 120, cached: 20, output: 12 }
    for (const [name, at] of [['rec-a', 0], ['rec-b', 1]] as const) {
      await writeFile(rollout(root, `2026-09-20T10-0${at}-00-${name}`), jsonl([
        codexMeta({ id: name, originator: 'Codex Desktop', at: t(at) }),
        codexTaskStarted({ turn: `${name}-turn`, at: t(at) }),
        codexRecord({ at: t(at + 1), thread: name, turn: `${name}-turn`, response: `${name}-resp`, total: first, last: first }),
        codexTokenCount({ at: t(at + 1), total: first, last: first }),
      ]))
    }
    for (const [name, at] of [['old-a', 2], ['old-b', 3]] as const) {
      await writeFile(rollout(root, `2026-09-20T10-0${at}-00-${name}`), jsonl([
        codexMeta({ id: name, originator: 'codex-tui', at: t(at) }),
        codexTaskStarted({ turn: `${name}-turn`, at: t(at) }),
        codexTokenCount({ at: t(at + 1), total: first, last: first }),
      ]))
    }
    const sink = memorySink()
    await scan(root, sink)
    expect(sink.rows().size).toBe(4)
    expect(sink.sum('input')).toBe(480)
    expect(new Set([...sink.rows().values()].map(row => row.threadId))).toEqual(new Set(['rec-a', 'rec-b', 'old-a', 'old-b'].map(id => usageHistoryThreadId('codex', id))))
  })

  it('counts an old fork\'s copied history once when its parent was read in an earlier pass', async () => {
    const root = await home()
    const parentLines = [
      codexMeta({ id: 'fork-parent', originator: 'codex-tui', at: t(0) }),
      codexTaskStarted({ turn: 'p-turn', at: t(1) }),
      codexTurnContext({ turn: 'p-turn', model: 'gpt-6-astra', at: t(1) }),
      codexTokenCount({ at: t(2), total: { input: 100, output: 10 }, last: { input: 100, output: 10 } }),
      codexTokenCount({ at: t(3), total: { input: 250, output: 30 }, last: { input: 150, output: 20 } }),
    ]
    await writeFile(rollout(root, '2026-09-20T10-00-00-fork-parent'), jsonl(parentLines))
    const sink = memorySink()
    await scan(root, sink)
    expect(sink.sum('input')).toBe(250)
    // No copied-history ordinal: the fork's own work begins where its running totals leave the parent's.
    await writeFile(rollout(root, '2026-09-20T11-00-00-fork-child'), jsonl([
      codexMeta({ id: 'fork-child', originator: 'Codex Desktop', at: t(10), forkedFrom: 'fork-parent' }),
      ...parentLines,
      codexTaskStarted({ turn: 'f-turn', at: t(11) }),
      codexTurnContext({ turn: 'f-turn', model: 'gpt-6.1-sol', at: t(11) }),
      codexTokenCount({ at: t(12), total: { input: 300, output: 35 }, last: { input: 50, output: 5 } }),
    ]))
    await scan(root, sink)
    expect(sink.sum('input')).toBe(300)
    const fork = [...sink.rows().values()].filter(row => row.threadId === usageHistoryThreadId('codex', 'fork-child'))
    expect(fork.map(row => [row.tokens.input, row.modelId, row.client])).toEqual([[50, 'gpt-6.1-sol', 'codex-app']])
    expect([...sink.uniquePrompts().values()].map(prompt => [prompt.messageId, prompt.threadId])).toEqual([
      [turn('p-turn'), usageHistoryThreadId('codex', 'fork-parent')], [turn('f-turn'), usageHistoryThreadId('codex', 'fork-child')]])
  })

  it('keeps a session\'s token_count history from before Codex wrote records, in one pass or two', async () => {
    const before = [
      codexMeta({ id: 'upgraded', originator: 'codex-tui', at: t(0) }),
      codexTaskStarted({ turn: 'turn-1', at: t(1) }),
      codexTurnContext({ turn: 'turn-1', model: 'gpt-6-astra', at: t(1) }),
      codexTokenCount({ at: t(2), total: { input: 100, output: 10 }, last: { input: 100, output: 10 } }),
      codexTokenCount({ at: t(3), total: { input: 250, output: 30 }, last: { input: 150, output: 20 } }),
    ]
    const after = [
      // Codex was upgraded mid-session: each request now has a record and, just after it, a matching token_count.
      codexTaskStarted({ turn: 'turn-2', at: t(10) }),
      codexRecord({ at: t(11), thread: 'upgraded', turn: 'turn-2', response: 'up-resp-1', total: { input: 310, output: 36 }, last: { input: 60, output: 6 } }),
      codexTokenCount({ at: t(11), total: { input: 310, output: 36 }, last: { input: 60, output: 6 } }),
      codexRecord({ at: t(12), thread: 'upgraded', turn: 'turn-2', response: 'up-resp-2', total: { input: 350, output: 40 }, last: { input: 40, output: 4 } }),
      codexTokenCount({ at: t(12), total: { input: 350, output: 40 }, last: { input: 40, output: 4 } }),
    ]
    const once = await home()
    await writeFile(rollout(once, '2026-09-20T10-00-00-upgraded'), jsonl([...before, ...after]))
    const whole = memorySink()
    await scan(once, whole)

    const twice = await home()
    const file = rollout(twice, '2026-09-20T10-00-00-upgraded')
    await writeFile(file, jsonl([...before, after[0]!, after[1]!]))
    const split = memorySink()
    await scan(twice, split)
    // The record's own token_count arrives in the next pass.
    await appendFile(file, jsonl(after.slice(2)))
    await scan(twice, split)

    for (const sink of [whole, split]) {
      expect(sink.rows().size).toBe(4)
      expect(sink.sum('input')).toBe(350)
      expect(sink.sum('output')).toBe(40)
      expect(sink.uniquePrompts().size).toBe(2)
    }
    expect([...split.rows().keys()].sort()).toEqual([...whole.rows().keys()].sort())
  })

  it('counts a repeated running total once when the repeat arrives in a later pass', async () => {
    // Codex repeats its last token_count at a turn's edge; the repeat can land after the next turn has begun.
    const first = [
      codexMeta({ id: 'repeating', originator: 'Codex Desktop', at: t(0) }),
      codexTaskStarted({ turn: 'turn-1', at: t(1) }),
      codexRecord({ at: t(2), thread: 'repeating', turn: 'turn-1', response: 'rep-resp-1', total: { input: 100, output: 10 }, last: { input: 100, output: 10 } }),
      codexTokenCount({ at: t(2), total: { input: 100, output: 10 }, last: { input: 100, output: 10 } }),
      codexTaskStarted({ turn: 'turn-2', at: t(5) }),
    ]
    const repeat = codexTokenCount({ at: t(6), total: { input: 100, output: 10 }, last: { input: 100, output: 10 } })
    const once = await home()
    await writeFile(rollout(once, '2026-09-20T10-00-00-repeating'), jsonl([...first, repeat]))
    const whole = memorySink()
    await scan(once, whole)
    const twice = await home()
    const file = rollout(twice, '2026-09-20T10-00-00-repeating')
    await writeFile(file, jsonl(first))
    const split = memorySink()
    await scan(twice, split)
    await appendFile(file, jsonl([repeat]))
    await scan(twice, split)
    for (const sink of [whole, split]) {
      expect(sink.rows().size).toBe(1)
      expect(sink.sum('input')).toBe(100)
    }
  })
  it('resumes a rollout across passes with its session and turn intact', async () => {
    const root = await home()
    const file = rollout(root, '2026-09-20T10-00-00-cli')
    await writeFile(file, jsonl([
      codexMeta({ id: 'session-cli', originator: 'codex-tui', at: t(0) }),
      codexTaskStarted({ turn: 'turn-1', at: t(1) }),
      codexTurnContext({ turn: 'turn-1', model: 'gpt-6-astra', at: t(1) }),
      codexTokenCount({ at: t(2), total: { input: 10, output: 1 }, last: { input: 10, output: 1 } }),
    ]))
    const sink = memorySink()
    await scan(root, sink)
    await appendFile(file, jsonl([codexTokenCount({ at: t(3), total: { input: 30, output: 3 }, last: { input: 20, output: 2 } })]))
    await scan(root, sink)
    // The second pass reads the open turn again from its first line; a row read twice is the same row.
    expect([...sink.rows().values()].map(row => [row.threadId, row.modelId, row.client, row.tokens.input])).toEqual([
      [usageHistoryThreadId('codex', 'session-cli'), 'gpt-6-astra', 'codex-cli', 10],
      [usageHistoryThreadId('codex', 'session-cli'), 'gpt-6-astra', 'codex-cli', 20]])
    expect(sink.uniquePrompts().size).toBe(1)
    // Nothing new: nothing read.
    const before = sink.tokens.length
    await scan(root, sink)
    expect(sink.tokens).toHaveLength(before)
  })

  it('keeps no turn ID in a prompt or a cursor, and a Sotto thread resumed mid-turn keeps the live ledger keys', async () => {
    const root = await home()
    const ownedTurn = '019a0000-7f3a-7000-8000-00000000c0de'
    const outsideTurn = '019a0000-7f3a-7000-8000-00000000beef'
    const owned = rollout(root, '2026-09-20T10-00-00-owned-resume')
    const outside = rollout(root, '2026-09-20T10-01-00-outside-resume')
    await writeFile(owned, jsonl([
      codexMeta({ id: 'native-owned', originator: 'sotto', at: t(0) }),
      codexTaskStarted({ turn: ownedTurn, at: t(1) }),
      codexTurnContext({ turn: ownedTurn, model: 'gpt-6-astra', at: t(1) }),
      codexTokenCount({ at: t(2), total: { input: 100, output: 10 }, last: { input: 100, output: 10 } }),
    ]))
    await writeFile(outside, jsonl([
      codexMeta({ id: 'native-cli', originator: 'codex-tui', at: t(0) }),
      codexTaskStarted({ turn: outsideTurn, at: t(1) }),
      codexTurnContext({ turn: outsideTurn, model: 'gpt-6-astra', at: t(1) }),
      codexTokenCount({ at: t(2), total: { input: 10, output: 1 }, last: { input: 10, output: 1 } }),
    ]))
    const sink = memorySink()
    const threads = new Map([['native-owned', 'adapter-thread-9']])
    await scan(root, sink, threads)
    const leaks = (): string => JSON.stringify([sink.prompts, [...sink.cursors]])
    expect(sink.prompts).toHaveLength(1)
    for (const forbidden of [ownedTurn, outsideTurn, 'native-owned', 'native-cli']) expect(leaks()).not.toContain(forbidden)
    // Both files stop inside a turn, so the next pass learns each turn again from its opening line.
    await appendFile(owned, jsonl([codexTokenCount({ at: t(3), total: { input: 250, output: 30 }, last: { input: 150, output: 20 } })]))
    await appendFile(outside, jsonl([codexTokenCount({ at: t(3), total: { input: 30, output: 3 }, last: { input: 20, output: 2 } })]))
    await scan(root, sink, threads)
    for (const forbidden of [ownedTurn, outsideTurn, 'native-owned', 'native-cli']) expect(leaks()).not.toContain(forbidden)
    expect(sink.uniquePrompts().size).toBe(1)
    const live: UsageTokenObservation[] = []
    const ledger = new NativeUsage(root, 'codex', true)
    ledger.subscribeUsage(record => live.push(record))
    ledger.codex('adapter-thread-9', 'gpt-6-astra', { turnId: ownedTurn, tokenUsage: {
      total: { inputTokens: 100, cachedInputTokens: 0, outputTokens: 10, reasoningOutputTokens: 0, totalTokens: 110 },
      last: { inputTokens: 100, cachedInputTokens: 0, outputTokens: 10, reasoningOutputTokens: 0, totalTokens: 110 } } })
    ledger.codex('adapter-thread-9', 'gpt-6-astra', { turnId: ownedTurn, tokenUsage: {
      total: { inputTokens: 250, cachedInputTokens: 0, outputTokens: 30, reasoningOutputTokens: 0, totalTokens: 280 },
      last: { inputTokens: 150, cachedInputTokens: 0, outputTokens: 20, reasoningOutputTokens: 0, totalTokens: 170 } } })
    const ownedRows = [...sink.rows().values()].filter(row => row.threadId === 'adapter-thread-9')
    expect(ownedRows.map(row => [row.recordKey, row.groupKey, row.tokens.input])).toEqual(live.map(row => [row.recordKey, row.groupKey, row.tokens.input]))
    expect(ownedRows).toHaveLength(2)
    expect([...sink.rows().values()].filter(row => row.threadId === usageHistoryThreadId('codex', 'native-cli')).map(row => row.tokens.input)).toEqual([10, 20])
    await ledger.flushed()
  })

  it('reads a rollout again from its start when its cursor was saved by the reader that kept the turn ID', async () => {
    const root = await home()
    const file = rollout(root, '2026-09-20T10-00-00-old-cursor')
    await writeFile(file, jsonl([
      codexMeta({ id: 'session-old', originator: 'codex-tui', at: t(0) }),
      codexTaskStarted({ turn: 'turn-old', at: t(1) }),
      codexTokenCount({ at: t(2), total: { input: 10, output: 1 }, last: { input: 10, output: 1 } }),
    ]))
    const sink = memorySink()
    await scan(root, sink)
    const [key, cursor] = [...sink.cursors][0]!
    const saved = JSON.parse(cursor.state!) as Record<string, unknown>
    sink.cursors.set(key, { ...cursor, mtimeMs: cursor.mtimeMs - 1, state: JSON.stringify({ ...saved, v: 1, turn: 'turn-old' }) })
    await scan(root, sink)
    expect(sink.cursors.get(key)?.state).not.toContain('turn-old')
    expect(sink.rows().size).toBe(1)
  })

  it('reads archived rollouts too and never passes on words or native IDs', async () => {
    const root = await home()
    await writeFile(join(root, 'archived_sessions', 'rollout-2026-09-01T10-00-00-old.jsonl'), jsonl([
      codexMeta({ id: 'session-archived', originator: 'codex_vscode', at: t(0) }),
      codexTaskStarted({ turn: 'turn-1', at: t(1) }),
      codexUserMessage({ at: t(1) }),
      codexTokenCount({ at: t(2), total: { input: 10, output: 1 }, last: { input: 10, output: 1 } }),
    ]))
    const sink = memorySink()
    await scan(root, sink)
    expect(sink.tokens).toHaveLength(1)
    expect(sink.tokens[0]).toMatchObject({ client: 'codex-ide', modelId: 'unknown' })
    const everything = JSON.stringify([sink.tokens, sink.prompts, [...sink.cursors]])
    for (const forbidden of [SECRET, 'session-archived', 'archived_sessions', root]) expect(everything).not.toContain(forbidden)
  })
})
