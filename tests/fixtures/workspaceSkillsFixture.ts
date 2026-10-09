// @vitest-environment node
import { afterEach } from 'vitest'

import { workspaceFixture } from './workspaceFixture'

export const fixtures: Awaited<ReturnType<typeof workspaceFixture>>[] = []
afterEach(async () => { for (const f of fixtures.splice(0)) { await f.stop(); await f.remove() } })
