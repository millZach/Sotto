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

it('documents the shipped owning-host Watcher tools without the obsolete local-only restriction', () => {
  const guide = readFileSync(new URL('../../../docs/agent-control.md', import.meta.url), 'utf8')
  const tools = guide.split('## Watcher tools')[1]?.split('\n## ')[0]
  expect(tools).toBeDefined()
  expect(tools).toContain('watcher-control')
  expect(tools).toContain('watcher-reads')
  expect(tools).toContain('explicit owning-host and Sotto thread identities')
  expect(guide).not.toContain('Paired-host tools wait for the owning-host feature ticket')
  expect(guide).not.toContain('explicit local host and Sotto identities')
})
