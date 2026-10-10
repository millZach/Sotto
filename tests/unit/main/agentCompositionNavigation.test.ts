// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { fixture, registerAgentControlRecoveryCleanup } from '../../fixtures/agentControlRecovery'

registerAgentControlRecoveryCleanup()

it('adopts the thread ID the window minted, refuses to create it twice, and still mints one when none is given', async () => {
    const f = await fixture()
    const threadId = randomUUID()
    const created = await f.control.command({ type: 'create-thread', projectId: 'project', title: 'Minted in the window', modelId: 'claude:test', threadId })
    expect(created).toMatchObject({ error: null, activeThreadId: threadId })
    expect(created.host.threads.filter(thread => thread.id === threadId)).toHaveLength(1)
    const duplicate = await f.control.command({ type: 'create-thread', projectId: 'project', title: 'Same ID again', modelId: 'claude:test', threadId })
    expect(duplicate.error).toBe('This thread already exists. Select it instead of creating it again.')
    expect(duplicate.host.threads.filter(thread => thread.id === threadId)).toHaveLength(1)
    const minted = await f.control.command({ type: 'create-thread', projectId: 'project', title: 'Main mints this one', modelId: 'claude:test' })
    expect(minted.error).toBeNull()
    expect(minted.activeThreadId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u)
    expect(minted.activeThreadId).not.toBe(threadId)
  })

it.each(['con.txt', 'NUL.log', 'aux.archive.tar', 'COM1.txt', 'lpt9.log', 'LPT¹', 'com³.txt', 'nul .txt', 'CON  .log'])('refuses the Windows device folder name %s before creating it', async title => {
    const f = await fixture()
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
    try {
      const execute = vi.spyOn(f.host, 'execute')
      const result = await f.control.command({ type: 'create-project', title, path: join(f.root, title) })
      expect(result.error).toBe('Choose a project name that can be used as a folder name.')
      expect(execute).not.toHaveBeenCalled()
      expect(await readdir(f.root)).not.toContain(title)
    } finally { Object.defineProperty(process, 'platform', platform) }
  })
