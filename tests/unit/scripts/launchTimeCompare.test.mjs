// @vitest-environment node
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { compareLaunches, parseLaunchResult, readSide } from '../../../scripts/launch-time-compare.mjs'

const entry = (median, min = median, max = median) => ({ median, min, max })
const before = { runs: 7, platform: 'win32', summary: { askedToFirstPaintMs: entry(1200, 1100, 1300), allMemoryMb: entry(1000) } }
const after = {
  runs: 7, platform: 'win32',
  summary: { askedToFirstPaintMs: entry(900, 850, 1000.25), allMemoryMb: entry(1000), 'mark:widget-loaded': { ...entry(700), runs: 5 } },
}

it('reads a run from the line the spec prints, among the reporter\'s own lines', () => {
  const log = `Running 1 test using 1 worker\nLAUNCH-TIME ${JSON.stringify(before, null, 1)}\n  ✓  1 times the launch (1.2m)\n  1 passed\n`
  expect(parseLaunchResult(log)).toEqual(before)
  expect(parseLaunchResult(JSON.stringify(after))).toEqual(after)
  expect(parseLaunchResult('  1 skipped\n')).toBeNull()
})

it('prefers the written result and falls back to the log of a spec from before it wrote one', () => {
  const folder = mkdtempSync(join(tmpdir(), 'sotto-launch-compare-'))
  try {
    writeFileSync(join(folder, 'before.log'), `LAUNCH-TIME ${JSON.stringify(before, null, 1)}\n`)
    writeFileSync(join(folder, 'after.json'), JSON.stringify(after))
    writeFileSync(join(folder, 'after.log'), 'LAUNCH-TIME {"runs": 1, "summary": {}}\n')
    expect(readSide(folder, 'before')).toEqual(before)
    expect(readSide(folder, 'after')).toEqual(after)
    expect(readSide(join(folder, 'missing'), 'before')).toBeNull()
  } finally {
    rmSync(folder, { recursive: true, force: true })
  }
})

it('puts each figure beside its base, with the ratio of medians, and leaves a figure one side lacks blank', () => {
  const table = compareLaunches(before, after)
  expect(table).toContain('| askedToFirstPaintMs | 1,200 (1,100 to 1,300) | 900 (850 to 1,000.3) | 0.75 |')
  expect(table).toContain('| allMemoryMb | 1,000 (1,000 to 1,000) | 1,000 (1,000 to 1,000) | 1.00 |')
  expect(table).toContain('| mark:widget-loaded | - | 700 (700 to 700), 5 runs | - |')
  expect(compareLaunches(null, after)).toContain('Base: not measured. Change: 7 launches.')
})
