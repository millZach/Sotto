// @vitest-environment node
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { expect, it } from 'vitest'

it.each(['docs/host-protocol.md', 'docs/plans/2026-10-08-command-center.md'])('%s links to existing architecture decisions', file => {
  const links = [...readFileSync(file, 'utf8').matchAll(/\]\(([^)\s]*adr\/[^)\s]+\.md)(?:#[^)]+)?\)/gu)].map(match => match[1]!)
  expect(links.length).toBeGreaterThan(0)
  expect(links.filter(link => !existsSync(resolve(dirname(file), link)))).toEqual([])
})
