// @vitest-environment node
// A remote host's host program (ADR-0214): Node unless the owner picks Rust on that host's row, where the Owl feature
// `rust-remote-host` offers the choice. Every launch names the program chosen for its host, so Node clears a Rust marker.
import { describe, expect, it } from 'vitest'
import { useDesktopHostFixture } from '../fixtures/desktopHostFixture'

const fixture = useDesktopHostFixture()
const { add, launchRuntimes, relaunch, savedFile, stops } = fixture

describe('host program per remote host', () => {
  it('runs Node by default, and a switch saves Rust for that host, restarts it and launches it on Rust, and back', async () => {
    fixture.rustHostChoice = true
    await relaunch()
    const remote = await add()
    expect(fixture.manager.get().hosts[0]).toMatchObject({ phase: 'connected', runtime: 'node', runningRuntime: 'node' })
    // Node is named, not left out, so a host Owl turned to Rust before this is cleared at its next launch.
    expect(launchRuntimes).toEqual([false])

    await fixture.manager.command({ type: 'set-runtime', id: remote.id, runtime: 'rust' })
    expect(stops).toEqual([fixture.reportedHostId])
    expect(launchRuntimes.at(-1)).toBe(true)
    expect(fixture.manager.get().hosts[0]).toMatchObject({ phase: 'connected', runtime: 'rust', runningRuntime: 'rust' })
    expect(fixture.manager.get().hosts[0]!.switchingRuntime).toBeUndefined()
    expect(await savedFile()).toMatchObject([{ id: remote.id, runtime: 'rust' }])

    // The choice outlives a restart of Sotto, as it does an Owl update.
    await relaunch()
    await fixture.manager.command({ type: 'connect', id: remote.id })
    expect(launchRuntimes.at(-1)).toBe(true)
    expect(fixture.manager.get().hosts[0]).toMatchObject({ runtime: 'rust' })

    // Back to Node: one press restarts the host on Node, and the saved host carries no choice again.
    await fixture.manager.command({ type: 'set-runtime', id: remote.id, runtime: 'node' })
    expect(stops).toHaveLength(2)
    expect(launchRuntimes.at(-1)).toBe(false)
    expect(fixture.manager.get().hosts[0]).toMatchObject({ phase: 'connected', runtime: 'node', runningRuntime: 'node' })
    expect((await savedFile())[0]).not.toHaveProperty('runtime')
  })

  it('saves the choice for a host Sotto did not start without stopping it, for its next start', async () => {
    fixture.rustHostChoice = true
    fixture.owned = false
    await relaunch()
    const remote = await add()
    await fixture.manager.command({ type: 'set-runtime', id: remote.id, runtime: 'rust' })
    expect(stops).toEqual([])
    expect(fixture.manager.get().hosts[0]).toMatchObject({ phase: 'connected', runtime: 'rust', runningRuntime: 'node' })
    expect(await savedFile()).toMatchObject([{ id: remote.id, runtime: 'rust' }])
  })

  it('offers no choice and names no program where the Owl feature is off, as on stable', async () => {
    const remote = await add()
    expect(fixture.manager.get().hosts[0]!.runtime).toBeUndefined()
    expect(launchRuntimes).toEqual([undefined])
    await expect(fixture.manager.command({ type: 'set-runtime', id: remote.id, runtime: 'rust' })).rejects.toThrow('runs every remote host on Node')
    expect(stops).toEqual([])
    expect((await savedFile())[0]).not.toHaveProperty('runtime')
  })
})
