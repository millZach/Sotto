// @vitest-environment node
import { randomUUID } from 'node:crypto'

import { afterEach } from 'vitest'
import { AgentControl } from '../../src/main/agents/control'

import { codexFixture } from './codexFixture'

const fixtures: Awaited<ReturnType<typeof codexFixture>>[] = []
export const controls: AgentControl[] = []
afterEach(async () => { for (const c of controls.splice(0)) c.dispose(); for (const f of fixtures.splice(0)) await f.cleanup() })
export async function fixture() {
  const f = await codexFixture(undefined, true); fixtures.push(f)
  await f.host.connect()
  await f.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, title: 'Project', path: f.root })
  const threadId = randomUUID()
  await f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId, projectId: f.projectId, title: 'Skills', modelId: f.modelId })
  return { ...f, threadId }
}
export const skill = (path: string, enabled = true) => ({ name: 'native-review', description: 'Native description verbatim.', path, scope: 'repo' as const, enabled,
  interface: { displayName: 'Pretty title' }, dependencies: null, shortDescription: null })

