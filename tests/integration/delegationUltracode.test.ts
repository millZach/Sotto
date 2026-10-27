// @vitest-environment node
// Ultracode is the user's own choice in a thread, never a delegating agent's (ADR-0148): the delegate tool neither lists
// it among a worker model's levels nor starts a worker on it.
import { afterEach, expect, it } from 'vitest'
import { delegationFixture } from '../fixtures/delegationFixture'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

it('lists a Claude model\'s levels without Ultracode and refuses a worker started on it', async () => {
  const f = await delegationFixture(cleanups)
  // The fake Claude model reports Extra high, so Claude Code's catalog would offer Ultracode after Max.
  for (const model of f.workspace.adapters.claude.state.models) model.reasoningEfforts = ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode']
  f.workspace.adapters.claude.emit()
  await f.control.commandShell({ type: 'refresh', provider: 'claude' })
  expect(f.model('claude').reasoningEfforts).toContain('ultracode')

  const parent = await f.userThread('codex')
  const listing = await f.service.read(parent, {}) as { status: string; models: { provider: string; efforts: string[] }[] }
  expect(listing.status).toBe('ok')
  expect(listing.models.find(model => model.provider === 'claude')?.efforts).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])

  expect(await f.delegate(parent, { provider: 'claude', model: f.model('claude').id, effort: 'ultracode' })).toMatchObject({ status: 'refused', code: 'INVALID_INPUT' })
  expect(f.control.shell().host.threads.some(thread => thread.delegatedBy === parent)).toBe(false)
})
