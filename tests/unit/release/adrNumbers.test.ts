import { readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'

it('gives every architecture decision a unique number', () => {
  const files = readdirSync(resolve('docs/adr')).filter((file) => /^\d{4}-.*\.md$/.test(file))
  const decisions = new Map<string, string[]>()
  for (const file of files) {
    const number = file.slice(0, 4)
    decisions.set(number, [...(decisions.get(number) ?? []), file])
  }
  expect([...decisions.values()].filter((files) => files.length > 1)).toEqual([])
})
