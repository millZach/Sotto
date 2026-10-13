// @vitest-environment node
import { expect, it } from 'vitest'
import { omarchySetupEnvironment } from '../../../src/main/omarchy/environment'

it('uses the same shell identity for launcher, sign-in and absolute-display bridge environments', () => {
  for (const display of ['wayland-1', '/run/user/1000/wayland-1']) {
    const original = { WAYLAND_DISPLAY: display, XDG_RUNTIME_DIR: '/run/user/1000', HYPRLAND_INSTANCE_SIGNATURE: 'session', PATH: '/usr/bin' }
    expect(omarchySetupEnvironment(original, '/private/home')).toEqual({ ...original,
      HOME: '/private/home', WAYLAND_DISPLAY: 'wayland-1', OMARCHY_PATH: '/usr/share/omarchy' })
    expect(original.WAYLAND_DISPLAY).toBe(display)
  }
})
it('preserves a custom Omarchy install and never selects another session or strips an outside socket path', () => {
  const original = { OMARCHY_PATH: '/custom/omarchy', WAYLAND_DISPLAY: '/another/runtime/wayland-2', XDG_RUNTIME_DIR: '/run/user/1000' }
  expect(omarchySetupEnvironment(original, '/private/home')).toEqual({ ...original, HOME: '/private/home' })
  expect(omarchySetupEnvironment({}, '/private/home').WAYLAND_DISPLAY).toBeUndefined()
})
