// @vitest-environment node
import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'

const context = readFileSync(new URL('../../../CONTEXT.md', import.meta.url), 'utf8')
const entry = (term: string): string => context.split('\n').find(line => line.startsWith('**' + term + '.** ')) ?? ''

it('defines wake-ups for both Sotto news sources', () => {
  const wake = entry('Wake-up')
  expect(wake).toMatch(/babysitting/iu)
  expect(wake).toMatch(/Watcher/u)
  expect(wake).toMatch(/Sotto/u)
})
it('defines turns independently of which Sotto source sent their wake-up', () => {
  expect(entry('Turn')).toMatch(/wake-up[^.]*Sotto/u)
  expect(entry('Turn')).not.toMatch(/wake-up sent by babysitting/u)
})
it('describes the coordinator as sending both sources of wake-up', () => {
  expect(entry('Coordinator')).toMatch(/babysitting/iu)
  expect(entry('Coordinator')).toMatch(/Watcher/u)
})
