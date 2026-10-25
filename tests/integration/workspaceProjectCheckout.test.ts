// @vitest-environment node

import { describe, expect, it, vi } from 'vitest'

import { fixture, local } from '../fixtures/workspaceTestFixture'

describe('Keep main up to date asks the checkout guard first (ADR-0140)', () => {
  it('runs nothing in a project checkout another mutation holds, and runs once it is free', async () => {
    const f = await fixture()
    const { project } = await local(f)
    expect(f.host.mainCheckoutProjects()).toContainEqual({ id: project.id, path: project.path, settled: false })
    const work = vi.fn(async () => 'updated')
    // A Git action of the thread sharing the project folder holds the checkout.
    const release = await f.host.acquireCheckoutMutation('local')
    await expect(f.host.withProjectCheckout(project.path, work)).resolves.toBeNull()
    expect(work).not.toHaveBeenCalled()
    release()
    await expect(f.host.withProjectCheckout(project.path, work)).resolves.toBe('updated')
    // While the update runs, a thread's own Git action in that folder is refused rather than run beside it.
    await f.host.withProjectCheckout(project.path, async () => {
      await expect(f.host.acquireCheckoutMutation('local')).rejects.toThrow('Sotto is pulling this folder.')
    })
  })
})
