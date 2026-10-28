import { readFileSync } from 'node:fs'
import { relative } from 'node:path'
import { BaseSequencer, type TestSpecification } from 'vitest/node'

// Each file's summed test time on a Windows shard, in ms (scripts/test-durations.mjs writes it).
const durations: Record<string, number> = JSON.parse(readFileSync(new URL('./fixtures/testDurations.json', import.meta.url), 'utf8'))
const known = Object.values(durations).sort((a, b) => a - b)
// A file not in the map yet counts as a typical one.
const typical = known[Math.floor(known.length / 2)] ?? 0
// Transform, setup, import and environment cost about 1.1 s a file on a Windows shard, apart from its tests.
const FILE_OVERHEAD_MS = 1_100

/**
 * Vitest's own --shard splits files evenly by count, by a hash of their path, which left one Windows shard
 * three minutes longer than the mean. This deals the longest files first, each to the shard with the least
 * time so far, so every runner computes the same split.
 */
export class DurationShardSequencer extends BaseSequencer {
  override async shard(files: TestSpecification[]): Promise<TestSpecification[]> {
    const { index, count } = this.ctx.config.shard!
    const weighed = files
      .map(spec => {
        const path = relative(this.ctx.config.root, spec.moduleId).replaceAll('\\', '/')
        return { spec, path, ms: (durations[path] ?? typical) + FILE_OVERHEAD_MS }
      })
      .sort((a, b) => b.ms - a.ms || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    const loads = new Array<number>(count).fill(0)
    const mine: TestSpecification[] = []
    for (const file of weighed) {
      const lightest = loads.indexOf(Math.min(...loads))
      loads[lightest]! += file.ms
      if (lightest === index - 1) mine.push(file.spec)
    }
    return mine
  }
}
