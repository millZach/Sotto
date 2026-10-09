// @vitest-environment node

import { afterEach, vi } from 'vitest'
import { workspaceFixture } from './workspaceFixture'

export const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close() })
export async function fixture(options?: { worktreeRefreshDelayMs?: number }) {
  const f = await workspaceFixture(undefined, options)
  cleanup.push(async () => { await f.stop(); await f.remove() })
  return f
}
export async function local(f: Awaited<ReturnType<typeof fixture>>, id = 'local') {
  const snapshot = await f.host.connect()
  const project = snapshot.projects.find(project => project.providerId === 'codex')!
  const model = snapshot.models.find(model => model.providerId === 'codex')!
  await f.host.execute({ type: 'create-thread', commandId: `create-${id}`, threadId: id, projectId: project.id, title: 'New task', modelId: model.id })
  return { project, model }
}
export const send = (threadId = 'local') => ({ type: 'send' as const, commandId: `send-${threadId}`, threadId, messageId: `message-${threadId}`, text: 'Implement the task' })
export function deferred() {
  let release!: () => void
  return { promise: new Promise<void>(resolve => { release = resolve }), release }
}
