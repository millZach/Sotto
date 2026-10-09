// @vitest-environment node
import { EventEmitter } from 'node:events'
import { spawn } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nestedCommandEnvironment } from '../../../scripts/nested-hyprland-environment.mjs'
import { createOwnedProofProcesses } from '../../../scripts/owned-proof-processes.mjs'

vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal(),
  spawn: vi.fn(() => new EventEmitter()),
}))
// The proof runner reads the user's runtime folder and session bus; pin both so the
// test does not depend on the machine (Windows CI has no getuid or XDG_RUNTIME_DIR).
beforeEach(() => {
  vi.stubEnv('XDG_RUNTIME_DIR', '/run/user/1000')
  vi.stubEnv('DBUS_SESSION_BUS_ADDRESS', 'unix:path=/run/user/1000/bus')
})
afterEach(() => { vi.clearAllMocks(); vi.unstubAllEnvs() })

describe('nested Hyprland command isolation', () => {
  it('removes live X11 credentials through the scope runner while retaining the nested Wayland display', () => {
    vi.stubEnv('DISPLAY', ':live')
    vi.stubEnv('XAUTHORITY', '/live/xauthority')
    const parent = { DISPLAY: ':live', XAUTHORITY: '/live/xauthority', WAYLAND_DISPLAY: 'live-wayland', HYPRLAND_INSTANCE_SIGNATURE: 'live', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus' }
    const env = nestedCommandEnvironment(parent, { wl_socket: 'nested-wayland', instance: 'nested' }, 123)
    createOwnedProofProcesses(() => {}).start('probe', '/usr/bin/env', [], { env })
    const [, , options] = vi.mocked(spawn).mock.calls[0]
    expect(options.env).not.toHaveProperty('DISPLAY')
    expect(options.env).not.toHaveProperty('XAUTHORITY')
    expect(options.env).toMatchObject({ WAYLAND_DISPLAY: 'nested-wayland', HYPRLAND_INSTANCE_SIGNATURE: 'nested', SOTTO_PACKAGE_NESTED_PID: '123', DBUS_SESSION_BUS_ADDRESS: parent.DBUS_SESSION_BUS_ADDRESS })
    expect(parent.DISPLAY).toBe(':live')
    expect(parent.XAUTHORITY).toBe('/live/xauthority')
  })

  it('preserves an explicitly supplied nested X11 environment without borrowing the parent credentials', () => {
    vi.stubEnv('DISPLAY', ':live')
    vi.stubEnv('XAUTHORITY', '/live/xauthority')
    createOwnedProofProcesses(() => {}).start('probe', '/usr/bin/env', [], { env: { DISPLAY: ':nested' } })
    const [, , options] = vi.mocked(spawn).mock.calls[0]
    expect(options.env).toEqual({ DISPLAY: ':nested' })
  })
})
