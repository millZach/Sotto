// @vitest-environment node
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ClaudeSubscriptionClient } from '../../src/main/agents/subscriptionClaude'
import { ROUTER_INSTRUCTION } from '../../src/main/agents/modelRouterInstruction'
import { parseRouterAnswer, routerMaterial, ROUTER_CLASSIFIER } from '../../src/shared/modelRouter'

/**
 * Model routing's classifier against the benchmark its instruction was measured on (docs/plans/model-router.md), on the
 * real Claude Code and the user's own subscription. Never in CI: set SOTTO_ROUTER_LIVE=1 and point SOTTO_ROUTER_BENCHMARK
 * at the benchmark folder (it holds `router_instruction.md`, `dataset.json` and `score.py`). It writes
 * `runs/sotto-opus-low.json` there, in the shape `score.py` reads, so the Python runs and this one are scored alike.
 */
const live = process.env.SOTTO_ROUTER_LIVE === '1' && Boolean(process.env.SOTTO_ROUTER_BENCHMARK)
interface Item { readonly id: string; readonly text: string; readonly current?: { readonly model: string; readonly effort: string }; readonly previous_user?: string; readonly last_reply_tail?: string }

describe.skipIf(!live)('model routing on the real Claude Code', () => {
  const folder = process.env.SOTTO_ROUTER_BENCHMARK!

  it('carries the instruction the benchmark ran, byte for byte', async () => {
    expect(ROUTER_INSTRUCTION).toBe(await readFile(join(folder, 'router_instruction.md'), 'utf8'))
  })

  it('classifies every benchmark prompt through Sotto\'s own material, side call and parser', async () => {
    const items = JSON.parse(await readFile(join(folder, 'dataset.json'), 'utf8')) as Item[]
    const workingDirectory = await mkdtemp(join(tmpdir(), 'sotto-router-live-'))
    const client = new ClaudeSubscriptionClient(workingDirectory)
    const executable = await client.findExecutable()
    expect(executable).not.toBeNull()
    const rows: Record<string, unknown>[] = []
    const queue = [...items]
    const work = async (): Promise<void> => {
      for (let item = queue.shift(); item; item = queue.shift()) {
        const started = Date.now()
        const material = routerMaterial(item.text, item.current
          ? { model: item.current.model, effort: item.current.effort, previousUser: item.previous_user ?? '', lastReply: item.last_reply_tail ?? '' } : undefined)
        const reply = await client.write({ instruction: ROUTER_INSTRUCTION, material, model: ROUTER_CLASSIFIER.tier, effort: ROUTER_CLASSIFIER.effort,
          workingDirectory, executable: executable!, timeoutMs: 180_000 }).catch(() => null)
        const answer = parseRouterAnswer(reply)
        rows.push({ id: item.id, wall_s: (Date.now() - started) / 1000, ...answer ? { model: answer.tier, effort: answer.effort, reason: answer.reason, strict: reply?.trim().startsWith('{') === true && !reply.trim().includes('\n') } : reply === null ? { failed: 'write' } : { parse_error: true } })
      }
    }
    await Promise.all(Array.from({ length: 8 }, work))
    await writeFile(join(folder, 'runs', 'sotto-opus-low.json'), JSON.stringify(rows, null, 1))
    expect(rows).toHaveLength(items.length)
  }, 1_800_000)
})
