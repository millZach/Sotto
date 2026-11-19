// @vitest-environment node
// Claude Code 2.1.328 offers its task tools, the thread's plan checklist, to current models only when
// CLAUDE_CODE_ENABLE_TODO_TOOLS is set, so a project thread's CLI launches with it. Watcher's does not (watcherOwnTools).
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it } from 'vitest'

import { claudeFixture } from '../fixtures/claudeFixture'

type Fixture = Awaited<ReturnType<typeof claudeFixture>>
const fixtures: Fixture[] = []
afterEach(async () => { for (const f of fixtures.splice(0)) await f.cleanup() })

it('launches a project thread with Claude Code’s task tools on', async () => {
  const f = await claudeFixture()
  fixtures.push(f)
  await f.host.connect()
  await f.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, title: 'Plan', path: f.root })
  await f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: randomUUID(), projectId: f.projectId, title: 'Plan', modelId: 'fixture-model' })
  const launch = (await f.driver.requests()).findLast(record => record.method === 'launch'
    && !(record.params?.frame as { args: string[] }).args.includes('--no-session-persistence'))
  expect((launch?.params?.frame as { planTools: unknown }).planTools).toBe('1')
})
