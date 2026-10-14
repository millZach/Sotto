// @vitest-environment node
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { NativeUsage } from '../../../src/main/agents/nativeUsage'
import { scanClaudeHistory } from '../../../src/main/agents/usageHistory/claudeHistory'
import { isUsageHistoryThreadId } from '../../../src/main/agents/usageHistory/sink'
import { usageHistoryPromptSchema, usageTokenObservationSchema, USAGE_HISTORY_BATCH_MAX, type UsageTokenObservation } from '../../../src/shared/usageDashboard'
import { claudeAssistant, claudeToolResult, claudeUser, jsonl, SECRET } from '../../fixtures/usageHistory/lines'
import { memorySink } from '../../fixtures/usageHistory/sink'

const OWNED = '11111111-1111-4111-8111-111111111111'
const ELSEWHERE = '22222222-2222-4222-8222-222222222222'
const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes('sotto-usage-history-claude-')) throw new Error('Unexpected test directory')
    await rm(root, { recursive: true, force: true })
  }
})
async function home(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'sotto-usage-history-claude-')); roots.push(root)
  await mkdir(join(root, 'projects', 'project-a', OWNED, 'subagents'), { recursive: true })
  return root
}
const scan = (root: string, sink: ReturnType<typeof memorySink>, owned = new Map([[OWNED, 'adapter-thread-1']])) =>
  scanClaudeHistory({ home: root, owned }, sink.sink, new AbortController().signal)
const t = (minute: number): string => new Date(Date.UTC(2026, 8, 20, 10, minute)).toISOString()

describe('Claude Code history reader', () => {
  it('keeps one row per message with its largest frame and drops synthetic and empty frames', async () => {
    const root = await home()
    await writeFile(join(root, 'projects', 'project-a', `${ELSEWHERE}.jsonl`), jsonl([
      claudeAssistant({ session: ELSEWHERE, id: 'msg_a', at: t(1), usage: { input: 10, read: 100, write: 20, output: 5 } }),
      claudeAssistant({ session: ELSEWHERE, id: 'msg_a', at: t(2), usage: { input: 10, read: 100, write: 20, output: 40 } }),
      claudeAssistant({ session: ELSEWHERE, id: 'msg_a', at: t(3), usage: { input: 10, read: 100, write: 20, output: 12 } }),
      claudeAssistant({ session: ELSEWHERE, id: 'msg_s', model: '<synthetic>', at: t(4), usage: { input: 0, output: 0 } }),
      claudeAssistant({ session: ELSEWHERE, id: 'msg_z', at: t(5), usage: {} }),
      'not json at all',
    ]))
    const sink = memorySink()
    await scan(root, sink)
    expect(sink.rows().size).toBe(1)
    const [row] = [...sink.rows().values()]
    expect(row).toMatchObject({ providerId: 'claude', modelId: 'claude-opus-5-5', at: t(1), origin: 'history', source: 'elsewhere', client: 'claude-code',
      tokens: { input: 130, cached: 100, cacheWrite: 20, output: 40 } })
    expect(usageTokenObservationSchema.safeParse(row).success).toBe(true)
  })

  it('reports an owned session under the record key the live ledger gives the same message', async () => {
    const root = await home()
    const frame = claudeAssistant({ session: OWNED, id: 'msg_owned', at: t(6), usage: { input: 3, read: 50, write: 7, output: 9, write1h: 7 } })
    await writeFile(join(root, 'projects', 'project-a', `${OWNED}.jsonl`), jsonl([frame]))
    const live: UsageTokenObservation[] = []
    const ledger = new NativeUsage(root, 'claude', true)
    ledger.subscribeUsage(record => live.push(record))
    ledger.claude('adapter-thread-1', JSON.parse(frame))
    const sink = memorySink()
    await scan(root, sink)
    expect(sink.tokens).toHaveLength(1)
    expect(sink.tokens[0]).toMatchObject({ threadId: 'adapter-thread-1', recordKey: live[0]!.recordKey, groupKey: live[0]!.groupKey, at: t(6) })
    expect(sink.tokens[0]!.source).toBeUndefined()
    expect(sink.tokens[0]!.subAgent).toBeUndefined()
    await ledger.flushed()
  })

  it('counts sub-agent transcripts as sub-agent work of their session and never as prompts', async () => {
    const root = await home()
    await writeFile(join(root, 'projects', 'project-a', OWNED, 'subagents', 'agent-1.jsonl'), jsonl([
      claudeUser({ session: OWNED, uuid: 'u-sub', at: t(7), sidechain: true }),
      claudeAssistant({ session: OWNED, id: 'msg_sub', at: t(8), sidechain: true, usage: { input: 4, output: 2 } }),
    ]))
    await writeFile(join(root, 'projects', 'project-a', `${ELSEWHERE}.jsonl`), jsonl([
      claudeAssistant({ session: ELSEWHERE, id: 'msg_side', at: t(9), sidechain: true, usage: { input: 4, output: 2 } }),
    ]))
    const sink = memorySink()
    await scan(root, sink)
    expect(sink.prompts).toEqual([])
    expect(sink.tokens.map(row => [row.threadId === 'adapter-thread-1', row.subAgent])).toEqual(expect.arrayContaining([[true, true], [false, true]]))
  })

  it('counts typed prompts outside Sotto once, under the model that answered them', async () => {
    const root = await home()
    const lines = [
      claudeUser({ session: ELSEWHERE, uuid: 'u-1', at: t(10) }),
      claudeUser({ session: ELSEWHERE, uuid: 'u-meta', at: t(10), meta: true }),
      claudeUser({ session: ELSEWHERE, uuid: 'u-cmd', at: t(10), content: '<command-name>/clear</command-name>' }),
      claudeUser({ session: ELSEWHERE, uuid: 'u-local', at: t(10), content: '<local-command-stdout>done</local-command-stdout>' }),
      claudeToolResult({ session: ELSEWHERE, uuid: 'u-tool', at: t(11) }),
      claudeUser({ session: ELSEWHERE, uuid: 'u-blocks', at: t(12), content: [{ type: 'text', text: SECRET }] }),
      claudeAssistant({ session: ELSEWHERE, id: 'msg_reply', model: 'claude-fable-5-1', at: t(13), usage: { input: 1, output: 1 } }),
    ]
    await writeFile(join(root, 'projects', 'project-a', `${ELSEWHERE}.jsonl`), jsonl(lines))
    // A copy of the same prompt in another file, and a prompt in a session Sotto owns.
    await writeFile(join(root, 'projects', 'project-a', 'copy.jsonl'), jsonl([claudeUser({ session: ELSEWHERE, uuid: 'u-1', at: t(10) })]))
    await writeFile(join(root, 'projects', 'project-a', `${OWNED}.jsonl`), jsonl([claudeUser({ session: OWNED, uuid: 'u-owned', at: t(14) })]))
    const sink = memorySink()
    await scan(root, sink)
    expect(sink.prompts.map(prompt => prompt.messageId).sort()).toEqual(['u-1', 'u-blocks'])
    for (const prompt of sink.prompts) {
      expect(usageHistoryPromptSchema.safeParse(prompt).success).toBe(true)
      expect(prompt).toMatchObject({ providerId: 'claude', modelId: 'claude-fable-5-1', kind: 'user', source: 'elsewhere', client: 'claude-code' })
      expect(isUsageHistoryThreadId(prompt.threadId)).toBe(true)
    }
  })

  it('never passes on words, paths or native session IDs', async () => {
    const root = await home()
    await writeFile(join(root, 'projects', 'project-a', `${ELSEWHERE}.jsonl`), jsonl([
      claudeUser({ session: ELSEWHERE, uuid: 'u-1', at: t(10) }),
      claudeAssistant({ session: ELSEWHERE, id: 'msg_reply', at: t(13), usage: { input: 1, output: 1 } }),
    ]))
    const sink = memorySink()
    await scan(root, sink)
    const everything = JSON.stringify([sink.tokens, sink.prompts, [...sink.cursors]])
    expect(sink.tokens.length + sink.prompts.length).toBe(2)
    for (const forbidden of [SECRET, ELSEWHERE, 'project-a', root]) expect(everything).not.toContain(forbidden)
  })

  it('resumes a growing file from its cursor and leaves an unfinished line for the next pass', async () => {
    const root = await home()
    const file = join(root, 'projects', 'project-a', `${ELSEWHERE}.jsonl`)
    await writeFile(file, jsonl([claudeAssistant({ session: ELSEWHERE, id: 'msg_1', at: t(1), usage: { input: 1, output: 1 } })]))
    const sink = memorySink()
    await scan(root, sink)
    expect(sink.tokens).toHaveLength(1)
    const second = claudeAssistant({ session: ELSEWHERE, id: 'msg_2', at: t(2), usage: { input: 2, output: 2 } })
    await appendFile(file, second.slice(0, 40))
    await scan(root, sink)
    expect(sink.tokens).toHaveLength(1)
    await appendFile(file, `${second.slice(40)}\n`)
    await scan(root, sink)
    expect(sink.tokens.map(row => row.tokens.output)).toEqual([1, 2])
    // Nothing new: nothing read.
    await scan(root, sink)
    expect(sink.tokens).toHaveLength(2)
  })

  it('reads a file that shrank or was replaced again from the start', async () => {
    const root = await home()
    const file = join(root, 'projects', 'project-a', `${ELSEWHERE}.jsonl`)
    await writeFile(file, jsonl([
      claudeAssistant({ session: ELSEWHERE, id: 'msg_1', at: t(1), usage: { input: 1, output: 1 } }),
      claudeAssistant({ session: ELSEWHERE, id: 'msg_2', at: t(2), usage: { input: 2, output: 2 } }),
    ]))
    const sink = memorySink()
    await scan(root, sink)
    await writeFile(file, jsonl([claudeAssistant({ session: ELSEWHERE, id: 'msg_3', at: t(3), usage: { input: 3, output: 3 } })]))
    await scan(root, sink)
    expect(sink.tokens.map(row => row.tokens.output)).toEqual([1, 2, 3])
  })

  it('hands rows over in batches no larger than the store takes', async () => {
    const root = await home()
    const lines = Array.from({ length: USAGE_HISTORY_BATCH_MAX + 10 }, (_, index) =>
      claudeAssistant({ session: ELSEWHERE, id: `msg_${index}`, at: t(index % 60), usage: { input: index + 1, output: 1 } }))
    await writeFile(join(root, 'projects', 'project-a', `${ELSEWHERE}.jsonl`), jsonl(lines))
    const sink = memorySink()
    await scan(root, sink)
    expect(sink.rows().size).toBe(USAGE_HISTORY_BATCH_MAX + 10)
    expect(Math.max(...sink.batches)).toBeLessThanOrEqual(USAGE_HISTORY_BATCH_MAX)
  })
})
