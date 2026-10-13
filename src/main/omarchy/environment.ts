import { basename, dirname, isAbsolute, resolve } from 'node:path'

/** Quickshell matches the display spelling. Wayland also accepts its absolute socket path. */
export function omarchySetupEnvironment(environment: NodeJS.ProcessEnv, home: string): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = { ...environment, HOME: home, OMARCHY_PATH: environment.OMARCHY_PATH || '/usr/share/omarchy' }
  const display = environment.WAYLAND_DISPLAY, runtime = environment.XDG_RUNTIME_DIR
  if (display && runtime && isAbsolute(display) && resolve(dirname(display)) === resolve(runtime)) {
    next.WAYLAND_DISPLAY = basename(display)
  }
  return next
}
