// @vitest-environment node
/*
 * A working turn's line shows the same Spaceballs words on the desktop and the iPhone. The iPhone keeps its own copy
 * (WorkingWords in apps/ios/Sources/SottoCore/StepRuns.swift), so this reads both sources and fails when they differ.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const read = (path: string): string => readFileSync(fileURLToPath(new URL(`../../../${path}`, import.meta.url)), 'utf8')

/** The quoted words between `start` and the closing bracket of the list it opens. */
function words(source: string, start: string, quote: string): string[] {
  const from = source.indexOf(start)
  expect(from, start).toBeGreaterThanOrEqual(0)
  const list = source.slice(from, source.indexOf(']', from))
  return [...list.matchAll(new RegExp(`${quote}([^${quote}]+)${quote}`, 'gu'))].map(match => match[1]!)
}

describe('the working words', () => {
  it('are the same words in the same order on the desktop and the iPhone', () => {
    const desktop = words(read('src/renderer/src/agents/ThreadActivity.tsx'), 'const WORKING_WORDS = [', "'")
    const phone = words(read('apps/ios/Sources/SottoCore/StepRuns.swift'), 'public static let all = [', '"')
    expect(desktop[0]).toBe('Combing the desert')
    expect(desktop.length).toBeGreaterThan(10)
    expect(phone).toEqual(desktop)
  })
})
